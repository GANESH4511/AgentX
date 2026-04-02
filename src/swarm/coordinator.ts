/**
 * AgentX — Swarm Coordinator
 * 
 * The parent-process orchestrator that:
 *   1. Decomposes a complex task into sub-tasks
 *   2. Spawns child agents with appropriate roles/tiers
 *   3. Distributes work via the TaskQueue
 *   4. Collects results and synthesizes a final answer
 *   5. Handles failures, retries, and timeout
 * 
 * Pattern:
 *   Parent AgentX (Tier 3 - 70B, "coordinator")
 *     ├── Child 1: "coder"    (Tier 2 - 11B) → writes code
 *     ├── Child 2: "tester"   (Tier 2 - 11B) → writes tests
 *     └── Child 3: "reviewer" (Tier 1 - 3B)  → checks quality
 */

import { EventEmitter } from 'node:events';
import { AgentSpawner, AgentConfig } from './spawner.js';
import { TaskQueue, TaskDefinition, Task, TaskQueueStats, TaskPriority } from './task-queue.js';
import { LLMProvider } from '../providers/base.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CoordinatorConfig {
    /** Maximum parallel agents */
    maxAgents?: number;
    /** Global timeout per task (ms) */
    taskTimeoutMs?: number;
    /** Whether to auto-spawn agents as needed */
    autoSpawn?: boolean;
    /** Directory agents work in */
    workingDir: string;
    /** The coordinator's own provider (Tier 3 for decomposition) */
    provider: LLMProvider;
}

export interface SwarmResult {
    success: boolean;
    results: Map<string, string>;
    failures: Map<string, string>;
    stats: TaskQueueStats;
    synthesizedOutput?: string;
    durationMs: number;
    metrics: {
        agentsSpawned: number;
        filesCreated: number;
        filesAttempted: number;
        totalTasks: number;
        retryCount: number;
    };
}

export interface SwarmStatusEntry {
    agentId: string;
    role: string;
    status: string;
    currentTask?: string;
    pid?: number;
}

// ─── Coordinator ────────────────────────────────────────────────

export class SwarmCoordinator extends EventEmitter {
    private spawner: AgentSpawner;
    private queue: TaskQueue;
    private config: CoordinatorConfig;
    private isRunning = false;
    private shutdownRequested = false; // Flag to stop all operations
    private taskTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();

    // Enhanced metrics tracking
    private metrics = {
        agentsSpawned: 0,
        filesCreated: 0,
        filesAttempted: 0,
        retryCount: 0,
    };

    constructor(config: CoordinatorConfig) {
        super();
        this.config = config;

        this.spawner = new AgentSpawner({
            maxAgents: config.maxAgents ?? 5,
        });

        this.queue = new TaskQueue();

        // ─── Wire up spawner events to queue lifecycle ──────────
        this.spawner.on('agent:result', (agentId: string, taskId: string, output: string) => {
            this.clearTaskTimeout(taskId);
            this.queue.markCompleted(taskId, output);
            this.emit('task:completed', taskId, output);
            this.processNext(); // pick up next task
        });

        this.spawner.on('agent:taskError', (agentId: string, taskId: string, error: string) => {
            this.clearTaskTimeout(taskId);
            const retried = this.queue.markFailed(taskId, error);
            this.emit('task:failed', taskId, error, retried);
            this.processNext();
        });

        this.spawner.on('agent:ready', (agentId: string) => {
            this.emit('agent:ready', agentId);
            this.processNext();
        });

        this.spawner.on('agent:progress', (agentId: string, taskId: string, progress: string) => {
            this.emit('task:progress', taskId, progress);
        });

        this.spawner.on('agent:exit', (agentId: string, code: number, signal: string) => {
            this.emit('agent:exit', agentId, code, signal);
            // If agent died while running a task, mark it failed
            const agent = this.spawner.get(agentId);
            if (agent?.currentTaskId) {
                const retried = this.queue.markFailed(agent.currentTaskId, `Agent crashed (code=${code})`);
                this.emit('task:failed', agent.currentTaskId, 'Agent crashed', retried);
            }
            this.processNext();
        });

        this.spawner.on('agent:stale', (agentId: string) => {
            this.emit('agent:stale', agentId);
        });

        // Capture stderr from agents for debugging
        this.spawner.on('agent:stderr', (agentId: string, stderr: string) => {
            this.emit('agent:stderr', agentId, stderr);
            console.error(`  [Agent ${agentId}] STDERR: ${stderr.trim()}`);
        });
    }

