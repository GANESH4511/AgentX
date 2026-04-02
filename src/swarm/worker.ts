/**
 * AgentX — Swarm Worker (Child Process)
 * 
 * This file runs inside each spawned child agent process.
 * It reads AgentMessage JSON from stdin, executes tasks using
 * its own ReAct loop, and writes AgentResponse JSON to stdout.
 * 
 * The worker is headless (no Terminal UI) — all output goes
 * through the structured JSON protocol.
 * 
 * Lifecycle:
 *   1. Process starts, loads config, initializes provider
 *   2. Emits "ready" on stdout
 *   3. Waits for "task" messages on stdin
 *   4. Runs ReAct loop for each task, emits "result" or "error"
 *   5. On "shutdown", exits cleanly
 */

import { loadConfig } from '../config/loader.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ToolRegistry } from '../tools/registry.js';
import { Conversation } from '../agent/conversation.js';
import { ReactLoop } from '../agent/react-loop.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { createReadFileTool } from '../tools/read-file.js';
import { createWriteFileTool } from '../tools/write-file.js';
import { createEditFileTool } from '../tools/edit-file.js';
import { createRunCommandTool } from '../tools/run-command.js';
import { createSearchFilesTool } from '../tools/search-files.js';
import { createListDirTool } from '../tools/list-dir.js';
import type { AgentMessage, AgentResponse } from './spawner.js';

// ─── Globals ────────────────────────────────────────────────────

const agentId = process.env.AGENTX_SWARM_AGENT_ID ?? 'unknown';
let currentTaskId: string | null = null; // Track current task for cleanup

// ─── Headless Terminal (captures output without TTY) ────────────

/**
 * Minimal Terminal stub that captures streamed output instead
 * of rendering to a TTY. The parent process never sees this —
 * only the final result travels via JSON IPC.
 */
class HeadlessTerminal {
    showBanner() { /* no-op */ }
    showStatus() { /* no-op */ }
    showInfo(_msg: string) { sendProgress(_msg); }
    showSuccess(_msg: string) { sendProgress(_msg); }
    showWarning(msg: string) { sendProgress(`⚠ ${msg}`); }
    showError(msg: string) { sendProgress(`✗ ${msg}`); }

    showToolCall(toolName: string, params: Record<string, string>) {
        const short = Object.entries(params)
            .map(([k, v]) => `${k}=${v.length > 40 ? v.slice(0, 40) + '...' : v}`)
            .join(', ');
        sendProgress(`🔧 ${toolName}(${short})`);
    }

    showToolResult(toolName: string, status: string, preview: string) {
        const icon = status === 'success' ? '✓' : '✗';
        sendProgress(`${icon} ${toolName}: ${preview.slice(0, 80)}`);
    }

    async streamResponse(stream: AsyncGenerator<any>): Promise<string> {
        let content = '';
        try {
            for await (const chunk of stream) {
                if (chunk.content) content += chunk.content;
            }
        } catch (err: any) {
            // Don't crash on stream errors - return what we have
            sendProgress(`Stream error: ${err.message || 'unknown'}`);
        }
        return content;
    }

    prompt(): Promise<string> { return Promise.resolve(''); }
    processSlashCommand(_input: string): Promise<boolean> { return Promise.resolve(false); }
    getActiveModel(): string { return ''; }
    setActiveModel(_model: string) { /* no-op */ }
    close() { /* no-op */ }
}

// ─── IPC Helpers ────────────────────────────────────────────────

function send(msg: AgentResponse): void {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendProgress(text: string): void {
    send({ type: 'progress', progress: text });
}

// ─── Role-Specific System Prompts ───────────────────────────────

const ROLE_PROMPTS: Record<string, string> = {
    coder: `You are a CODING agent. Your PRIMARY job is to CREATE FILES using the write_file tool.

CRITICAL RULES:
1. When asked to create a file, you MUST use write_file — not just describe what to write
2. Always include COMPLETE, WORKING code in your file content
3. Verify your file was created by checking the tool result
4. Do NOT say "I would create..." — actually CREATE it
5. If a file path is specified, use that EXACT path

Focus on:
- Clean, readable code with proper error handling
- Following existing patterns in the codebase
- Writing only the code that was asked for
- Using write_file for new files, edit_file for existing files`,

    tester: `You are a TESTING agent. Your job is to CREATE TEST FILES using write_file.

CRITICAL RULES:
1. You MUST create actual test files, not just describe tests
2. Use write_file with the specified test file path
3. Include complete, runnable test code
4. Verify the test file was created

Focus on:
- Unit tests for the code or feature described
- Edge cases, error paths, and boundary conditions
- Using the project's existing test framework
- Mocking external dependencies properly`,

    reviewer: `You are a CODE REVIEW agent. Your job is to review code for quality.
Focus on:
- Bugs, logic errors, and potential crashes
- Security issues (injection, auth bypass, data leaks)
- Performance concerns (N+1 queries, unnecessary allocations)
- Style consistency with the rest of the codebase
Provide specific, actionable feedback.`,

    researcher: `You are a RESEARCH agent. Your job is to explore the codebase and gather context.
Focus on:
- Reading relevant files to understand architecture
- Finding patterns, conventions, and dependencies
- Summarizing your findings clearly
- Do NOT modify any files — read only`,
};

// ─── Worker Main ────────────────────────────────────────────────

async function main() {
    // 1. Load config
    const config = loadConfig();
    const registry = new ProviderRegistry();

    for (const [name, pConfig] of Object.entries(config.providers)) {
        registry.register(name, {
            type: pConfig.type,
            baseUrl: pConfig.baseUrl,
            apiKey: pConfig.apiKey,
            defaultModel: pConfig.defaultModel,
            models: pConfig.models ? {
                tier1Fast: pConfig.models.tier1Fast,
                tier2Default: pConfig.models.tier2Default,
                tier3Complex: pConfig.models.tier3Complex,
            } : undefined,
        });
    }

    registry.setActive(config.activeProvider);

    // 2. Signal ready
    send({ type: 'ready' });

    // 3. Listen for messages on stdin
    let buffer = '';

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
        buffer += chunk;

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;

            try {
                const msg = JSON.parse(line) as AgentMessage;
                handleMessage(msg, config, registry).catch(err => {
                    send({
                        type: 'error',
                        taskId: msg.taskId,
                        error: `Worker error: ${err.message || String(err)}`,
                    });
                });
            } catch {
                // Ignore unparseable input
            }
        }
    });

    process.stdin.on('end', () => {
        process.exit(0);
    });
}

