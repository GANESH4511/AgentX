/**
 * AgentX — RuFlo-AgentX Bridge
 * 
 * Connects RuFlo orchestration state to AgentX worker execution.
 * 
 * RuFlo provides:
 *   - Swarm initialization and state management
 *   - Task creation and assignment
 *   - Agent spawning (metadata only)
 *   - Coordination orchestration
 * 
 * AgentX provides:
 *   - Actual worker process spawning
 *   - ReAct loop execution
 *   - Tool use (file read/write, shell commands)
 *   - Result collection
 * 
 * This bridge translates RuFlo agent assignments into AgentX worker
 * executions and reports results back to RuFlo state.
 */

import { EventEmitter } from 'node:events';
import { AgentSpawner, AgentConfig } from './spawner.js';
import { getStatusReporter, RuFloStatusReporter } from './ruflo-status-reporter.js';
import type { MCPToolBridge } from '../mcp/tool-bridge.js';
import { getMemory, type MemoryRouter } from '../memory/index.js';

// ─── Types ──────────────────────────────────────────────────────

export interface RuFloAgent {
    agentId: string;
    role: string;
    status: string;
}

export interface RuFloTask {
    taskId: string;
    description: string;
    assignedTo: string[];
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface BridgeConfig {
    workingDir: string;
    maxAgents?: number;
    /** Task timeout in ms. Set to 0 or undefined to disable timeout. Default: no timeout */
    taskTimeoutMs?: number;
}

export interface BridgeResult {
    success: boolean;
    taskId: string;
    results: Map<string, string>;
    errors: Map<string, string>;
    durationMs: number;
}

// ─── RuFlo-AgentX Bridge ────────────────────────────────────────

export class RuFloBridge extends EventEmitter {
    private spawner: AgentSpawner;
    private mcpBridge?: MCPToolBridge;
    private config: BridgeConfig;
    private statusReporter: RuFloStatusReporter;
    private agentIdMap: Map<string, string> = new Map(); // RuFlo ID -> AgentX ID
    private isRunning = false;
    private memory?: MemoryRouter;

    constructor(config: BridgeConfig, mcpBridge?: MCPToolBridge) {
        super();
        this.config = config;
        this.mcpBridge = mcpBridge;
        this.statusReporter = getStatusReporter(mcpBridge);

        // Initialize memory system
        this.initMemory();

        this.spawner = new AgentSpawner({
            maxAgents: config.maxAgents ?? 5,
        });

        // Wire up spawner events
        this.spawner.on('agent:result', (agentId: string, taskId: string, output: string) => {
            this.statusReporter.workerCompleted(agentId, output);
            this.emit('task:result', taskId, agentId, output);
        });

        this.spawner.on('agent:taskError', (agentId: string, taskId: string, error: string) => {
            this.statusReporter.workerFailed(agentId, error);
            this.emit('task:error', taskId, agentId, error);
        });

        this.spawner.on('agent:progress', (agentId: string, taskId: string, progress: string) => {
            // Extract tool name if present
            const toolMatch = progress.match(/🔧\s*(\w+)/);
            this.statusReporter.workerProgress(agentId, progress, toolMatch?.[1]);
            this.emit('task:progress', taskId, agentId, progress);
        });

        this.spawner.on('agent:ready', (agentId: string) => {
            this.statusReporter.workerRunning(agentId);
            this.emit('agent:ready', agentId);
        });
    }

    /**
     * Initialize memory system for cross-session context
     */
    private async initMemory(): Promise<void> {
        try {
            this.memory = await getMemory();
        } catch (error) {
            // Memory is optional, continue without it
        }
    }

    /**
     * Get relevant context from memory for a task
     */
    async getTaskContext(taskDescription: string): Promise<string> {
        if (!this.memory) return '';
        
        try {
            const memories = await this.memory.getTaskContext(taskDescription, 3);
            if (memories.length === 0) return '';
            
            const context = memories.map(m => {
                const task = m.entry.content;
                return `Previous task: "${task.description}" - ${task.status}${
                    task.filesChanged?.length ? ` (files: ${task.filesChanged.join(', ')})` : ''
                }`;
            }).join('\n');
            
            return `\n## Context from Previous Sessions:\n${context}\n`;
        } catch {
            return '';
        }
    }