    /**
     * Submit a batch of tasks and run them concurrently.
     * Returns when all tasks complete or fail.
     */
    async runBatch(tasks: TaskDefinition[]): Promise<SwarmResult> {
        const startTime = Date.now();

        // First pass: enqueue all tasks to get their IDs
        const taskIds: string[] = [];
        for (const task of tasks) {
            const id = this.queue.enqueue({ ...task, dependsOn: [] }); // Temp empty deps
            taskIds.push(id);
        }

        // Second pass: resolve index-based dependencies to real IDs
        for (let i = 0; i < tasks.length; i++) {
            const task = this.queue.get(taskIds[i]);
            const meta = tasks[i].metadata as { _dependencyIndices?: number[] } | undefined;
            if (task && meta?._dependencyIndices?.length) {
                task.dependsOn = meta._dependencyIndices
                    .filter(idx => idx >= 0 && idx < taskIds.length)
                    .map(idx => taskIds[idx]);
            }
        }

        this.emit('batch:started', taskIds);

        // Start processing
        this.isRunning = true;
        this.processNext();

        // Wait for all tasks to finish
        await this.waitForCompletion();

        this.isRunning = false;

        // Gather results
        const results = this.queue.getResults();
        const failures = new Map<string, string>();
        for (const task of this.queue.list('failed')) {
            failures.set(task.id, task.error ?? 'Unknown error');
        }

        const stats = this.queue.getStats();
        const durationMs = Date.now() - startTime;

        const swarmResult: SwarmResult = {
            success: stats.failed === 0,
            results,
            failures,
            stats,
            durationMs,
            metrics: {
                agentsSpawned: this.metrics.agentsSpawned,
                filesCreated: this.metrics.filesCreated,
                filesAttempted: this.metrics.filesAttempted,
                totalTasks: stats.total,
                retryCount: this.metrics.retryCount,
            },
        };

        this.emit('batch:completed', swarmResult);
        return swarmResult;
    }

    /**
     * Decompose a high-level task into sub-tasks using the coordinator's
     * own LLM (Tier 3), then run them as a swarm.
     * 
     * This is the "smart" entry point — give it a complex task description
     * and it figures out the decomposition.
     */
    async orchestrate(taskDescription: string): Promise<SwarmResult> {
        this.emit('orchestrate:start', taskDescription);

        // Step 1: Use Tier 3 model to decompose the task
        const decomposition = await this.decomposeTask(taskDescription);

        // Check if shutdown was requested during decomposition
        if (this.shutdownRequested) {
            return this.createEmptyResult();
        }

        this.emit('orchestrate:decomposed', decomposition);

        // Step 2: Run the decomposed tasks
        const result = await this.runBatch(decomposition);

        // Check if shutdown was requested during execution
        if (this.shutdownRequested) {
            return this.createEmptyResult();
        }

        // Step 3: Verify deliverables were created
        const deliverables = this.extractExpectedDeliverables(decomposition);
        const verification = await this.verifyDeliverables(deliverables);

        // Track file metrics
        this.metrics.filesAttempted = deliverables.length;
        this.metrics.filesCreated = verification.present.length;

        if (!verification.allPresent && !this.shutdownRequested) {
            this.emit('orchestrate:missingDeliverables', verification.missing);
            // Re-run tasks for missing files
            const retryTasks = this.createRetryTasks(verification.missing, decomposition);
            if (retryTasks.length > 0) {
                this.emit('orchestrate:retrying', retryTasks.length);
                this.metrics.retryCount += retryTasks.length;
                const retryResult = await this.runBatch(retryTasks);
                // Merge results
                for (const [id, output] of retryResult.results) {
                    result.results.set(id, output);
                }
                // Re-verify after retries
                const retryVerification = await this.verifyDeliverables(verification.missing);
                this.metrics.filesCreated += retryVerification.present.length;
            }
        }

        // Check if shutdown was requested
        if (this.shutdownRequested) {
            return this.createEmptyResult();
        }

        // Step 4: Synthesize results if all tasks succeeded
        if (result.success && result.results.size > 0) {
            result.synthesizedOutput = await this.synthesizeResults(
                taskDescription,
                result.results,
            );
        }

        this.emit('orchestrate:done', result);
        return result;
    }