async function handleMessage(
    msg: AgentMessage,
    config: ReturnType<typeof loadConfig>,
    registry: ProviderRegistry,
): Promise<void> {
    switch (msg.type) {
        case 'ping':
            send({ type: 'pong' });
            break;

        case 'shutdown':
            send({ type: 'pong' });
            process.exit(0);

        case 'task':
            await executeTask(msg, config, registry);
            break;
    }
}

async function executeTask(
    msg: AgentMessage,
    config: ReturnType<typeof loadConfig>,
    registry: ProviderRegistry,
): Promise<void> {
    const taskId = msg.taskId ?? 'unknown';
    currentTaskId = taskId; // Track for cleanup on exit
    const workingDir = msg.workingDir ?? process.cwd();

    try {
        // Select provider/model
        if (msg.provider && registry.has(msg.provider)) {
            registry.setActive(msg.provider);
        }

        const provider = registry.getActive();
        const tier = (msg.tier ?? 2) as 1 | 2 | 3;
        const model = msg.model ?? provider.getModelForTier(tier);

        sendProgress(`Using model: ${model}`);

        // Set up tools
        const tools = new ToolRegistry();
        tools.register(createReadFileTool(workingDir));
        tools.register(createWriteFileTool(workingDir));
        tools.register(createEditFileTool(workingDir));
        tools.register(createRunCommandTool(workingDir));
        tools.register(createSearchFilesTool(workingDir));
        tools.register(createListDirTool(workingDir));

        // Set up conversation
        const conversation = new Conversation(config.agent.maxHistoryTokens);

        // Build role-specific system prompt
        const roleName = msg.role ?? 'coder';
        const rolePrompt = ROLE_PROMPTS[roleName] ?? '';
        const extraContext = [
            rolePrompt,
            msg.systemPromptExtra ?? '',
            msg.context ? `## Task Context\n${msg.context}` : '',
        ].filter(Boolean).join('\n\n');

        const systemPrompt = buildSystemPrompt(tools, workingDir, extraContext);
        conversation.setSystemPrompt(systemPrompt);

        // Create headless terminal
        const terminal = new HeadlessTerminal();

        // Create ReAct loop
        const reactLoop = new ReactLoop(
            provider,
            tools,
            conversation,
            terminal as any, // HeadlessTerminal implements the same interface
        );

        // Run the task
        sendProgress(`Starting task: ${msg.prompt?.slice(0, 80)}...`);

        const result = await reactLoop.run(msg.prompt ?? '', {
            maxIterations: msg.maxIterations ?? config.agent.maxIterations,
            model,
            temperature: 0.7,
            maxTokens: 4096,
            workingDir,
        });

        currentTaskId = null; // Clear before sending result
        send({
            type: 'result',
            taskId,
            output: result || 'Task completed',
        });

    } catch (error: any) {
        const errorMsg = error?.message || String(error) || 'Unknown error';
        sendProgress(`Task error: ${errorMsg}`);
        currentTaskId = null; // Clear before sending error
        send({
            type: 'error',
            taskId,
            error: errorMsg,
        });
    }
}

// ─── Start ──────────────────────────────────────────────────────

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
    if (currentTaskId) {
        send({ type: 'error', taskId: currentTaskId, error: `Uncaught exception: ${err.message}` });
        currentTaskId = null;
    }
    // Don't exit - try to continue
});

process.on('unhandledRejection', (reason: any) => {
    if (currentTaskId) {
        send({ type: 'error', taskId: currentTaskId, error: `Unhandled rejection: ${reason?.message || String(reason)}` });
        currentTaskId = null;
    }
    // Don't exit - try to continue
});

// Send error if process exits with pending task
process.on('beforeExit', () => {
    if (currentTaskId) {
        send({ type: 'error', taskId: currentTaskId, error: 'Worker exiting with pending task' });
        currentTaskId = null;
    }
});

process.on('exit', () => {
    if (currentTaskId) {
        // Synchronous write since we're exiting
        process.stdout.write(JSON.stringify({ type: 'error', taskId: currentTaskId, error: 'Worker exit' }) + '\n');
    }
});

// Only run main if this is executed as a child process (not imported)
if (process.env.AGENTX_SWARM_MODE === '1') {
    main().catch(err => {
        if (currentTaskId) {
            send({ type: 'error', taskId: currentTaskId, error: `Worker fatal: ${err.message}` });
        }
        process.exit(1);
    });
}
