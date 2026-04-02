/**
 * AgentX — Task Queue
 * 
 * Priority-based task queue for distributing work to swarm agents.
 * 
 * Features:
 *   - Priority levels (critical > high > normal > low)
 *   - Task lifecycle: pending → assigned → running → completed/failed
 *   - Dependency tracking (task B waits for task A)
 *   - Retry with backoff
 *   - Event emission for status changes
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low';
export type TaskStatus = 'pending' | 'assigned' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface TaskDefinition {
  /** Human-readable description of the work */
  description: string;
  /** The prompt/instruction to send to the sub-agent */
  prompt: string;
  /** Priority level (affects ordering) */
  priority?: TaskPriority;
  /** Preferred model tier for this task (1=fast, 2=default, 3=complex) */
  tier?: 1 | 2 | 3;
  /** Role hint for the sub-agent (e.g., "coder", "tester", "reviewer") */
  role?: string;
  /** IDs of tasks this depends on (must complete first) */
  dependsOn?: string[];
  /** Maximum attempts before marking as failed */
  maxRetries?: number;
  /** Timeout in ms (default: 5 minutes) */
  timeoutMs?: number;
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface Task extends TaskDefinition {
  id: string;
  status: TaskStatus;
  assignedTo?: string;        // agent ID
  result?: string;            // output from the agent
  error?: string;             // error message if failed
  attempts: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface TaskQueueStats {
  total: number;
  pending: number;
  assigned: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

// ─── Priority weights for sorting ───────────────────────────────

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// ─── Task Queue ─────────────────────────────────────────────────

export class TaskQueue extends EventEmitter {
  private tasks: Map<string, Task> = new Map();

  /**
   * Add a new task to the queue.
   * Returns the generated task ID.
   */
  enqueue(def: TaskDefinition): string {
    const id = randomUUID().slice(0, 8);

    const task: Task = {
      ...def,
      id,
      priority: def.priority ?? 'normal',
      tier: def.tier ?? 2,
      maxRetries: def.maxRetries ?? 2,
      timeoutMs: def.timeoutMs ?? 5 * 60 * 1000,
      dependsOn: def.dependsOn ?? [],
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
    };

    this.tasks.set(id, task);
    this.emit('task:enqueued', task);
    return id;
  }

  /**
   * Add multiple tasks at once. Returns their IDs.
   */
  enqueueBatch(defs: TaskDefinition[]): string[] {
    return defs.map(def => this.enqueue(def));
  }

  /**
   * Get the next available task (highest priority, dependencies met).
   * Returns null if no tasks are ready.
   */
  dequeue(): Task | null {
    const ready = this.getReadyTasks();
    if (ready.length === 0) return null;

    // Sort by priority, then by creation time (FIFO within same priority)
    ready.sort((a, b) => {
      const pa = PRIORITY_WEIGHT[a.priority ?? 'normal'];
      const pb = PRIORITY_WEIGHT[b.priority ?? 'normal'];
      if (pa !== pb) return pa - pb;
      return a.createdAt - b.createdAt;
    });

    const task = ready[0];
    task.status = 'assigned';
    this.emit('task:assigned', task);
    return task;
  }

  /**
   * Mark a task as running (agent has started work).
   */
  markRunning(taskId: string, agentId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'running';
    task.assignedTo = agentId;
    task.startedAt = Date.now();
    task.attempts++;
    this.emit('task:running', task);
  }

  /**
   * Mark a task as completed with its result.
   */
  markCompleted(taskId: string, result: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();
    this.emit('task:completed', task);
  }

  /**
   * Mark a task as failed. Will re-queue if retries remain.
   * Returns true if task was re-queued, false if permanently failed.
   */
  markFailed(taskId: string, error: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    task.error = error;

    if (task.attempts < (task.maxRetries ?? 2)) {
      // Re-queue for retry
      task.status = 'pending';
      task.assignedTo = undefined;
      task.startedAt = undefined;
      this.emit('task:retrying', task);
      return true;
    }

    // Permanently failed
    task.status = 'failed';
    task.completedAt = Date.now();
    this.emit('task:failed', task);
    return false;
  }

  /**
   * Cancel a task (only pending or assigned tasks can be cancelled).
   */
  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'completed' || task.status === 'failed') return false;

    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.emit('task:cancelled', task);
    return true;
  }

  /**
   * Get a task by ID.
   */
  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get all tasks that are ready to run
   * (pending + all dependencies completed).
   */
  getReadyTasks(): Task[] {
    const ready: Task[] = [];

    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;

      // Check if all dependencies are completed
      const depsReady = (task.dependsOn ?? []).every(depId => {
        const dep = this.tasks.get(depId);
        return dep?.status === 'completed';
      });

      if (depsReady) {
        ready.push(task);
      }
    }

    return ready;
  }

  /**
   * Get queue statistics.
   */
  getStats(): TaskQueueStats {
    const stats: TaskQueueStats = {
      total: 0,
      pending: 0,
      assigned: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const task of this.tasks.values()) {
      stats.total++;
      stats[task.status]++;
    }

    return stats;
  }

  /**
   * Get all tasks, optionally filtered by status.
   */
  list(status?: TaskStatus): Task[] {
    const tasks = Array.from(this.tasks.values());
    if (status) return tasks.filter(t => t.status === status);
    return tasks;
  }

  /**
   * Check if the queue has finished (no pending/assigned/running tasks).
   */
  isFinished(): boolean {
    for (const task of this.tasks.values()) {
      if (['pending', 'assigned', 'running'].includes(task.status)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get results from all completed tasks, keyed by task ID.
   */
  getResults(): Map<string, string> {
    const results = new Map<string, string>();
    for (const task of this.tasks.values()) {
      if (task.status === 'completed' && task.result) {
        results.set(task.id, task.result);
      }
    }
    return results;
  }

  /**
   * Clear all tasks.
   */
  clear(): void {
    this.tasks.clear();
    this.emit('queue:cleared');
  }
}