    /**
     * Create an empty result for interrupted orchestration.
     */
    private createEmptyResult(): SwarmResult {
        const stats = this.queue.getStats();
        return {
            success: false,
            results: new Map(),
            failures: new Map(),
            stats,
            durationMs: 0,
            metrics: {
                agentsSpawned: this.metrics.agentsSpawned,
                filesCreated: this.metrics.filesCreated,
                filesAttempted: this.metrics.filesAttempted,
                totalTasks: stats.total,
                retryCount: this.metrics.retryCount,
            },
        };
    }

    /**
     * Get live status of all agents and tasks.
     */
    getStatus(): {
        agents: SwarmStatusEntry[];
        queue: TaskQueueStats;
        isRunning: boolean;
    } {
        const agents: SwarmStatusEntry[] = this.spawner.listAll().map(a => ({
            agentId: a.id,
            role: a.config.role ?? 'general',
            status: a.status,
            currentTask: a.currentTaskId,
            pid: a.pid,
        }));

        return {
            agents,
            queue: this.queue.getStats(),
            isRunning: this.isRunning,
        };
    }

    /**
     * Shut down all agents and clean up.
     */
    async shutdown(graceful = true): Promise<void> {
        this.isRunning = false;
        this.shutdownRequested = true; // Signal to stop all operations

        // Clear all timeouts
        for (const [taskId, timer] of this.taskTimeouts) {
            clearTimeout(timer);
        }
        this.taskTimeouts.clear();

        // Kill all agents forcefully
        await this.spawner.killAll(graceful);
        this.queue.clear();

        this.emit('coordinator:shutdown');
    }

    // ─── Task access (for external inspection) ────────────────────

    getTask(taskId: string): Task | undefined {
        return this.queue.get(taskId);
    }

    getQueueStats(): TaskQueueStats {
        return this.queue.getStats();
    }

    // ─── Private ──────────────────────────────────────────────────

    /**
     * Process the next available task: dequeue → find/spawn agent → send.
     */
    private processNext(): void {
        if (!this.isRunning || this.shutdownRequested) return;

        const task = this.queue.dequeue();
        if (!task) return;

        try {
            // Get or spawn an agent for this task
            const agentConfig: AgentConfig = {
                role: task.role ?? 'coder',
                tier: task.tier ?? 2,
                workingDir: this.config.workingDir,
            };

            const agentId = this.config.autoSpawn !== false
                ? (() => {
                    const agentId = this.spawner.getOrSpawn(agentConfig);
                    // Track if this is a new agent
                    const agent = this.spawner.get(agentId);
                    if (agent && !agent.currentTaskId) { // New agent or first use
                        this.metrics.agentsSpawned++;
                    }
                    return agentId;
                })()
                : (() => {
                    const idle = this.spawner.getIdleAgent(task.role);
                    if (!idle) throw new Error('No idle agents available (autoSpawn disabled)');
                    return idle.id;
                })();

            // Mark task as running
            this.queue.markRunning(task.id, agentId);

            // Send task to agent
            this.spawner.sendTask(agentId, task.id, task.prompt, undefined);

            this.emit('task:dispatched', task.id, agentId);

            // Try to process more tasks (fill idle agents)
            this.processNext();

        } catch (error: any) {
            // If we couldn't spawn/find an agent, re-queue the task
            this.queue.markFailed(task.id, error.message);
            this.emit('task:dispatchError', task.id, error.message);
        }
    }

    /**
     * Wait for all tasks in the queue to finish.
     */
    private waitForCompletion(): Promise<void> {
        return new Promise<void>((resolve) => {
            const check = () => {
                const stats = this.queue.getStats();

                // Check if all tasks are done
                if (this.queue.isFinished()) {
                    resolve();
                    return;
                }

                // If all running/pending tasks are done and we have results, we're done
                if (stats.running === 0 && stats.pending === 0 && (stats.completed > 0 || stats.failed > 0)) {
                    resolve();
                    return;
                }

                setTimeout(check, 300); // Check every 300ms
            };
            check();
        });
    }

