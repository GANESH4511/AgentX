/**
 * AgentX — Terminal UI
 * 
 * Beautiful terminal interface with:
 * - Streaming LLM responses with real-time display
 * - Provider/model status display
 * - Slash command processing
 * - Color-coded output
 */

import * as readline from 'node:readline';
import chalk from 'chalk';
import { LLMProvider, StreamChunk } from '../providers/base.js';
import { ProviderRegistry } from '../providers/registry.js';
import { Conversation } from '../agent/conversation.js';
import { SwarmCoordinator } from '../swarm/coordinator.js';
import { RuFloBridge } from '../swarm/ruflo-bridge.js';
import { getChangeTracker, formatChange, type FileChange } from '../tools/change-tracker.js';
import { interruptCurrentCommand } from '../tools/run-command.js';
import type { MCPToolBridge } from '../mcp/tool-bridge.js';
import { getTaskMemoryManager, TASK_MEMORY_CONFIG, type TaskRecord } from '../swarm/task-memory-manager.js';
import { getMemory, formatMemoryContext, type MemoryRouter } from '../memory/index.js';
import { createTaskDecomposer, type TaskDecomposer, type Subtask } from '../swarm/task-decomposer.js';

// ─── Theme Colors ───────────────────────────────────────────────
const theme = {
    brand: chalk.hex('#7C3AED'),       // Purple - brand color
    brandBold: chalk.hex('#7C3AED').bold,
    user: chalk.hex('#3B82F6').bold,    // Blue - user input
    assistant: chalk.hex('#10B981'),    // Green - assistant text
    tool: chalk.hex('#F59E0B'),        // Amber - tool calls
    error: chalk.hex('#EF4444').bold,  // Red - errors
    dim: chalk.dim,                     // Dimmed text
    info: chalk.hex('#6366F1'),        // Indigo - info
    success: chalk.hex('#22C55E'),     // Green - success
    warning: chalk.hex('#EAB308'),     // Yellow - warning
    header: chalk.hex('#7C3AED').bold.underline,
};

export class Terminal {
    private rl: readline.Interface;
    private registry: ProviderRegistry;
    private conversation: Conversation;
    private mcpBridge?: MCPToolBridge;
    private activeModel: string = '';
    private isStreaming = false;
    private streamAborted = false;
    private swarmCoordinator?: SwarmCoordinator;
    private ruFloBridge?: RuFloBridge;
    private swarmBackend: 'ruflo' | 'agentx' | 'hybrid' = 'ruflo';
    private isInterruptible = false;
    private interruptRequested = false;
    private interruptResolver?: () => void;
    private lastInterruptTime = 0;
    private hasShownNoTaskMessage = false;
    private memory?: MemoryRouter;
    private sessionId: string;

    private memoryInitPromise?: Promise<void>;