    /**
     * Execute a task with RuFlo orchestration and AgentX workers.
     * 
     * @param taskDescription - The task to execute
     * @param ruFloAgents - Agent IDs from RuFlo swarm_spawn
     */
    async executeTask(
        taskDescription: string,
        ruFloAgents: RuFloAgent[],
        taskId: string,
    ): Promise<BridgeResult> {
        const startTime = Date.now();
        const results = new Map<string, string>();
        const errors = new Map<string, string>();

        this.isRunning = true;
        this.statusReporter.taskStarted(taskId);
        this.emit('execution:started', taskId, ruFloAgents.length);

        try {
            // Spawn AgentX workers for each RuFlo agent
            const workerPromises: Promise<void>[] = [];

            for (const ruFloAgent of ruFloAgents) {
                const agentConfig: AgentConfig = {
                    role: ruFloAgent.role || 'coder',
                    tier: this.getTierForRole(ruFloAgent.role),
                    workingDir: this.config.workingDir,
                    systemPromptExtra: this.getSystemPromptForRole(ruFloAgent.role),
                    maxIterations: 10,
                };

                // Spawn AgentX worker
                const agentXId = this.spawner.spawn(agentConfig);
                this.agentIdMap.set(ruFloAgent.agentId, agentXId);

                // Report worker started to status reporter
                this.statusReporter.workerStarted(
                    taskId,
                    ruFloAgent.agentId,
                    agentXId,
                    ruFloAgent.role || 'coder',
                );

                this.emit('agent:spawned', ruFloAgent.agentId, agentXId, ruFloAgent.role);

                // Create task execution promise
                const workerPromise = this.executeWorkerTask(
                    agentXId,
                    ruFloAgent,
                    taskDescription,
                    taskId,
                ).then(result => {
                    results.set(ruFloAgent.agentId, result);
                }).catch(error => {
                    errors.set(ruFloAgent.agentId, error.message || String(error));
                });

                workerPromises.push(workerPromise);
            }

            // Wait for all workers to complete
            await Promise.all(workerPromises);

            // Update task status
            if (errors.size === 0) {
                this.statusReporter.taskCompleted(taskId, `${results.size} workers completed`);
            } else {
                this.statusReporter.taskFailed(taskId, `${errors.size} workers failed`);
            }

            // Update RuFlo task status
            await this.updateRuFloTaskStatus(taskId, errors.size === 0 ? 'completed' : 'failed');

        } catch (error: any) {
            this.statusReporter.taskFailed(taskId, error.message);
            this.emit('execution:error', taskId, error.message);
            errors.set('bridge', error.message || String(error));
        } finally {
            this.isRunning = false;
        }

        const durationMs = Date.now() - startTime;
        this.emit('execution:completed', taskId, results.size, errors.size, durationMs);

        return {
            success: errors.size === 0,
            taskId,
            results,
            errors,
            durationMs,
        };
    }