    /**
     * Use the coordinator's Tier 3 provider to decompose a task.
     */
    private async decomposeTask(description: string): Promise<TaskDefinition[]> {
        const prompt = `You are a task decomposer for a multi-agent coding system.
Given a task, break it down into independent sub-tasks that create CONCRETE DELIVERABLES.

## Available agent roles:
- "coder": Writes implementation code. MUST create actual files.
- "tester": Writes test files. MUST create actual test files.
- "reviewer": Reviews completed code for quality/security.
- "researcher": Reads codebase to gather context (read-only).

## CRITICAL RULES:
1. Every coder/tester task MUST specify exact file path(s) to create
2. Use write_file tool, not just describe what should be done
3. Each file type (HTML, CSS, JS) needs its OWN separate task
4. Tasks should run IN PARALLEL when possible - only add dependencies if truly required
5. Reviewer tasks should run AFTER coding tasks complete (add dependencies)

## For each sub-task, output JSON with:
- description: Brief summary (1 line)
- prompt: DETAILED instructions including:
  * Exact file path to create (e.g., "Create file: login-app/index.html")
  * Complete file content requirements
  * Use write_file tool to create the file
- role: One of the roles above
- tier: 1 (simple), 2 (default), or 3 (complex)
- priority: "critical" (run first), "high", "normal", or "low"
- dependencies: Array of task indices this depends on (ONLY if truly needed, empty [] for parallel)

## EXAMPLE for "create login page" (PARALLEL execution):
[
  {
    "description": "Create HTML structure for login page",
    "prompt": "Create file: login-app/index.html\\n\\nUse write_file to create a complete HTML file with:\\n- DOCTYPE declaration\\n- head with meta tags, title, link to styles.css\\n- body with login form (username, password, submit button)\\n- script tag linking to app.js\\n\\nMake the HTML complete and valid.",
    "role": "coder",
    "tier": 2,
    "priority": "critical",
    "dependencies": []
  },
  {
    "description": "Create CSS styles for login page",
    "prompt": "Create file: login-app/styles.css\\n\\nUse write_file to create a CSS file with:\\n- Modern styling for the login form\\n- Centered layout\\n- Input field styling\\n- Button hover effects\\n- Responsive design",
    "role": "coder",
    "tier": 2,
    "priority": "critical",
    "dependencies": []
  },
  {
    "description": "Create JavaScript for login functionality",
    "prompt": "Create file: login-app/app.js\\n\\nUse write_file to create a JS file with:\\n- Form submission handler\\n- Input validation (check empty fields)\\n- Error message display\\n- Basic client-side authentication logic",
    "role": "coder",
    "tier": 2,
    "priority": "critical",
    "dependencies": []
  }
]

IMPORTANT: Output ONLY valid JSON array. No explanation text.

Task to decompose:
${description}`;

        try {
            const response = await this.config.provider.chatComplete(
                [
                    { role: 'system', content: 'You output only valid JSON arrays. No markdown fences, no explanation.' },
                    { role: 'user', content: prompt },
                ],
                {
                    model: this.config.provider.getModelForTier(3),
                    temperature: 0.3,
                    maxTokens: 2048,
                },
            );

            // Parse the JSON response
            const cleaned = response
                .replace(/```json\s*/g, '')
                .replace(/```\s*/g, '')
                .trim();

            const parsed = JSON.parse(cleaned) as Array<{
                description: string;
                prompt: string;
                role?: string;
                tier?: number;
                priority?: string;
                dependencies?: number[];
            }>;

            // Convert index-based dependencies to placeholder IDs
            // The actual IDs will be resolved during enqueueBatch
            return parsed.map((item, index) => ({
                description: item.description,
                prompt: item.prompt,
                role: item.role ?? 'coder',
                tier: (item.tier ?? 2) as 1 | 2 | 3,
                priority: (item.priority ?? 'normal') as any,
                // Store dependency indices in metadata for resolution
                metadata: {
                    _dependencyIndices: item.dependencies ?? [],
                    _taskIndex: index,
                },
            }));
        } catch (error: any) {
            // If decomposition fails, treat the whole thing as a single task
            this.emit('orchestrate:decomposeError', error.message);
            return [{
                description: 'Full task (decomposition failed)',
                prompt: description,
                role: 'coder',
                tier: 2,
                priority: 'normal',
            }];
        }
    }

