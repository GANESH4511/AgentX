/**
 * AgentX — RuFlo Status Reporter
 * 
 * Keeps RuFlo MCP state in sync with AgentX worker state.
 * 
 * Problem: RuFlo creates agent IDs but doesn't know when AgentX
 * workers actually start, run, or complete. This causes Ctrl+T
 * to show "Agent Count: 0" even when workers are active.
 * 
 * Solution: Report worker lifecycle events to RuFlo via MCP calls:
 *   - agent_update: Update agent status (starting, running, completed)
 *   - task_progress: Report task progress
 *   - task_update: Mark task as completed/failed
 */

import { EventEmitter } from 'node:events';
import type { MCPToolBridge } from '../mcp/tool-bridge.js';

// ─── Types ──────────────────────────────────────────────────────

export interface WorkerStatus {
    ruFloAgentId: string;     // RuFlo's agent ID
    agentXWorkerId: string;   // AgentX's worker process ID
    role: string;
    status: 'starting' | 'running' | 'completed' | 'failed';
    currentTool?: string;     // Currently executing tool
    progress?: string;        // Last progress message
    startedAt: number;
    completedAt?: number;
    error?: string;
}

export interface TaskStatus {
    taskId: string;
    status: 'pending' | 'in_progress' | 'completed' | 'failed';
    workers: Map<string, WorkerStatus>;
    startedAt: number;
    completedAt?: number;
    result?: string;
    error?: string;
}

// ─── RuFlo Status Reporter ──────────────────────────────────────

export class RuFloStatusReporter extends EventEmitter {
    private mcpBridge?: MCPToolBridge;
    private tasks: Map<string, TaskStatus> = new Map();
    private workers: Map<string, WorkerStatus> = new Map();
    private reportingEnabled = true;

    constructor(mcpBridge?: MCPToolBridge) {
        super();
        this.mcpBridge = mcpBridge;
    }

    /**
     * Set the MCP bridge (can be set after construction).
     */
    setMCPBridge(bridge: MCPToolBridge): void {
        this.mcpBridge = bridge;
    }

    /**
     * Enable/disable reporting to RuFlo.
     */
    setReportingEnabled(enabled: boolean): void {
        this.reportingEnabled = enabled;
    }

    // ─── Task Lifecycle ─────────────────────────────────────────

    /**
     * Register a new task.
     */
    taskStarted(taskId: string): void {
        const task: TaskStatus = {
            taskId,
            status: 'in_progress',
            workers: new Map(),
            startedAt: Date.now(),
        };
        this.tasks.set(taskId, task);
        this.emit('task:started', taskId);
        this.reportTaskStatus(taskId, 'in_progress');
    }