    /**
     * Execute a single worker task.
     */
    private async executeWorkerTask(
        agentXId: string,
        ruFloAgent: RuFloAgent,
        taskDescription: string,
        taskId: string,
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const timeout = this.config.taskTimeoutMs;
            let resolved = false;
            let timer: NodeJS.Timeout | null = null;

            // Only set timeout if configured and > 0
            if (timeout && timeout > 0) {
                timer = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        reject(new Error(`Task timeout after ${timeout}ms`));
                    }
                }, timeout);
            }

            // Listen for this specific task completion
            const onResult = (tId: string, aId: string, output: string) => {
                if (aId === agentXId) {
                    resolved = true;
                    if (timer) clearTimeout(timer);
                    this.removeListener('task:result', onResult);
                    this.removeListener('task:error', onError);
                    resolve(output);
                }
            };

            const onError = (tId: string, aId: string, error: string) => {
                if (aId === agentXId) {
                    resolved = true;
                    if (timer) clearTimeout(timer);
                    this.removeListener('task:result', onResult);
                    this.removeListener('task:error', onError);
                    reject(new Error(error));
                }
            };

            this.on('task:result', onResult);
            this.on('task:error', onError);

            // Build role-specific prompt
            const rolePrompt = this.buildRolePrompt(ruFloAgent.role, taskDescription);

            // Send task to worker
            // sendTask signature: (agentId, taskId, prompt, context?)
            this.spawner.sendTask(
                agentXId,
                `${taskId}-${ruFloAgent.agentId}`,
                rolePrompt,
                `Working directory: ${this.config.workingDir}\nRole: ${ruFloAgent.role}`
            );
        });
    }

    /**
     * Build a role-specific prompt for the worker.
     */
    private buildRolePrompt(role: string, taskDescription: string): string {
        const roleInstructions: Record<string, string> = {
            coder: `You are a CODER agent. Create the actual files using write_file tool.

TASK: ${taskDescription}

CRITICAL RULES:
1. Use write_file to create files - do NOT just describe code
2. Create complete, working implementations
3. Use proper file paths (src/ for source, tests/ for tests)
4. Verify files were created by checking tool results`,

            tester: `You are a TESTER agent. Create test files using write_file tool.

TASK: Write tests for: ${taskDescription}

CRITICAL RULES:
1. Use write_file to create test files in tests/ directory
2. Include comprehensive test cases (happy path, edge cases, errors)
3. Tests should be runnable with node or the project test framework
4. Verify test files were created`,

            reviewer: `You are a REVIEWER agent. Review the code quality.

TASK: Review code for: ${taskDescription}

Focus on:
- Bugs and logic errors
- Security issues
- Performance concerns
- Code style consistency

Provide specific, actionable feedback.`,

            researcher: `You are a RESEARCHER agent. Explore the codebase.

TASK: Research for: ${taskDescription}

Focus on:
- Understanding existing patterns
- Finding relevant files
- Identifying dependencies
- Summarizing findings

Use read_file and list_dir to explore. Do NOT modify files.`,
        };

        return roleInstructions[role] || `TASK: ${taskDescription}`;
    }

    /**
     * Get model tier based on role complexity.
     */
    private getTierForRole(role: string): 1 | 2 | 3 {
        switch (role) {
            case 'reviewer':
            case 'researcher':
                return 1; // Fast tier for read-only tasks
            case 'coder':
            case 'tester':
                return 2; // Default tier for code generation
            default:
                return 2;
        }
    }

    /**
     * Get extra system prompt for role.
     */
    private getSystemPromptForRole(role: string): string {
        const prompts: Record<string, string> = {
            coder: 'You MUST use write_file to create files. Never just describe code.',
            tester: 'You MUST use write_file to create test files. Never just describe tests.',
            reviewer: 'Provide specific line-by-line feedback. Do not modify files.',
            researcher: 'Read and summarize. Do not modify files.',
        };
        return prompts[role] || '';
    }

    /**
     * Update RuFlo task status via MCP.
     */
    private async updateRuFloTaskStatus(
        taskId: string,
        status: 'completed' | 'failed',
    ): Promise<void> {
        if (!this.mcpBridge) return;

        try {
            await this.mcpBridge.callTool('ruflo', 'task_update', {
                taskId,
                status,
            });
        } catch (error) {
            // Log but don't fail - RuFlo state update is not critical
            this.emit('ruflo:updateFailed', taskId, error);
        }
    }

    /**
     * Shutdown all workers.
     */
    async shutdown(): Promise<void> {
        this.isRunning = false;
        await this.spawner.killAll();
        this.agentIdMap.clear();
        this.statusReporter.clear();
    }

    /**
     * Get bridge status including real worker state.
     */
    getStatus(): {
        isRunning: boolean;
        activeWorkers: number;
        completedWorkers: number;
        failedWorkers: number;
        agentMapping: Record<string, string>;
        workers: Array<{
            ruFloId: string;
            agentXId: string;
            role: string;
            status: string;
            progress?: string;
        }>;
    } {
        const reporterStatus = this.statusReporter.getStatus();
        
        return {
            isRunning: this.isRunning,
            activeWorkers: reporterStatus.activeWorkers,
            completedWorkers: reporterStatus.completedWorkers,
            failedWorkers: reporterStatus.failedWorkers,
            agentMapping: Object.fromEntries(this.agentIdMap),
            workers: reporterStatus.workers.map(w => ({
                ruFloId: w.ruFloAgentId,
                agentXId: w.agentXWorkerId,
                role: w.role,
                status: w.status,
                progress: w.progress,
            })),
        };
    }

    /**
     * Get the status reporter for external access.
     */
    getStatusReporter(): RuFloStatusReporter {
        return this.statusReporter;
    }
}