    /**
     * Synthesize results from all completed sub-tasks into a coherent summary.
     */
    private async synthesizeResults(
        originalTask: string,
        results: Map<string, string>,
    ): Promise<string> {
        const resultSummary = Array.from(results.entries())
            .map(([id, output]) => `### Task ${id}\n${output}`)
            .join('\n\n');

        const prompt = `You are summarizing the results of a multi-agent task.

Original task: ${originalTask}

Results from each sub-agent:
${resultSummary}

Please provide a concise summary of what was accomplished.
If there are any issues or concerns raised by reviewers, highlight those.`;

        try {
            return await this.config.provider.chatComplete(
                [
                    { role: 'system', content: 'Summarize multi-agent task results concisely.' },
                    { role: 'user', content: prompt },
                ],
                {
                    model: this.config.provider.getModelForTier(3),
                    temperature: 0.3,
                    maxTokens: 1024,
                },
            );
        } catch {
            return `Completed ${results.size} sub-tasks. See individual results for details.`;
        }
    }

    /**
     * Set a timeout for a task.
     */
    private setTaskTimeout(taskId: string, timeoutMs: number): void {
        const timer = setTimeout(() => {
            const task = this.queue.get(taskId);
            if (task && task.status === 'running') {
                this.queue.markFailed(taskId, `Task timed out after ${timeoutMs / 1000}s`);
                this.emit('task:timeout', taskId);

                // Kill the agent that was running this task
                if (task.assignedTo) {
                    this.spawner.kill(task.assignedTo, false).catch(() => { });
                }
            }
        }, timeoutMs);

        this.taskTimeouts.set(taskId, timer);
    }

    /**
     * Clear a task's timeout.
     */
    private clearTaskTimeout(taskId: string): void {
        const timer = this.taskTimeouts.get(taskId);
        if (timer) {
            clearTimeout(timer);
            this.taskTimeouts.delete(taskId);
        }
    }

    /**
     * Extract expected file deliverables from task prompts.
     */
    private extractExpectedDeliverables(tasks: TaskDefinition[]): string[] {
        const deliverables: string[] = [];
        const filePattern = /(?:Create file|write_file.*path)[:\s]+([^\s\n,]+\.[a-z]+)/gi;

        for (const task of tasks) {
            if (task.role === 'coder' || task.role === 'tester') {
                let match;
                while ((match = filePattern.exec(task.prompt)) !== null) {
                    deliverables.push(match[1]);
                }
            }
        }

        return [...new Set(deliverables)]; // Deduplicate
    }

    /**
     * Verify that expected deliverables exist on disk.
     */
    private async verifyDeliverables(files: string[]): Promise<{
        allPresent: boolean;
        present: string[];
        missing: string[];
    }> {
        const { existsSync } = await import('node:fs');
        const { resolve } = await import('node:path');

        const present: string[] = [];
        const missing: string[] = [];

        for (const file of files) {
            const fullPath = resolve(this.config.workingDir, file);
            if (existsSync(fullPath)) {
                present.push(file);
            } else {
                missing.push(file);
            }
        }

        return {
            allPresent: missing.length === 0,
            present,
            missing,
        };
    }

    /**
     * Create retry tasks for missing deliverables.
     */
    private createRetryTasks(
        missingFiles: string[],
        originalTasks: TaskDefinition[],
    ): TaskDefinition[] {
        return missingFiles.map(file => {
            // Find the original task that was supposed to create this file
            const ext = file.split('.').pop()?.toLowerCase() ?? '';
            let role = 'coder';
            let description = `Create missing file: ${file}`;

            const prompt = `CRITICAL: The file "${file}" was NOT created in the previous attempt.
You MUST use the write_file tool to create this file NOW.

File to create: ${file}

Instructions:
1. Use write_file with path="${file}"
2. Generate complete, working content for this ${ext.toUpperCase()} file
3. Verify the file was created

DO NOT just describe what to do. Actually CREATE the file using write_file.`;

            return {
                description,
                prompt,
                role,
                tier: 2 as 1 | 2 | 3,
                priority: 'critical' as TaskPriority,
            };
        });
    }
}
