/**
 * AgentX — ReAct Agent Loop
 *
 * Implements the Reason-Act-Observe cycle:
 * 1. Send messages to LLM
 * 2. Stream response to terminal
 * 3. Parse for <tool_call> blocks
 * 4. If tool calls found: execute tools, append results, loop back to 1
 * 5. If no tool calls: done — response is final answer
 *
 * Safety:
 * - Enforces max iterations to prevent infinite loops
 * - Detects repeated failures (loop detection)
 * - Graceful degradation when stuck
 */

import { LLMProvider } from '../providers/base.js';
import { ToolRegistry } from '../tools/registry.js';
import { Conversation } from './conversation.js';
import { Terminal } from '../cli/terminal.js';
import { parseToolCalls, hasToolCalls, extractReasoning, formatToolResult } from './xml-parser.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getMemory, formatMemoryContext, type MemoryRouter } from '../memory/index.js';

export interface ReactLoopOptions {
    maxIterations: number;
    model: string;
    temperature?: number;
    maxTokens?: number;
    workingDir: string;
}

/** Tracks tool execution history for loop detection */
interface ToolExecution {
    name: string;
    params: Record<string, string>;
    status: string;
    errorSignature?: string;
}

/** Loop detection thresholds */
const LOOP_DETECTION = {
    MAX_CONSECUTIVE_FAILURES: 3,    // Same tool failing 3 times = loop
    MAX_SIMILAR_ERRORS: 3,          // Same error 3 times = loop
    ERROR_SIGNATURE_LENGTH: 100,    // How much of error to compare
};

export class ReactLoop {
    private provider: LLMProvider;
    private tools: ToolRegistry;
    private conversation: Conversation;
    private terminal: Terminal;
    private executionHistory: ToolExecution[] = [];
    private memory: MemoryRouter | null = null;
    private sessionId: string;

    constructor(
        provider: LLMProvider,
        tools: ToolRegistry,
        conversation: Conversation,
        terminal: Terminal,
    ) {
        this.provider = provider;
        this.tools = tools;
        this.conversation = conversation;
        this.terminal = terminal;
        this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
        
        // Initialize memory asynchronously
        this.initMemory();
    }

    /**
     * Initialize memory system
     */
    private async initMemory(): Promise<void> {
        try {
            this.memory = await getMemory();
        } catch (error) {
            // Memory is non-critical
        }
    }

    /**
     * Initialize the system prompt with tool definitions.
     */
    initialize(workingDir: string, extraContext?: string): void {
        const systemPrompt = buildSystemPrompt(this.tools, workingDir, extraContext);
        this.conversation.setSystemPrompt(systemPrompt);
    }

    /**
     * Track a tool execution for loop detection.
     */
    private trackExecution(name: string, params: Record<string, string>, status: string, output: string): void {
        const errorSignature = status === 'error'
            ? output.substring(0, LOOP_DETECTION.ERROR_SIGNATURE_LENGTH).toLowerCase()
            : undefined;

        this.executionHistory.push({ name, params, status, errorSignature });

        // Keep only recent history (last 10 executions)
        if (this.executionHistory.length > 10) {
            this.executionHistory.shift();
        }
    }

    /**
     * Detect if we're stuck in a loop (same tool failing repeatedly).
     */
    private detectLoop(): { isLoop: boolean; reason?: string } {
        const recent = this.executionHistory.slice(-LOOP_DETECTION.MAX_CONSECUTIVE_FAILURES);

        if (recent.length < LOOP_DETECTION.MAX_CONSECUTIVE_FAILURES) {
            return { isLoop: false };
        }

        // Check 1: Same tool failing consecutively
        const allSameTool = recent.every(e => e.name === recent[0].name);
        const allFailed = recent.every(e => e.status === 'error');

        if (allSameTool && allFailed) {
            return {
                isLoop: true,
                reason: `Tool "${recent[0].name}" has failed ${recent.length} times consecutively`,
            };
        }

        // Check 2: Same error signature repeating
        const errorSignatures = recent
            .filter(e => e.errorSignature)
            .map(e => e.errorSignature);

        if (errorSignatures.length >= LOOP_DETECTION.MAX_SIMILAR_ERRORS) {
            const allSameError = errorSignatures.every(s => s === errorSignatures[0]);
            if (allSameError) {
                return {
                    isLoop: true,
                    reason: `Same error repeating ${errorSignatures.length} times`,
                };
            }
        }

        return { isLoop: false };
    }

    /**
     * Generate a hint message to help the LLM break out of a loop.
     */
    private getLoopBreakHint(reason: string): string {
        return `

⚠️ LOOP DETECTED: ${reason}

You are stuck in a retry loop. STOP trying the same approach.
Instead, do ONE of these:
1. Acknowledge the failure and explain what's missing (dependencies, files, configuration)
2. Try a COMPLETELY different approach
3. Ask the user for guidance

Do NOT retry the same command again.`;
    }