    constructor(registry: ProviderRegistry, conversation: Conversation, mcpBridge?: MCPToolBridge) {
        this.registry = registry;
        this.conversation = conversation;
        this.mcpBridge = mcpBridge;
        this.sessionId = `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: true,
        });

        // Initialize memory system (store promise for later await)
        this.memoryInitPromise = this.initMemory();

        // Set up Ctrl+X interrupt handler
        this.setupInterruptHandler();
    }

    /**
     * Initialize the memory system
     */
    private async initMemory(): Promise<void> {
        try {
            this.memory = await getMemory();
        } catch (error) {
            console.error('Warning: Memory system failed to initialize:', error);
        }
    }

    /**
     * Set up keyboard interrupt handler for Ctrl+X.
     */
    private setupInterruptHandler(): void {
        // Enable keypress events for readline
        readline.emitKeypressEvents(process.stdin);

        if (process.stdin.isTTY) {
            // Set up keypress listener (works when readline is paused)
            process.stdin.on('keypress', (_chunk: string, key: any) => {
                if (!key) return;
                
                if (key.ctrl && key.name === 'x') {
                    this.handleInterrupt();
                } else if (key.ctrl && key.name === 't') {
                    this.handleStatusRequest();
                }
            });
            
            // Try to enable raw mode during swarm execution
            // This is done dynamically in enableInterruptMode()
        }

        // Handle Ctrl+C (SIGINT) - this always works
        process.on('SIGINT', () => {
            if (this.isInterruptible) {
                this.handleInterrupt();
            } else {
                // Show help or exit based on context
                console.log(theme.warning('\n  Use Ctrl+C again to exit, or wait for task to complete.\n'));
            }
        });
    }

    /**
     * Enable raw mode for interrupt capture during swarm execution.
     */
    private enableInterruptMode(): void {
        if (process.stdin.isTTY && !process.stdin.isRaw) {
            try {
                this.rl.pause(); // Pause readline to take over stdin
                process.stdin.setRawMode(true);
                process.stdin.resume();
            } catch {
                // May fail in some environments
            }
        }
    }

    /**
     * Disable raw mode and restore readline.
     */
    private disableInterruptMode(): void {
        if (process.stdin.isTTY && process.stdin.isRaw) {
            try {
                process.stdin.setRawMode(false);
                this.rl.resume();
            } catch {
                // May fail in some environments
            }
        }
    }

    /**
     * Handle interrupt request (Ctrl+X or Ctrl+C during task).
     */
    private async handleInterrupt(): Promise<void> {
        // Debounce - prevent multiple rapid interrupts
        const now = Date.now();
        if (now - this.lastInterruptTime < 500) {
            return; // Ignore rapid keypresses
        }
        this.lastInterruptTime = now;

        // Always try to interrupt any running command first
        const commandInterrupted = interruptCurrentCommand();
        if (commandInterrupted) {
            console.log(theme.warning('\n  ⛔ Command interrupted!'));
            return;
        }

        // Abort streaming if active
        if (this.isStreaming) {
            this.streamAborted = true;
            return;
        }

        if (!this.isInterruptible) {
            // Only show "no task" message once until a new task starts
            if (!this.hasShownNoTaskMessage) {
                this.showWarning('No interruptible task running.');
                this.hasShownNoTaskMessage = true;
            }
            return;
        }

        // Prevent re-entry
        if (this.interruptRequested) {
            return;
        }

        this.interruptRequested = true;
        this.isInterruptible = false;
        this.disableInterruptMode(); // Restore readline mode
        
        console.log(theme.warning('\n  ⛔ Interrupt requested! Stopping swarm...'));

        // Shutdown RuFlo bridge workers first (real workers)
        if (this.ruFloBridge) {
            try {
                await this.ruFloBridge.shutdown();
                this.ruFloBridge = undefined;
                console.log(theme.success('  ✓ RuFlo workers stopped.'));
            } catch (error: any) {
                console.log(theme.error(`  ✗ Error stopping RuFlo workers: ${error.message}`));
            }
        }

        // Then shutdown built-in swarm coordinator
        if (this.swarmCoordinator) {
            try {
                await this.swarmCoordinator.shutdown(false); // Force shutdown
                this.swarmCoordinator = undefined;
                console.log(theme.success('  ✓ Swarm coordinator stopped.'));
            } catch (error: any) {
                console.log(theme.error(`  ✗ Error stopping swarm: ${error.message}`));
            }
        }

        console.log(theme.success('  ✓ All workers interrupted and shut down.\n'));

        // Signal the waiting promise to resolve
        if (this.interruptResolver) {
            this.interruptResolver();
            this.interruptResolver = undefined;
        }

        this.interruptRequested = false;
    }

    /**
     * Handle status request (Ctrl+T during task).
     * Uses TaskMemoryManager for intelligent filtering of active vs stale tasks.
     */
    private async handleStatusRequest(): Promise<void> {
        console.log('');
        console.log(theme.header('  📊 Live Swarm Status'));
        console.log('');

        // Initialize TaskMemoryManager for intelligent filtering
        const taskMemory = getTaskMemoryManager('.claude-flow');

        // First show AgentX worker status (the real workers)
        if (this.ruFloBridge) {
            const bridgeStatus = this.ruFloBridge.getStatus();
            console.log(theme.success('  ⚡ AgentX Workers Active'));
            console.log(theme.dim(`  Active Workers: ${bridgeStatus.activeWorkers}`));
            console.log(theme.dim(`  Completed: ${bridgeStatus.completedWorkers}`));
            console.log(theme.dim(`  Failed: ${bridgeStatus.failedWorkers}`));
            
            if (bridgeStatus.workers.length > 0) {
                console.log('');
                for (const worker of bridgeStatus.workers) {
                    const statusIcon = worker.status === 'running' ? '🔄' :
                                     worker.status === 'completed' ? '✅' :
                                     worker.status === 'failed' ? '❌' : '⏳';
                    console.log(`  ${statusIcon} ${worker.role} [${worker.agentXId}]`);
                    if (worker.progress) {
                        console.log(theme.dim(`    ${worker.progress.slice(0, 60)}...`));
                    }
                }
            }
            console.log('');
        }

        // Check for RuFlo swarm status first
        const hasRuFloSwarm = this.mcpBridge?.hasToolsFromServer('ruflo');

        if (hasRuFloSwarm) {
            try {
                // Get RuFlo swarm status
                const swarmStatusResult = await this.mcpBridge!.callTool('ruflo', 'swarm_status', {});

                if (!swarmStatusResult.isError) {
                    const swarmInfo = JSON.parse(swarmStatusResult.content);
                    console.log(theme.success('  🌊 RuFlo Swarm Active'));
                    console.log(theme.dim(`  Swarm ID: ${swarmInfo.swarmId}`));
                    console.log(theme.dim(`  Topology: ${swarmInfo.config?.topology || 'hierarchical'}`));
                    console.log(theme.dim(`  Max Agents: ${swarmInfo.config?.maxAgents || 5}`));
                    // Use AgentX worker count if available, fall back to RuFlo count
                    const workerCount = this.ruFloBridge?.getStatus().activeWorkers ?? swarmInfo.agentCount;
                    console.log(theme.dim(`  Agent Count: ${workerCount}`));
                    console.log(theme.dim(`  Task Count: ${swarmInfo.taskCount}`));
                    console.log('');
                }

                // Get active tasks using TaskMemoryManager for intelligent filtering
                const activeTasks = taskMemory.getActiveTasks();
                const stats = taskMemory.getStats();

                console.log(theme.info('  📋 Active Tasks:'));
                if (stats.stale > 0) {
                    console.log(theme.warning(`  ⚠ ${stats.stale} stale task(s) hidden (use /swarm cleanup to archive)`));
                }
                console.log('');

                if (activeTasks.length === 0) {
                    console.log(theme.dim('  No active tasks'));
                } else {
                    for (const task of activeTasks) {
                        const statusIcon = task.status === 'running' ? '🔄' :
                                         task.status === 'in_progress' ? '🔄' : '⏳';
                        const shortDesc = task.description.length > 50
                            ? task.description.substring(0, 50) + '...'
                            : task.description;

                        console.log(`  ${statusIcon} ${theme.info(task.taskId)} [${task.status}]`);
                        console.log(theme.dim(`    ${shortDesc}`));
                        // Handle assignedTo being string, array, or undefined
                        const assignedTo = task.assignedTo;
                        if (assignedTo) {
                            const assignedStr = Array.isArray(assignedTo) 
                                ? assignedTo.join(', ')
                                : String(assignedTo);
                            if (assignedStr && assignedStr !== '[]') {
                                console.log(theme.dim(`    Assigned to: ${assignedStr}`));
                            }
                        }
                        console.log('');
                    }
                }

                // Show summary stats
                console.log(theme.dim(`  Summary: ${stats.active} active | ${stats.completed} completed | ${stats.failed} failed | ${stats.totalHistory} archived`));
                console.log('');

            } catch (error: any) {
                const errorMsg = error?.message || String(error) || 'Unknown error';
                console.log(theme.error('  ⚠️ RuFlo Swarm Status Error'));
                console.log(theme.dim(`  ${errorMsg}`));
                // Show helpful hint based on error type
                if (errorMsg.includes('not connected') || errorMsg.includes('ECONNREFUSED')) {
                    console.log(theme.warning('  💡 Hint: RuFlo MCP server may not be running. Try: npx @claude-flow/cli@latest daemon start'));
                } else if (errorMsg.includes('timeout')) {
                    console.log(theme.warning('  💡 Hint: MCP connection timed out. Check if claude-flow daemon is responsive.'));
                } else if (errorMsg.includes('swarm_status')) {
                    console.log(theme.warning('  💡 Hint: No active swarm. Initialize with: /swarm init'));
                }
                console.log('');
            }
        }

        // Also show built-in swarm status if available
        if (this.swarmCoordinator) {
            const status = this.swarmCoordinator.getStatus();

            console.log(theme.success('  ⚡ Built-in AgentX Swarm Active'));
            console.log('');

            // Queue status
            const q = status.queue;
            console.log(theme.info(`  Queue: ${q.running} running • ${q.pending} pending • ${q.completed} done • ${q.failed} failed`));

            // Agent status
            if (status.agents.length > 0) {
                console.log('');
                console.log(theme.dim('  Agents:'));
                for (const a of status.agents) {
                    const icon = a.status === 'busy' ? '🔄' : a.status === 'idle' ? '💤' : '💀';
                    const roleColor = a.role === 'coder' ? theme.info : a.role === 'tester' ? theme.warning : theme.dim;
                    const taskInfo = a.currentTask ? theme.dim(` → ${a.currentTask}`) : '';
                    console.log(`  ${icon} ${roleColor(a.agentId)} [${a.role}]${taskInfo}`);
                }
            }
            console.log('');
        }

        // If no swarms are running
        if (!hasRuFloSwarm && !this.swarmCoordinator) {
            console.log(theme.dim('  ⚠ No swarm is currently running.'));
            console.log('');
        }

        console.log(theme.dim(`  Press Ctrl+X to interrupt • Ctrl+T for status`));
        console.log('');
    }

    /**
     * Wait for interrupt - returns a promise that resolves when interrupted.
     */
    waitForInterrupt(): Promise<void> {
        return new Promise((resolve) => {
            this.interruptResolver = resolve;
        });
    }

    /**
     * Check if interrupt was requested.
     */
    isInterrupted(): boolean {
        return this.interruptRequested;
    }

    /**
     * Display the welcome banner.
     */
    showBanner(): void {
        const provider = this.registry.getActive();
        this.activeModel = provider.getDefaultModel();

        console.log('');
        console.log(theme.brand('  ╔════════════════════════════════════════════╗'));
        console.log(theme.brand('  ║') + theme.brandBold('         ⚡ AgentX v0.1.0 ⚡              ') + theme.brand('║'));
        console.log(theme.brand('  ║') + theme.dim('   Terminal AI Agent • Any LLM • Any Task  ') + theme.brand('║'));
        console.log(theme.brand('  ╚════════════════════════════════════════════╝'));
        console.log('');
        this.showStatus();
        console.log(theme.dim('  Type /help for commands • Ctrl+X to interrupt • Ctrl+T for status • /exit to quit'));
        console.log(theme.dim('  ─────────────────────────────────────────────'));
        console.log('');
    }

    /**
     * Display current provider/model status.
     */
    showStatus(): void {
        const providerName = this.registry.getActiveName();
        const modelShort = this.activeModel.split('/').pop() || this.activeModel;

        console.log(
            theme.dim('  Provider: ') + theme.info(providerName) +
            theme.dim(' │ Model: ') + theme.info(modelShort)
        );
    }

    /**
     * Show the input prompt and wait for user input.
     */
    prompt(): Promise<string> {
        return new Promise((resolve) => {
            this.rl.question(theme.user('\n  You ► '), (answer) => {
                resolve(answer.trim());
            });
        });
    }

    /**
     * Stream an LLM response to the terminal.
     * Returns the full accumulated response text.
     */
    async streamResponse(stream: AsyncGenerator<StreamChunk>): Promise<string> {
        this.isStreaming = true;
        this.streamAborted = false;
        let fullContent = '';
        let isFirstChunk = true;

        process.stdout.write(theme.assistant('\n  AgentX ► '));

        try {
            for await (const chunk of stream) {
                // Check if interrupted
                if (this.streamAborted) {
                    console.log(theme.warning('\n  ⛔ Response interrupted by user.'));
                    break;
                }
                
                if (chunk.content) {
                    if (isFirstChunk) {
                        isFirstChunk = false;
                    }
                    process.stdout.write(theme.assistant(chunk.content));
                    fullContent += chunk.content;
                }

                if (chunk.done && chunk.usage) {
                    console.log('');
                    console.log(
                        theme.dim(`  [${chunk.usage.promptTokens}+${chunk.usage.completionTokens}=${chunk.usage.totalTokens} tokens]`)
                    );
                }
            }
        } catch (error: any) {
            console.log('');
            if (!this.streamAborted) {
                this.showError(`Stream error: ${error.message}`);
            }
        }

        if (!fullContent.endsWith('\n')) {
            console.log('');
        }

        this.isStreaming = false;
        return fullContent;
    }

    /**
     * Display a non-streaming message from the assistant.
     */
    showAssistant(message: string): void {
        console.log(theme.assistant(`\n  AgentX ► ${message}`));
    }

    /**
     * Display a tool call being executed.
     */
    showToolCall(toolName: string, params: Record<string, string>): void {
        // Special handling for file operations to make them more readable
        if (toolName === 'write_file' && params.path) {
            const content = params.content || '';
            const lines = content.split('\n').length;
            const size = Math.round(content.length / 1024 * 10) / 10;
            console.log(theme.tool(`  📝 ${params.path} (${lines} lines, ${size}KB)`));
        } else if (toolName === 'edit_file' && params.path) {
            console.log(theme.tool(`  ✏️  ${params.path}`));
        } else if (toolName === 'read_file' && params.path) {
            console.log(theme.tool(`  📖 ${params.path}`));
        } else {
            // Default compact display
            const paramStr = Object.entries(params)
                .map(([k, v]) => {
                    const display = v.length > 40 ? v.substring(0, 40) + '...' : v;
                    return `${k}=${display}`;
                })
                .join(', ');
            console.log(theme.tool(`  🔧 ${toolName}(${paramStr})`));
        }
    }

    /**
     * Display a tool result.
     */
    showToolResult(toolName: string, status: string, preview: string): void {
        const icon = status === 'success' ? '✅' : '❌';
        const color = status === 'success' ? theme.success : theme.error;

        // Special handling for file operations
        if (toolName === 'write_file' && status === 'success') {
            // Extract useful info from preview (Created/Updated, path, size info)
            const cleanPreview = preview.replace(/^(Created|Updated)\s+/, '').replace(/C:\\SNIX\\sify\\prompts\\agentx\\/, '');
            console.log(color(`  ${icon} ${cleanPreview}`));
        } else {
            const previewShort = preview.length > 80 ? preview.substring(0, 80) + '...' : preview;
            console.log(color(`  ${icon} ${toolName}: ${previewShort}`));
        }
    }

    /**
     * Display an error.
     */
    showError(message: string): void {
        console.log(theme.error(`  ✗ Error: ${message}`));
    }

    /**
     * Display an info message.
     */
    showInfo(message: string): void {
        console.log(theme.info(`  ℹ ${message}`));
    }

    /**
     * Display a success message.
     */
    showSuccess(message: string): void {
        console.log(theme.success(`  ✓ ${message}`));
    }

    /**
     * Display a warning.
     */
    showWarning(message: string): void {
        console.log(theme.warning(`  ⚠ ${message}`));
    }

    /**
     * Process a slash command. Returns true if it was a command.
     */
    async processSlashCommand(input: string): Promise<boolean> {
        if (!input.startsWith('/')) return false;

        const parts = input.slice(1).split(/\s+/);
        const command = parts[0]?.toLowerCase();
        const args = parts.slice(1);

        switch (command) {
            case 'help':
                this.showHelp();
                break;

            case 'exit':
            case 'quit':
                console.log(theme.dim('\n  Goodbye! 👋\n'));
                process.exit(0);

            case 'clear':
                this.conversation.clear();
                this.showSuccess('Conversation cleared');
                break;

            case 'provider':
            case 'p':
                if (args.length === 0) {
                    this.showProviders();
                } else {
                    try {
                        this.registry.setActive(args[0]);
                        const provider = this.registry.getActive();
                        this.activeModel = provider.getDefaultModel();
                        this.showSuccess(`Switched to provider: ${args[0]}`);
                        this.showStatus();
                    } catch (error: any) {
                        this.showError(error.message);
                    }
                }
                break;

            case 'model':
            case 'm':
                if (args.length === 0) {
                    await this.showModels();
                } else {
                    this.activeModel = args[0];
                    this.showSuccess(`Switched to model: ${args[0]}`);
                }
                break;

            case 'tier':
            case 't':
                if (args.length === 0) {
                    this.showInfo('Usage: /tier <1|2|3>');
                } else {
                    const tier = parseInt(args[0]) as 1 | 2 | 3;
                    if (![1, 2, 3].includes(tier)) {
                        this.showError('Tier must be 1, 2, or 3');
                    } else {
                        const provider = this.registry.getActive();
                        this.activeModel = provider.getModelForTier(tier);
                        const modelShort = this.activeModel.split('/').pop();
                        this.showSuccess(`Switched to tier ${tier}: ${modelShort}`);
                    }
                }
                break;

            case 'providers':
                this.showProviders();
                break;

            case 'models':
                await this.showModels();
                break;

            case 'status':
                this.showStatus();
                const stats = this.conversation.getStats();
                console.log(
                    theme.dim('  Messages: ') + theme.info(String(stats.messageCount)) +
                    theme.dim(' │ Tokens: ~') + theme.info(String(stats.estimatedTokens)) +
                    theme.dim(' │ Turns: ') + theme.info(String(stats.turns))
                );
                break;

            case 'history':
                const histStats = this.conversation.getStats();
                console.log(theme.info('  Conversation Stats:'));
                console.log(theme.dim(`  Messages: ${histStats.messageCount}`));
                console.log(theme.dim(`  Estimated tokens: ${histStats.estimatedTokens}`));
                console.log(theme.dim(`  Turns: ${histStats.turns}`));
                break;

            case 'swarm':
            case 'sw':
                await this.handleSwarmCommand(args);
                break;

            case 'undo':
            case 'u':
                await this.handleUndoCommand(args);
                break;

            default:
                this.showWarning(`Unknown command: /${command}. Type /help for available commands.`);
                break;
        }

        return true;
    }

    /**
     * Display help text.
     */
    private showHelp(): void {
        console.log('');
        console.log(theme.header('  AgentX Commands'));
        console.log('');
        console.log(theme.dim('  Chat:'));
        console.log(`  ${theme.info('/clear')}             Clear conversation history`);
        console.log(`  ${theme.info('/history')}           Show conversation stats`);
        console.log(`  ${theme.info('/status')}            Show current status`);
        console.log('');
        console.log(theme.dim('  Providers:'));
        console.log(`  ${theme.info('/provider <name>')}   Switch active provider`);
        console.log(`  ${theme.info('/providers')}         List all configured providers`);
        console.log(`  ${theme.info('/model <name>')}      Switch active model`);
        console.log(`  ${theme.info('/models')}            List available models`);
        console.log(`  ${theme.info('/tier <1|2|3>')}      Switch to tier model`);
        console.log('');
        console.log(theme.dim('  Swarm (RuFlo + Built-in):'));
        console.log(`  ${theme.info('/swarm <task>')}      🌊 Execute task with RuFlo swarm (live monitoring)`);
        console.log(`  ${theme.info('/swarm status')}     📊 Show RuFlo swarm status and active tasks`);
        console.log(`  ${theme.info('/swarm cleanup')}    🧹 Archive stale/completed tasks`);
        console.log(`  ${theme.info('/swarm kill')}       🛑 Shut down RuFlo swarm (graceful)`);
        console.log(`  ${theme.info('Ctrl+X')}             Interrupt running swarm`);
        console.log(`  ${theme.info('Ctrl+T')}             Show live swarm status during execution`);
        console.log('');
        console.log(theme.dim('  Note: Falls back to built-in swarm if RuFlo unavailable'));
        console.log('');
        console.log(theme.dim('  Undo Changes:'));
        console.log(`  ${theme.info('/undo')}              Undo last file change`);
        console.log(`  ${theme.info('/undo list')}         Show recent changes`);
        console.log(`  ${theme.info('/undo all')}          Undo all changes in session`);
        console.log(`  ${theme.info('/undo <N>')}          Undo last N changes`);
        console.log('');
        console.log(theme.dim('  System:'));
        console.log(`  ${theme.info('/help')}              Show this help`);
        console.log(`  ${theme.info('/exit')}              Exit AgentX`);
        console.log('');
    }

    /**
     * Display all configured providers.
     */
    private showProviders(): void {
        console.log('');
        console.log(theme.header('  Configured Providers'));
        console.log('');
        for (const { name, provider, isActive } of this.registry.listAll()) {
            const marker = isActive ? theme.success('● ') : theme.dim('○ ');
            const modelShort = provider.getDefaultModel().split('/').pop();
            console.log(`  ${marker}${theme.info(name)} → ${theme.dim(modelShort || '')}`);
        }
        console.log('');
    }

    /**
     * List available models from the active provider.
     */
    private async showModels(): Promise<void> {
        const provider = this.registry.getActive();
        console.log(theme.dim(`\n  Fetching models from ${this.registry.getActiveName()}...`));

        try {
            const models = await provider.listModels();
            if (models.length === 0) {
                this.showWarning('No models returned from provider');
                return;
            }

            console.log('');
            console.log(theme.header(`  Models (${this.registry.getActiveName()})`));
            console.log('');
            for (const model of models) {
                const isActive = model.id === this.activeModel;
                const marker = isActive ? theme.success('● ') : theme.dim('○ ');
                const tokens = model.maxTokens ? theme.dim(` (${(model.maxTokens / 1000).toFixed(0)}K)`) : '';
                const type = model.type !== 'llm' ? theme.warning(` [${model.type}]`) : '';
                console.log(`  ${marker}${theme.info(model.id)}${tokens}${type}`);
            }
            console.log('');
        } catch (error: any) {
            this.showError(`Failed to list models: ${error.message}`);
        }
    }

    /**
     * Handle /undo commands.
     */
    private async handleUndoCommand(args: string[]): Promise<void> {
        const subcommand = args[0]?.toLowerCase();
        const tracker = getChangeTracker({ workingDir: process.cwd() });

        if (subcommand === 'list') {
            const changes = tracker.listChanges(10);
            console.log('');
            console.log(theme.header('  Recent Changes'));
            console.log('');
            
            if (changes.length === 0) {
                console.log(theme.dim('  No changes tracked in this session.'));
            } else {
                for (let i = 0; i < changes.length; i++) {
                    const change = changes[i];
                    console.log(`  ${theme.dim(`${i + 1}.`)} ${formatChange(change)}`);
                    if (change.agentId) {
                        console.log(theme.dim(`     Agent: ${change.agentId}`));
                    }
                }
            }
            console.log('');
            return;
        }

        if (subcommand === 'all') {
            const results = tracker.undoAll();
            console.log('');
            console.log(theme.header('  Undoing All Changes'));
            console.log('');
            
            if (results.length === 0) {
                console.log(theme.dim('  No changes to undo.'));
            } else {
                for (const result of results) {
                    if (result.success) {
                        const verb = result.change.operation === 'create' ? 'Deleted' : 'Restored';
                        console.log(theme.success(`  ✓ ${verb}: ${result.change.path}`));
                    } else {
                        console.log(theme.error(`  ✗ Failed: ${result.change.path} — ${result.error}`));
                    }
                }
                console.log('');
                console.log(theme.info(`  ${results.length} changes undone.`));
            }
            console.log('');
            return;
        }

        if (subcommand === 'clear') {
            tracker.clear();
            this.showSuccess('Change history cleared.');
            return;
        }

        // Check if it's a number (undo N changes)
        const count = parseInt(subcommand || '1', 10);
        
        if (!isNaN(count) && count > 0) {
            const results = tracker.undoN(count);
            console.log('');
            
            if (results.length === 0) {
                console.log(theme.dim('  No changes to undo.'));
            } else {
                for (const result of results) {
                    if (result.success) {
                        const verb = result.change.operation === 'create' ? 'Deleted' : 'Restored';
                        console.log(theme.success(`  ✓ ${verb}: ${result.change.path}`));
                    } else {
                        console.log(theme.error(`  ✗ Failed: ${result.change.path} — ${result.error}`));
                    }
                }
            }
            console.log('');
            return;
        }

        // No args or unrecognized - show help
        console.log('');
        console.log(theme.header('  Undo Changes'));
        console.log('');
        console.log(`  ${theme.info('/undo')}        Undo last file change`);
        console.log(`  ${theme.info('/undo list')}   Show recent changes (last 10)`);
        console.log(`  ${theme.info('/undo all')}    Undo all changes in session`);
        console.log(`  ${theme.info('/undo <N>')}    Undo last N changes`);
        console.log(`  ${theme.info('/undo clear')}  Clear history without undoing`);
        console.log('');
        
        const changeCount = tracker.getChangeCount();
        console.log(theme.dim(`  ${changeCount} tracked change${changeCount === 1 ? '' : 's'} in session.`));
        console.log('');
    }

    /**
     * Handle /swarm commands.
     */
    private async handleSwarmCommand(args: string[]): Promise<void> {
        const subcommand = args[0]?.toLowerCase();

        if (!subcommand || subcommand === 'help') {
            this.showInfo('Usage: /swarm <task description>');
            this.showInfo('  /swarm status   — Show RuFlo/AgentX swarm status & active tasks');
            this.showInfo('  /swarm cleanup  — Archive stale/completed tasks (cleans up display)');
            this.showInfo('  /swarm clear    — Cancel all pending RuFlo tasks');
            this.showInfo('  /swarm kill     — Shutdown swarm & all agents');
            this.showInfo('  /swarm backend  — Show/set orchestration backend (ruflo|agentx|hybrid)');
            return;
        }

        // Handle backend switching
        if (subcommand === 'backend') {
            const newBackend = args[1]?.toLowerCase() as 'ruflo' | 'agentx' | 'hybrid' | undefined;
            
            if (!newBackend) {
                console.log('');
                console.log(theme.header('  Swarm Backend'));
                console.log('');
                console.log(theme.info(`  Current backend: ${theme.brandBold(this.swarmBackend)}`));
                console.log('');
                console.log(theme.dim('  Available backends:'));
                console.log(theme.dim('    ruflo   — RuFlo orchestration + AgentX execution (default)'));
                console.log(theme.dim('    agentx  — Pure AgentX SwarmCoordinator'));
                console.log(theme.dim('    hybrid  — RuFlo state tracking + AgentX workers'));
                console.log('');
                console.log(theme.dim('  Usage: /swarm backend <ruflo|agentx|hybrid>'));
                console.log('');
                return;
            }

            if (!['ruflo', 'agentx', 'hybrid'].includes(newBackend)) {
                this.showError(`Invalid backend: ${newBackend}`);
                this.showInfo('Valid options: ruflo, agentx, hybrid');
                return;
            }

            this.swarmBackend = newBackend;
            this.showSuccess(`Swarm backend set to: ${newBackend}`);
            
            // Clean up existing coordinators when switching
            if (this.swarmCoordinator) {
                await this.swarmCoordinator.shutdown();
                this.swarmCoordinator = undefined;
            }
            if (this.ruFloBridge) {
                await this.ruFloBridge.shutdown();
                this.ruFloBridge = undefined;
            }
            return;
        }

        if (subcommand === 'status') {
            // Handle RuFlo swarm status if available
            const hasRuFloSwarm = this.mcpBridge?.hasToolsFromServer('ruflo');

            if (hasRuFloSwarm) {
                await this.handleRuFloStatus();
                return;
            }

            // Fall back to built-in swarm status
            if (!this.swarmCoordinator) {
                this.showWarning('No swarm is currently active.');
                return;
            }
            const status = this.swarmCoordinator.getStatus();
            console.log('');
            console.log(theme.header('  Swarm Status'));
            console.log('');
            console.log(theme.dim(`  Running: ${status.isRunning ? 'yes' : 'no'}`));
            console.log(theme.dim(`  Queue: ${status.queue.pending} pending, ${status.queue.running} running, ${status.queue.completed} done, ${status.queue.failed} failed`));
            if (status.agents.length > 0) {
                console.log('');
                for (const a of status.agents) {
                    const icon = a.status === 'busy' ? '🔄' : a.status === 'idle' ? '💤' : '💀';
                    console.log(theme.info(`  ${icon} ${a.agentId} [${a.role}] — ${a.status}${a.currentTask ? ` (task: ${a.currentTask})` : ''}`));
                }
            } else {
                console.log(theme.dim('  No agents spawned.'));
            }
            console.log('');
            return;
        }

        if (subcommand === 'clear') {
            // Handle RuFlo task clearing if available
            const hasRuFloSwarm = this.mcpBridge?.hasToolsFromServer('ruflo');

            if (hasRuFloSwarm) {
                await this.handleRuFloClear();
                return;
            }

            // Fall back to built-in swarm clearing
            if (this.swarmCoordinator) {
                this.showInfo('Clearing built-in swarm queue...');
                // Note: SwarmCoordinator doesn't have a clear method yet
                this.showWarning('Built-in swarm clearing not implemented yet.');
            } else {
                this.showWarning('No swarm is currently active.');
            }
            return;
        }

        if (subcommand === 'kill') {
            // Handle RuFlo swarm shutdown if available
            const hasRuFloSwarm = this.mcpBridge?.hasToolsFromServer('ruflo');

            if (hasRuFloSwarm) {
                await this.handleRuFloShutdown();
                return;
            }

            // Fall back to built-in swarm shutdown
            if (this.swarmCoordinator) {
                this.showInfo('Shutting down swarm agents...');
                await this.swarmCoordinator.shutdown();
                this.swarmCoordinator = undefined;
                this.showSuccess('All swarm agents terminated.');
            } else {
                this.showWarning('No swarm is currently active.');
            }
            return;
        }

        // Handle cleanup command - archive stale/completed tasks
        if (subcommand === 'cleanup') {
            console.log('');
            console.log(theme.header('  🧹 Task Cleanup'));
            console.log('');
            
            try {
                const taskMemory = getTaskMemoryManager('.claude-flow');
                
                // Show before stats
                const beforeStats = taskMemory.getStats();
                console.log(theme.dim('  Before cleanup:'));
                console.log(theme.dim(`    Active: ${beforeStats.active} | Stale: ${beforeStats.stale} | History: ${beforeStats.totalHistory}`));
                console.log('');
                
                // Force cleanup (immediate archival)
                this.showInfo('Archiving stale and completed tasks...');
                const result = await taskMemory.forceCleanup();
                
                // Show results
                const afterStats = taskMemory.getStats();
                console.log('');
                console.log(theme.success('  ✅ Cleanup complete:'));
                console.log(theme.dim(`    Stale marked: ${result.staleMarked}`));
                console.log(theme.dim(`    Archived: ${result.archived}`));
                console.log(theme.dim(`    History pruned: ${result.historyPruned}`));
                console.log('');
                console.log(theme.dim('  After cleanup:'));
                console.log(theme.dim(`    Active: ${afterStats.active} | Stale: ${afterStats.stale} | History: ${afterStats.totalHistory}`));
                
                if (result.errors.length > 0) {
                    console.log('');
                    console.log(theme.warning('  ⚠ Errors:'));
                    for (const err of result.errors) {
                        console.log(theme.error(`    ${err}`));
                    }
                }
                console.log('');
            } catch (error: any) {
                this.showError(`Cleanup failed: ${error.message || error}`);
            }
            return;
        }

        // Everything else is the task description
        const taskDescription = args.join(' ');

        // Use backend setting to determine execution path
        const hasRuFloSwarm = this.mcpBridge?.hasToolsFromServer('ruflo');

        switch (this.swarmBackend) {
            case 'agentx':
                // Pure AgentX SwarmCoordinator
                await this.handleBuiltInSwarm(taskDescription);
                break;

            case 'hybrid':
            case 'ruflo':
            default:
                // RuFlo orchestration with AgentX execution
                if (hasRuFloSwarm) {
                    await this.handleRuFloSwarm(taskDescription);
                } else {
                    this.showWarning('RuFlo not available, using AgentX backend...');
                    await this.handleBuiltInSwarm(taskDescription);
                }
                break;
        }
    }

    /**
     * Handle swarm execution using RuFlo MCP tools with AgentX worker execution.
     */
    private async handleRuFloSwarm(taskDescription: string): Promise<void> {
        this.showInfo(`🌊 Using RuFlo + AgentX for: ${taskDescription}`);
        this.showInfo(`Press Ctrl+X to interrupt`);

        // Ensure memory is initialized before recall
        if (this.memoryInitPromise) {
            await this.memoryInitPromise;
        }

        // Recall relevant context from memory
        let memoryContext = '';
        if (this.memory) {
            try {
                const relevantMemories = await this.memory.getTaskContext(taskDescription, 3);
                if (relevantMemories.length > 0) {
                    console.log(theme.info('  💭 Found relevant context from previous sessions:'));
                    for (const mem of relevantMemories) {
                        const task = mem.entry.content;
                        const desc = task.description || 'Unknown task';
                        console.log(theme.dim(`    • ${desc.slice(0, 60)}${desc.length > 60 ? '...' : ''} [${task.status || 'unknown'}]`));
                    }
                    console.log('');
                    memoryContext = relevantMemories.map(m => 
                        `Previous: ${m.entry.content.description} (${m.entry.content.status})`
                    ).join('\n');
                }
            } catch (memError) {
                // Memory recall is non-critical - but log for debugging
                console.log(theme.dim(`  ℹ Memory recall unavailable`));
            }
        } else {
            console.log(theme.dim(`  ℹ Memory system not initialized`));
        }

        try {
            if (!this.mcpBridge) {
                this.showError('MCP bridge not available');
                await this.handleBuiltInSwarm(taskDescription);
                return;
            }

            // Initialize swarm via RuFlo
            this.showInfo('Initializing RuFlo swarm...');
            const initResult = await this.mcpBridge.callTool('ruflo', 'swarm_init', {
                topology: 'hierarchical',
                maxAgents: '5',
                strategy: 'specialized',
            });

            if (initResult.isError) {
                this.showError(`Swarm init failed: ${initResult.content}`);
                this.showInfo('Falling back to AgentX swarm...');
                await this.handleBuiltInSwarm(taskDescription);
                return;
            }

            console.log(theme.dim(`  ${initResult.content}`));

            // Create task via RuFlo
            this.showInfo('Creating swarm task...');
            const createResult = await this.mcpBridge.callTool('ruflo', 'task_create', {
                type: 'implementation',
                description: taskDescription,
            });

            if (createResult.isError) {
                this.showError(`Task creation failed: ${createResult.content}`);
                this.showInfo('Falling back to AgentX swarm...');
                await this.handleBuiltInSwarm(taskDescription);
                return;
            }

            const taskInfo = JSON.parse(createResult.content);
            const taskId = taskInfo.taskId;

            console.log('');
            console.log(theme.success('  ✓ RuFlo swarm task created'));
            console.log(theme.dim(`  Task ID: ${taskId}`));
            console.log('');

            // Dynamic task decomposition
            this.showInfo('Analyzing task complexity...');
            const provider = this.registry.getActive();
            const decomposer = createTaskDecomposer(provider, 15);
            
            let subtasks: Subtask[];
            try {
                const decomposition = await decomposer.decompose(taskDescription);
                subtasks = decomposition.subtasks;
                console.log(theme.dim(`  Complexity: ${decomposition.complexity}`));
                console.log(theme.dim(`  Subtasks: ${subtasks.length}`));
                console.log(theme.dim(`  Est. duration: ${decomposition.estimatedDuration}`));
                console.log('');
            } catch (decompError) {
                // Fallback to quick check
                const quick = decomposer.quickComplexityCheck(taskDescription);
                subtasks = [
                    { id: 'main', description: taskDescription, agentType: 'coder', priority: 10, dependencies: [] },
                ];
                if (quick.complexity !== 'simple') {
                    subtasks.push({ id: 'test', description: `Test: ${taskDescription}`, agentType: 'tester', priority: 8, dependencies: ['main'] });
                }
            }

            // Spawn agents based on decomposition
            this.showInfo(`Spawning ${subtasks.length} specialized agents...`);
            const ruFloAgents: Array<{ agentId: string; role: string; status: string; subtask?: Subtask }> = [];

            for (const subtask of subtasks) {
                try {
                    const result = await this.mcpBridge.callTool('ruflo', 'agent_spawn', {
                        agentType: subtask.agentType,
                        task: subtask.description,
                        model: subtask.priority >= 8 ? 'sonnet' : 'haiku',
                    });

                    if (!result.isError) {
                        const info = JSON.parse(result.content);
                        const agentId = info.agentId || info.id;
                        if (agentId) {
                            ruFloAgents.push({ 
                                agentId, 
                                role: subtask.agentType, 
                                status: 'spawned',
                                subtask 
                            });
                            console.log(theme.success(`  ✓ ${subtask.agentType} agent spawned: ${agentId}`));
                        }
                    }
                } catch (spawnError) {
                    ruFloAgents.push({ 
                        agentId: `${subtask.agentType}-${Date.now()}`, 
                        role: subtask.agentType, 
                        status: 'pending',
                        subtask 
                    });
                }
            }

            if (ruFloAgents.length === 0) {
                this.showError('No agents could be configured');
                this.showInfo('Falling back to AgentX swarm...');
                await this.handleBuiltInSwarm(taskDescription);
                return;
            }

            console.log(theme.info(`  📋 ${ruFloAgents.length} agents ready for task execution`));

            // Assign task via RuFlo (for state tracking)
            this.showInfo('Assigning task to agents...');
            try {
                const assignResult = await this.mcpBridge.callTool('ruflo', 'task_assign', {
                    taskId: taskId,
                    agentIds: JSON.stringify(ruFloAgents.map(a => a.agentId)),
                });
                if (!assignResult.isError) {
                    console.log(theme.dim(`  ${assignResult.content}`));
                }
            } catch (assignError) {
                // Not critical - continue anyway
            }

            // ═══════════════════════════════════════════════════════════
            // THIS IS THE KEY FIX: Use RuFloBridge to ACTUALLY execute
            // ═══════════════════════════════════════════════════════════
            this.showInfo('🚀 Starting AgentX worker execution...');
            console.log(theme.dim('  Press Ctrl+C to interrupt workers at any time.\n'));

            // Enable interrupt handling for RuFlo swarm
            this.isInterruptible = true;
            this.hasShownNoTaskMessage = false;
            this.enableInterruptMode(); // Enable raw mode for Ctrl+X/Ctrl+C capture

            // Initialize the bridge if not already done
            if (!this.ruFloBridge) {
                this.ruFloBridge = new RuFloBridge({
                    workingDir: process.cwd(),
                    maxAgents: 5,
                    // No timeout - let tasks run to completion
                }, this.mcpBridge);

                // Wire up events
                this.ruFloBridge.on('agent:spawned', (ruFloId: string, agentXId: string, role: string) => {
                    console.log(theme.info(`  🔧 Worker ${role} started: ${agentXId}`));
                });

                this.ruFloBridge.on('task:progress', (taskId: string, agentId: string, progress: string) => {
                    console.log(theme.dim(`  [${agentId}] ${progress}`));
                });

                this.ruFloBridge.on('task:result', (taskId: string, agentId: string, output: string) => {
                    console.log(theme.success(`  ✓ ${agentId} completed`));
                });

                this.ruFloBridge.on('task:error', (taskId: string, agentId: string, error: string) => {
                    console.log(theme.error(`  ✗ ${agentId} failed: ${error}`));
                });
            }

            // Execute the task with real workers
            const result = await this.ruFloBridge.executeTask(
                taskDescription,
                ruFloAgents,
                taskId,
            );

            // Disable interrupt mode after execution
            this.isInterruptible = false;
            this.disableInterruptMode();

            // Show results
            console.log('');
            if (result.success) {
                this.showSuccess('✅ RuFlo + AgentX task completed!');
                console.log(theme.dim(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`));
                console.log(theme.dim(`  Workers completed: ${result.results.size}`));

                if (result.results.size > 0) {
                    console.log('');
                    console.log(theme.header('  📋 Results:'));
                    for (const [agentId, output] of result.results) {
                        console.log('');
                        console.log(theme.info(`  ${agentId}:`));
                        console.log(theme.dim(`  ${output.slice(0, 500)}${output.length > 500 ? '...' : ''}`));
                    }
                }
            } else {
                this.showError('❌ Task had errors');
                if (result.errors.size > 0) {
                    for (const [agentId, error] of result.errors) {
                        console.log(theme.error(`  ${agentId}: ${error}`));
                    }
                }
            }
            console.log('');

            // Update RuFlo task status
            try {
                await this.mcpBridge.callTool('ruflo', 'task_update', {
                    taskId: taskId,
                    status: result.success ? 'completed' : 'failed',
                });
            } catch (updateError) {
                // Not critical
            }

            // Store task in memory for cross-session recall
            if (this.memory) {
                try {
                    const filesChanged: string[] = [];
                    // Extract file paths from results
                    for (const output of result.results.values()) {
                        const fileMatches = output.match(/(?:created|modified|wrote|updated).*?([\/\\][\w\-\.\/\\]+\.\w+)/gi);
                        if (fileMatches) {
                            filesChanged.push(...fileMatches.map(m => m.split(/\s+/).pop() || ''));
                        }
                    }
                    
                    await this.memory.rememberTask(
                        taskId,
                        taskDescription,
                        result.success ? 'completed' : 'failed',
                        {
                            filesChanged,
                            duration: result.durationMs,
                            outcome: result.success ? 'Task completed successfully' : 'Task had errors',
                            error: result.success ? undefined : Array.from(result.errors.values()).join('; '),
                        }
                    );
                } catch (memoryError) {
                    // Memory storage is non-critical
                }
            }

        } catch (error: any) {
            // Ensure interrupt mode is disabled on error
            this.isInterruptible = false;
            this.disableInterruptMode();
            
            this.showError(`RuFlo swarm error: ${error.message}`);
            this.showInfo('Falling back to AgentX swarm...');
            await this.handleBuiltInSwarm(taskDescription);
        }
    }

    /**
     * Handle RuFlo swarm status checking.
     */
    private async handleRuFloStatus(): Promise<void> {
        console.log('');
        console.log(theme.header('  📊 Swarm Status'));
        console.log('');

        // First, show AgentX worker status (real workers)
        if (this.ruFloBridge) {
            const bridgeStatus = this.ruFloBridge.getStatus();
            
            console.log(theme.brandBold('  AgentX Workers:'));
            console.log(theme.dim(`    Active: ${bridgeStatus.activeWorkers}`));
            console.log(theme.dim(`    Completed: ${bridgeStatus.completedWorkers}`));
            console.log(theme.dim(`    Failed: ${bridgeStatus.failedWorkers}`));
            
            if (bridgeStatus.workers.length > 0) {
                console.log('');
                for (const w of bridgeStatus.workers) {
                    const icon = w.status === 'running' ? '🔄' : 
                                 w.status === 'completed' ? '✅' :
                                 w.status === 'failed' ? '❌' : '⏳';
                    console.log(theme.info(`    ${icon} ${w.agentXId} [${w.role}] — ${w.status}`));
                    if (w.progress) {
                        console.log(theme.dim(`       ${w.progress.slice(0, 60)}...`));
                    }
                }
            }
            console.log('');
        }

        // Then show RuFlo orchestration status
        try {
            if (!this.mcpBridge) {
                this.showWarning('MCP bridge not available');
                return;
            }

            console.log(theme.brandBold('  RuFlo Orchestration:'));

            // Get swarm status
            const swarmStatusResult = await this.mcpBridge.callTool('ruflo', 'swarm_status', {});

            if (!swarmStatusResult.isError) {
                try {
                    const swarmData = JSON.parse(swarmStatusResult.content);
                    console.log(theme.dim(`    Swarm ID: ${swarmData.swarmId || 'N/A'}`));
                    console.log(theme.dim(`    Topology: ${swarmData.topology || 'N/A'}`));
                    console.log(theme.dim(`    Max Agents: ${swarmData.maxAgents || 'N/A'}`));
                } catch {
                    console.log(theme.dim(`    ${swarmStatusResult.content}`));
                }
            } else {
                console.log(theme.dim(`    Status unavailable`));
            }

            // Get task list
            console.log('');
            console.log(theme.brandBold('  📋 Tasks:'));
            const taskListResult = await this.mcpBridge.callTool('ruflo', 'task_list', {});

            if (!taskListResult.isError) {
                try {
                    const taskData = JSON.parse(taskListResult.content);
                    const tasks = taskData.tasks || [];
                    if (tasks.length === 0) {
                        console.log(theme.dim('    No active tasks'));
                    } else {
                        for (const task of tasks.slice(0, 5)) {
                            const icon = task.status === 'completed' ? '✅' :
                                         task.status === 'failed' ? '❌' :
                                         task.status === 'in_progress' ? '🔄' : '⏳';
                            console.log(theme.info(`    ${icon} ${task.taskId}`));
                            if (task.description) {
                                console.log(theme.dim(`       ${task.description.slice(0, 50)}...`));
                            }
                        }
                    }
                } catch {
                    console.log(theme.dim(`    ${taskListResult.content}`));
                }
            }
            console.log('');

        } catch (error: any) {
            console.log(theme.dim(`    Error: ${error.message}`));
            console.log('');
        }
    }

    /**
     * Handle RuFlo swarm shutdown.
     */
    private async handleRuFloShutdown(): Promise<void> {
        this.showInfo('🛑 Shutting down RuFlo swarm...');

        try {
            if (!this.mcpBridge) return;

            const shutdownResult = await this.mcpBridge.callTool('ruflo', 'swarm_shutdown', {});

            if (shutdownResult.isError) {
                this.showError(`RuFlo shutdown failed: ${shutdownResult.content}`);
            } else {
                this.showSuccess('✅ RuFlo swarm shut down successfully');
                console.log(theme.dim(`  ${shutdownResult.content}`));
            }

        } catch (error: any) {
            this.showError(`RuFlo shutdown error: ${error.message}`);
        }
    }

    /**
     * Handle RuFlo task queue clearing.
     */
    private async handleRuFloClear(): Promise<void> {
        this.showInfo('🧹 Clearing pending RuFlo tasks...');

        try {
            if (!this.mcpBridge) return;

            // Get current task list first
            const taskListResult = await this.mcpBridge.callTool('ruflo', 'task_list', {});

            if (taskListResult.isError) {
                this.showError(`Failed to get task list: ${taskListResult.content}`);
                return;
            }

            const taskData = JSON.parse(taskListResult.content);
            const pendingTasks = taskData.tasks?.filter((task: any) => task.status === 'pending') || [];

            if (pendingTasks.length === 0) {
                this.showInfo('No pending tasks to clear');
                return;
            }

            this.showInfo(`Found ${pendingTasks.length} pending tasks to cancel...`);

            let cancelledCount = 0;
            for (const task of pendingTasks) {
                try {
                    const cancelResult = await this.mcpBridge.callTool('ruflo', 'task_cancel', {
                        taskId: task.taskId,
                    });

                    if (!cancelResult.isError) {
                        console.log(theme.dim(`  ✓ Cancelled: ${task.description.substring(0, 50)}...`));
                        cancelledCount++;
                    } else {
                        console.log(theme.warning(`  ⚠ Failed to cancel: ${task.taskId}`));
                    }
                } catch (cancelError) {
                    console.log(theme.warning(`  ⚠ Error cancelling: ${task.taskId}`));
                }
            }

            if (cancelledCount > 0) {
                this.showSuccess(`✅ Cancelled ${cancelledCount} pending tasks`);
            } else {
                this.showWarning('Failed to cancel any tasks');
            }

        } catch (error: any) {
            this.showError(`RuFlo clear error: ${error.message}`);
        }
    }

    /**
     * Handle swarm execution using built-in AgentX swarm.
     */
    private async handleBuiltInSwarm(taskDescription: string): Promise<void> {
        this.showInfo(`Orchestrating swarm for: ${taskDescription}`);
        this.showInfo(`Press Ctrl+X to interrupt • Ctrl+T for status`);

        try {
            const provider = this.registry.getActive();

            this.swarmCoordinator = new SwarmCoordinator({
                workingDir: process.cwd(),
                provider,
                maxAgents: 5,
                autoSpawn: true,
            });

            // Enable interrupt handling
            this.isInterruptible = true;
            this.hasShownNoTaskMessage = false; // Reset the message flag for new task

            // Wire up events for live feedback
            this.swarmCoordinator.on('orchestrate:decomposed', (tasks: any[]) => {
                console.log('');
                console.log(theme.header(`  📋 Decomposed into ${tasks.length} tasks:`));
                console.log('');

                // Group tasks by role for better visualization
                const tasksByRole = tasks.reduce((acc: Record<string, any[]>, task) => {
                    const role = task.role || 'coder';
                    if (!acc[role]) acc[role] = [];
                    acc[role].push(task);
                    return acc;
                }, {});

                // Display tasks grouped by role
                for (const [role, roleTasks] of Object.entries(tasksByRole)) {
                    const roleIcon = role === 'coder' ? '⚡' : role === 'tester' ? '🧪' : '👨‍💼';
                    const roleColor = role === 'coder' ? theme.info : role === 'tester' ? theme.warning : theme.dim;
                    console.log(roleColor(`  ${roleIcon} ${role.toUpperCase()} (${roleTasks.length}):`));

                    roleTasks.forEach((task, index) => {
                        const shortDesc = task.description.length > 60
                            ? task.description.substring(0, 60) + '...'
                            : task.description;
                        console.log(theme.dim(`    ${index + 1}. ${shortDesc}`));
                    });
                    console.log('');
                }
            });

            this.swarmCoordinator.on('task:dispatched', (taskId: string, agentId: string) => {
                const shortTaskId = taskId.substring(0, 8);
                const shortAgentId = agentId.substring(agentId.lastIndexOf('-') + 1);
                console.log(theme.tool(`  🚀 Task ${shortTaskId} → Agent ${shortAgentId}`));
            });

            this.swarmCoordinator.on('task:completed', (taskId: string) => {
                const shortTaskId = taskId.substring(0, 8);
                console.log(theme.success(`  ✅ Task ${shortTaskId} completed`));
            });

            this.swarmCoordinator.on('task:failed', (taskId: string, error: string) => {
                const shortTaskId = taskId.substring(0, 8);
                const shortError = error.length > 50 ? error.substring(0, 50) + '...' : error;
                console.log(theme.error(`  ❌ Task ${shortTaskId} failed: ${shortError}`));
            });

            this.swarmCoordinator.on('task:progress', (_taskId: string, progress: string) => {
                // Clean up progress messages - remove redundant prefixes and make shorter
                let cleanProgress = progress
                    .replace(/^Starting task: /, '')
                    .replace(/^Use write_file to /, '')
                    .replace(/^Create file: /, '📝 ')
                    .replace(/\n\n/g, ' ');

                if (cleanProgress.length > 80) {
                    cleanProgress = cleanProgress.substring(0, 77) + '...';
                }
                console.log(theme.dim(`  ⚡ ${cleanProgress}`));
            });

            // Race between orchestration completing and interrupt
            const orchestratePromise = this.swarmCoordinator.orchestrate(taskDescription);
            const interruptPromise = this.waitForInterrupt().then(() => null);

            const result = await Promise.race([orchestratePromise, interruptPromise]);

            // If interrupted, result is null
            if (result === null) {
                // Ensure clean state for next iteration
                this.isInterruptible = false;
                if (this.swarmCoordinator) {
                    // Force cleanup if not already done
                    try {
                        await this.swarmCoordinator.shutdown(true);
                    } catch (e) {
                        // Silent cleanup failure
                    }
                    this.swarmCoordinator = undefined;
                }
                // Reset state and return to prompt
                return;
            }

            // Show results
            console.log('');
            console.log(theme.header('  Swarm Results'));
            console.log('');
            console.log(theme.dim(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`));
            console.log(theme.dim(`  Tasks: ${result.stats.completed} completed, ${result.stats.failed} failed`));

            // Show enhanced metrics
            console.log('');
            console.log(theme.info('  Metrics:'));
            console.log(theme.dim(`  • Agents spawned: ${result.metrics.agentsSpawned}`));
            console.log(theme.dim(`  • Files created: ${result.metrics.filesCreated}/${result.metrics.filesAttempted}${result.metrics.filesAttempted > result.metrics.filesCreated ? ` (${result.metrics.filesAttempted - result.metrics.filesCreated} missing)` : ''}`));
            console.log(theme.dim(`  • Total tasks: ${result.metrics.totalTasks}`));
            if (result.metrics.retryCount > 0) {
                console.log(theme.dim(`  • Retry tasks: ${result.metrics.retryCount}`));
            }
            console.log(theme.dim(`  • Success rate: ${result.stats.total > 0 ? Math.round((result.stats.completed / result.stats.total) * 100) : 0}%`));

            if (result.synthesizedOutput) {
                console.log('');
                console.log(theme.assistant(result.synthesizedOutput));
            }

            console.log('');

            // Clean up
            this.isInterruptible = false;
            this.hasShownNoTaskMessage = false; // Reset for next task
            await this.swarmCoordinator.shutdown();
            this.swarmCoordinator = undefined;

        } catch (error: any) {
            this.isInterruptible = false;
            this.hasShownNoTaskMessage = false; // Reset for next task
            this.showError(`Swarm error: ${error.message}`);
            if (this.swarmCoordinator) {
                await this.swarmCoordinator.shutdown();
                this.swarmCoordinator = undefined;
            }
        }
    }

    /**
     * Get the currently active model.
     */
    getActiveModel(): string {
        return this.activeModel;
    }

    /**
     * Set the active model.
     */
    setActiveModel(model: string): void {
        this.activeModel = model;
    }

    /**
     * Close the terminal interface.
     */
    close(): void {
        this.rl.close();
    }
}