    /**
     * Mark task as completed.
     */
    taskCompleted(taskId: string, result?: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'completed';
            task.completedAt = Date.now();
            task.result = result;
            this.emit('task:completed', taskId, result);
            this.reportTaskStatus(taskId, 'completed', result);
        }
    }

    /**
     * Mark task as failed.
     */
    taskFailed(taskId: string, error: string): void {
        const task = this.tasks.get(taskId);
        if (task) {
            task.status = 'failed';
            task.completedAt = Date.now();
            task.error = error;
            this.emit('task:failed', taskId, error);
            this.reportTaskStatus(taskId, 'failed', undefined, error);
        }
    }

    // ─── Worker Lifecycle ───────────────────────────────────────

    /**
     * Register a worker starting.
     */
    workerStarted(
        taskId: string,
        ruFloAgentId: string,
        agentXWorkerId: string,
        role: string,
    ): void {
        const worker: WorkerStatus = {
            ruFloAgentId,
            agentXWorkerId,
            role,
            status: 'starting',
            startedAt: Date.now(),
        };

        this.workers.set(agentXWorkerId, worker);

        const task = this.tasks.get(taskId);
        if (task) {
            task.workers.set(agentXWorkerId, worker);
        }

        this.emit('worker:started', agentXWorkerId, ruFloAgentId, role);
        this.reportAgentStatus(ruFloAgentId, 'running', role);
    }

    /**
     * Update worker status to running.
     */
    workerRunning(agentXWorkerId: string): void {
        const worker = this.workers.get(agentXWorkerId);
        if (worker) {
            worker.status = 'running';
            this.emit('worker:running', agentXWorkerId);
            this.reportAgentStatus(worker.ruFloAgentId, 'running', worker.role);
        }
    }

    /**
     * Report worker progress.
     */
    workerProgress(agentXWorkerId: string, progress: string, tool?: string): void {
        const worker = this.workers.get(agentXWorkerId);
        if (worker) {
            worker.progress = progress;
            worker.currentTool = tool;
            this.emit('worker:progress', agentXWorkerId, progress, tool);
        }
    }

    /**
     * Mark worker as completed.
     */
    workerCompleted(agentXWorkerId: string, result?: string): void {
        const worker = this.workers.get(agentXWorkerId);
        if (worker) {
            worker.status = 'completed';
            worker.completedAt = Date.now();
            this.emit('worker:completed', agentXWorkerId, result);
            this.reportAgentStatus(worker.ruFloAgentId, 'completed', worker.role);
        }
    }

    /**
     * Mark worker as failed.
     */
    workerFailed(agentXWorkerId: string, error: string): void {
        const worker = this.workers.get(agentXWorkerId);
        if (worker) {
            worker.status = 'failed';
            worker.completedAt = Date.now();
            worker.error = error;
            this.emit('worker:failed', agentXWorkerId, error);
            this.reportAgentStatus(worker.ruFloAgentId, 'failed', worker.role, error);
        }
    }

    // ─── Status Queries ─────────────────────────────────────────

    /**
     * Get all active workers.
     */
    getActiveWorkers(): WorkerStatus[] {
        return Array.from(this.workers.values())
            .filter(w => w.status === 'starting' || w.status === 'running');
    }

    /**
     * Get worker by AgentX ID.
     */
    getWorker(agentXWorkerId: string): WorkerStatus | undefined {
        return this.workers.get(agentXWorkerId);
    }

    /**
     * Get task status.
     */
    getTask(taskId: string): TaskStatus | undefined {
        return this.tasks.get(taskId);
    }

    /**
     * Get combined status for display.
     */
    getStatus(): {
        activeTasks: number;
        activeWorkers: number;
        completedWorkers: number;
        failedWorkers: number;
        tasks: TaskStatus[];
        workers: WorkerStatus[];
    } {
        const tasks = Array.from(this.tasks.values());
        const workers = Array.from(this.workers.values());

        return {
            activeTasks: tasks.filter(t => t.status === 'in_progress').length,
            activeWorkers: workers.filter(w => w.status === 'starting' || w.status === 'running').length,
            completedWorkers: workers.filter(w => w.status === 'completed').length,
            failedWorkers: workers.filter(w => w.status === 'failed').length,
            tasks,
            workers,
        };
    }

    // ─── RuFlo MCP Reporting ────────────────────────────────────

    /**
     * Report agent status to RuFlo.
     */
    private async reportAgentStatus(
        agentId: string,
        status: string,
        role: string,
        error?: string,
    ): Promise<void> {
        if (!this.reportingEnabled || !this.mcpBridge) return;

        try {
            await this.mcpBridge.callTool('ruflo', 'agent_update', {
                agentId,
                status,
                role,
                ...(error ? { error } : {}),
            });
        } catch (err) {
            // Don't fail on reporting errors - just emit event
            this.emit('report:error', 'agent_update', err);
        }
    }

    /**
     * Report task status to RuFlo.
     */
    private async reportTaskStatus(
        taskId: string,
        status: string,
        result?: string,
        error?: string,
    ): Promise<void> {
        if (!this.reportingEnabled || !this.mcpBridge) return;

        try {
            await this.mcpBridge.callTool('ruflo', 'task_update', {
                taskId,
                status,
                ...(result ? { result } : {}),
                ...(error ? { error } : {}),
            });
        } catch (err) {
            // Don't fail on reporting errors
            this.emit('report:error', 'task_update', err);
        }
    }

    /**
     * Clear all state.
     */
    clear(): void {
        this.tasks.clear();
        this.workers.clear();
    }
}

// ─── Singleton Instance ─────────────────────────────────────────

let instance: RuFloStatusReporter | null = null;

export function getStatusReporter(mcpBridge?: MCPToolBridge): RuFloStatusReporter {
    if (!instance) {
        instance = new RuFloStatusReporter(mcpBridge);
    } else if (mcpBridge) {
        instance.setMCPBridge(mcpBridge);
    }
    return instance;
}