    /**
     * Run the full ReAct cycle for a user message.
     * Returns the final assistant response.
     */
    async run(userMessage: string, opts: ReactLoopOptions): Promise<string> {
        const startTime = Date.now();
        
        // Memory recall: find relevant past context
        let memoryContext = '';
        if (this.memory) {
            try {
                const memories = await this.memory.getTaskContext(userMessage, 3);
                if (memories.length > 0) {
                    memoryContext = formatMemoryContext(memories);
                    this.terminal.showInfo(`💭 Found ${memories.length} relevant memories`);
                }
            } catch (e) {
                // Memory recall is non-critical
            }
        }

        // Add user message (with memory context if available)
        const enhancedMessage = memoryContext 
            ? `${userMessage}\n\n[Context from previous sessions:\n${memoryContext}]`
            : userMessage;
        this.conversation.addUser(enhancedMessage);

        let iteration = 0;
        let finalResponse = '';
        let toolsUsed: string[] = [];
        let filesChanged: string[] = [];

        while (iteration < opts.maxIterations) {
            iteration++;

            // Step 1: Call LLM
            const stream = this.provider.chat(this.conversation.getMessages(), {
                model: opts.model,
                temperature: opts.temperature ?? 0.7,
                maxTokens: opts.maxTokens ?? 4096,
            });

            // Step 2: Stream response to terminal
            const response = await this.terminal.streamResponse(stream);

            if (!response || response.trim().length === 0) {
                this.terminal.showWarning('Empty response from LLM');
                break;
            }

            // Step 3: Parse for tool calls
            if (!hasToolCalls(response)) {
                // No tool calls — this is the final response
                this.conversation.addAssistant(response);
                finalResponse = response;
                break;
            }

            // Step 4: Extract tool calls and reasoning
            const toolCalls = parseToolCalls(response);
            const reasoning = extractReasoning(response);

            // Store the full response (reasoning + tool calls) in history
            this.conversation.addAssistant(response);

            // Step 5: Execute each tool call
            for (const call of toolCalls) {
                this.terminal.showToolCall(call.name, call.params);

                const result = await this.tools.execute(call.name, call.params);

                // Track for loop detection
                this.trackExecution(call.name, call.params, result.status, result.output);
                
                // Track tools and files for memory
                toolsUsed.push(call.name);
                if ((call.name === 'write_file' || call.name === 'edit_file') && call.params.path) {
                    filesChanged.push(call.params.path);
                }

                this.terminal.showToolResult(call.name, result.status, result.output);

                // Format and add tool result to conversation
                const resultXml = formatToolResult(call.name, result.output, result.status);
                this.conversation.addToolResult(call.name, resultXml, result.status);
            }

            // Step 6: Check for loop (after tool execution)
            const loopCheck = this.detectLoop();
            if (loopCheck.isLoop) {
                this.terminal.showWarning(`Loop detected: ${loopCheck.reason}`);

                // Inject a hint to help the LLM break out
                const hint = this.getLoopBreakHint(loopCheck.reason!);
                this.conversation.addUser(hint);

                // Force a lower iteration cap when looping
                if (iteration >= Math.min(opts.maxIterations, 5)) {
                    this.terminal.showWarning('Stopping due to detected loop. Please provide different instructions.');
                    finalResponse = `I got stuck in a loop: ${loopCheck.reason}. Please try a different approach or provide more specific instructions.`;
                    break;
                }
            }

            // Check if we're approaching the iteration limit
            if (iteration === opts.maxIterations - 1) {
                this.terminal.showWarning(
                    `Approaching iteration limit (${opts.maxIterations}). Wrapping up...`
                );
            }
        }

        // Safety: if we hit max iterations
        if (iteration >= opts.maxIterations) {
            this.terminal.showWarning(`Reached maximum iterations (${opts.maxIterations}). Stopping.`);
            finalResponse = finalResponse || '(Reached iteration limit)';
        }

        // Memory storage: remember this interaction
        if (this.memory) {
            try {
                const duration = Date.now() - startTime;
                const success = iteration < opts.maxIterations && finalResponse !== '(Reached iteration limit)';
                
                // Store task memory
                await this.memory.rememberTask(
                    `task-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                    userMessage,
                    success ? 'completed' : 'failed',
                    {
                        filesChanged: filesChanged,
                        duration: duration,
                        outcome: finalResponse.slice(0, 200),
                    }
                );

                // Store conversation memory
                await this.memory.rememberConversation(
                    this.sessionId,
                    'user',
                    userMessage,
                    undefined
                );
                await this.memory.rememberConversation(
                    this.sessionId,
                    'assistant',
                    finalResponse.slice(0, 500),
                    userMessage
                );
            } catch (e) {
                // Memory storage is non-critical
            }
        }

        return finalResponse;
    }

    /**
     * Update the provider (for hot-switching).
     */
    setProvider(provider: LLMProvider): void {
        this.provider = provider;
    }

    /**
     * Clear execution history (call when starting a new task).
     */
    resetHistory(): void {
        this.executionHistory = [];
    }
}
