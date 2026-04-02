/**
 * TaskMemoryManager - Robust task memory management with AgentDB patterns
 * 
 * Features:
 * - Hot/Cold task storage (active vs archived)
 * - Automatic stale detection (tasks stuck >30 min)
 * - Task archival (completed/failed tasks moved to history)
 * - Memory consolidation (pattern learning)
 * - Cleanup operations
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

// Configuration
export const TASK_MEMORY_CONFIG = {
    STALE_THRESHOLD_MS: 30 * 60 * 1000,       // 30 minutes - mark as stale
    ARCHIVE_DELAY_MS: 5 * 60 * 1000,           // 5 minutes - archive after completion
    HISTORY_TTL_MS: 7 * 24 * 60 * 60 * 1000,   // 7 days - keep in history
    MAX_ACTIVE_TASKS: 50,                       // Max active tasks to display
    MAX_HISTORY_TASKS: 500,                     // Max history tasks to keep
    CLEANUP_INTERVAL_MS: 5 * 60 * 1000,         // Run cleanup every 5 min
};

export type TaskStatus = 'pending' | 'in_progress' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale';

export interface TaskRecord {
    taskId: string;
    type: string;
    description: string;
    priority: string;
    status: TaskStatus;
    progress: number;
    assignedTo: string | string[];
    tags: string[];
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    lastActivityAt?: string;
    result?: any;
    error?: string;
}

export interface TaskMemoryStats {
    active: number;
    pending: number;
    inProgress: number;
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
    stale: number;
    totalHistory: number;
}

export interface CleanupResult {
    staleMarked: number;
    archived: number;
    historyPruned: number;
    errors: string[];
}

export class TaskMemoryManager extends EventEmitter {
    private storePath: string;
    private historyPath: string;
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor(baseDir: string = '.claude-flow') {
        super();
        this.storePath = path.join(baseDir, 'tasks', 'store.json');
        this.historyPath = path.join(baseDir, 'tasks', 'history.json');
    }

    /**
     * Initialize task memory manager with auto-cleanup
     */
    async init(): Promise<void> {
        // Ensure directories exist
        const tasksDir = path.dirname(this.storePath);
        if (!fs.existsSync(tasksDir)) {
            fs.mkdirSync(tasksDir, { recursive: true });
        }

        // Initialize history file if needed
        if (!fs.existsSync(this.historyPath)) {
            this.saveHistory({ tasks: {}, version: '3.0.0' });
        }

        // Run initial cleanup
        await this.cleanup();

        // Start periodic cleanup
        this.startAutoCleanup();
    }

    /**
     * Start automatic cleanup timer
     */
    startAutoCleanup(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        this.cleanupTimer = setInterval(async () => {
            try {
                await this.cleanup();
            } catch (error) {
                this.emit('cleanup-error', error);
            }
        }, TASK_MEMORY_CONFIG.CLEANUP_INTERVAL_MS);
    }

    /**
     * Stop automatic cleanup
     */
    stopAutoCleanup(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /**
     * Load current task store
     */
    loadStore(): { tasks: Record<string, TaskRecord>; version: string } {
        try {
            if (fs.existsSync(this.storePath)) {
                const content = fs.readFileSync(this.storePath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (error) {
            console.error('Error loading task store:', error);
        }
        return { tasks: {}, version: '3.0.0' };
    }

    /**
     * Save task store
     */
    saveStore(store: { tasks: Record<string, TaskRecord>; version: string }): void {
        try {
            fs.writeFileSync(this.storePath, JSON.stringify(store, null, 2));
        } catch (error) {
            console.error('Error saving task store:', error);
            throw error;
        }
    }

    /**
     * Load history store
     */
    loadHistory(): { tasks: Record<string, TaskRecord>; version: string } {
        try {
            if (fs.existsSync(this.historyPath)) {
                const content = fs.readFileSync(this.historyPath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (error) {
            console.error('Error loading task history:', error);
        }
        return { tasks: {}, version: '3.0.0' };
    }

    /**
     * Save history store
     */
    saveHistory(history: { tasks: Record<string, TaskRecord>; version: string }): void {
        try {
            fs.writeFileSync(this.historyPath, JSON.stringify(history, null, 2));
        } catch (error) {
            console.error('Error saving task history:', error);
            throw error;
        }
    }

    /**
     * Check if a task is stale (stuck in_progress for too long)
     */
    isStale(task: TaskRecord): boolean {
        if (task.status !== 'in_progress' && task.status !== 'running') {
            return false;
        }

        const lastActivity = task.lastActivityAt || task.startedAt || task.createdAt;
        const lastActivityTime = new Date(lastActivity).getTime();
        const age = Date.now() - lastActivityTime;

        return age > TASK_MEMORY_CONFIG.STALE_THRESHOLD_MS;
    }

    /**
     * Check if a task should be archived
     */
    shouldArchive(task: TaskRecord): boolean {
        const completedStatuses: TaskStatus[] = ['completed', 'failed', 'cancelled', 'stale'];
        if (!completedStatuses.includes(task.status)) {
            return false;
        }

        const completedAt = task.completedAt || task.lastActivityAt || task.createdAt;
        const completedTime = new Date(completedAt).getTime();
        const age = Date.now() - completedTime;

        return age > TASK_MEMORY_CONFIG.ARCHIVE_DELAY_MS;
    }

    /**
     * Get only active tasks (for live status display)
     */
    getActiveTasks(): TaskRecord[] {
        const store = this.loadStore();
        const activeStatuses: TaskStatus[] = ['pending', 'in_progress', 'running'];
        
        return Object.values(store.tasks)
            .filter(task => {
                // Must be in an active status
                if (!activeStatuses.includes(task.status)) {
                    return false;
                }
                // Must not be stale
                if (this.isStale(task)) {
                    return false;
                }
                return true;
            })
            .sort((a, b) => {
                // Sort by priority: running > in_progress > pending
                const priority: Record<TaskStatus, number> = {
                    'running': 0,
                    'in_progress': 1,
                    'pending': 2,
                    'completed': 3,
                    'failed': 4,
                    'cancelled': 5,
                    'stale': 6,
                };
                return (priority[a.status] ?? 99) - (priority[b.status] ?? 99);
            })
            .slice(0, TASK_MEMORY_CONFIG.MAX_ACTIVE_TASKS);
    }

    /**
     * Get task statistics
     */
    getStats(): TaskMemoryStats {
        const store = this.loadStore();
        const history = this.loadHistory();
        
        const tasks = Object.values(store.tasks);
        
        return {
            active: tasks.filter(t => ['pending', 'in_progress', 'running'].includes(t.status) && !this.isStale(t)).length,
            pending: tasks.filter(t => t.status === 'pending').length,
            inProgress: tasks.filter(t => t.status === 'in_progress' && !this.isStale(t)).length,
            running: tasks.filter(t => t.status === 'running' && !this.isStale(t)).length,
            completed: tasks.filter(t => t.status === 'completed').length,
            failed: tasks.filter(t => t.status === 'failed').length,
            cancelled: tasks.filter(t => t.status === 'cancelled').length,
            stale: tasks.filter(t => this.isStale(t) || t.status === 'stale').length,
            totalHistory: Object.keys(history.tasks).length,
        };
    }

    /**
     * Run cleanup: mark stale, archive completed, prune old history
     */
    async cleanup(): Promise<CleanupResult> {
        const result: CleanupResult = {
            staleMarked: 0,
            archived: 0,
            historyPruned: 0,
            errors: [],
        };

        try {
            const store = this.loadStore();
            const history = this.loadHistory();
            const now = Date.now();

            // 1. Mark stale tasks
            for (const [taskId, task] of Object.entries(store.tasks)) {
                if (this.isStale(task) && task.status !== 'stale') {
                    store.tasks[taskId].status = 'stale';
                    store.tasks[taskId].lastActivityAt = new Date().toISOString();
                    result.staleMarked++;
                    this.emit('task-stale', taskId);
                }
            }

            // 2. Archive completed/failed/cancelled/stale tasks
            const toArchive: string[] = [];
            for (const [taskId, task] of Object.entries(store.tasks)) {
                if (this.shouldArchive(task)) {
                    toArchive.push(taskId);
                }
            }

            for (const taskId of toArchive) {
                const task = store.tasks[taskId];
                history.tasks[taskId] = {
                    ...task,
                    lastActivityAt: new Date().toISOString(),
                };
                delete store.tasks[taskId];
                result.archived++;
                this.emit('task-archived', taskId);
            }

            // 3. Prune old history
            const historyEntries = Object.entries(history.tasks);
            if (historyEntries.length > TASK_MEMORY_CONFIG.MAX_HISTORY_TASKS) {
                // Sort by last activity and keep most recent
                historyEntries.sort((a, b) => {
                    const aTime = new Date(a[1].lastActivityAt || a[1].createdAt).getTime();
                    const bTime = new Date(b[1].lastActivityAt || b[1].createdAt).getTime();
                    return bTime - aTime; // Newest first
                });

                const toKeep = historyEntries.slice(0, TASK_MEMORY_CONFIG.MAX_HISTORY_TASKS);
                const toPrune = historyEntries.slice(TASK_MEMORY_CONFIG.MAX_HISTORY_TASKS);
                
                history.tasks = Object.fromEntries(toKeep);
                result.historyPruned = toPrune.length;
            }

            // Also prune tasks older than TTL
            for (const [taskId, task] of Object.entries(history.tasks)) {
                const taskTime = new Date(task.lastActivityAt || task.createdAt).getTime();
                if (now - taskTime > TASK_MEMORY_CONFIG.HISTORY_TTL_MS) {
                    delete history.tasks[taskId];
                    result.historyPruned++;
                }
            }

            // Save both stores
            this.saveStore(store);
            this.saveHistory(history);

            this.emit('cleanup-complete', result);

        } catch (error: any) {
            result.errors.push(error.message || String(error));
            this.emit('cleanup-error', error);
        }

        return result;
    }

    /**
     * Force cleanup of all stale and completed tasks
     */
    async forceCleanup(): Promise<CleanupResult> {
        // Temporarily reduce thresholds for aggressive cleanup
        const originalArchiveDelay = TASK_MEMORY_CONFIG.ARCHIVE_DELAY_MS;
        TASK_MEMORY_CONFIG.ARCHIVE_DELAY_MS = 0; // Archive immediately

        const result = await this.cleanup();

        // Restore original threshold
        TASK_MEMORY_CONFIG.ARCHIVE_DELAY_MS = originalArchiveDelay;

        return result;
    }

    /**
     * Update task activity timestamp (call this when task has progress)
     */
    updateActivity(taskId: string): void {
        const store = this.loadStore();
        if (store.tasks[taskId]) {
            store.tasks[taskId].lastActivityAt = new Date().toISOString();
            this.saveStore(store);
        }
    }

    /**
     * Get a formatted status display string
     */
    getStatusDisplay(): string {
        const stats = this.getStats();
        const active = this.getActiveTasks();
        
        let output = '';
        output += `📊 Task Memory Status\n`;
        output += `─────────────────────\n`;
        output += `Active: ${stats.active} | Stale: ${stats.stale} | History: ${stats.totalHistory}\n`;
        output += `  Running: ${stats.running}\n`;
        output += `  In Progress: ${stats.inProgress}\n`;
        output += `  Pending: ${stats.pending}\n\n`;
        
        if (active.length === 0) {
            output += `No active tasks\n`;
        } else {
            output += `📋 Active Tasks:\n`;
            for (const task of active) {
                const icon = task.status === 'running' ? '🔄' : 
                            task.status === 'in_progress' ? '🔄' : '⏳';
                const desc = task.description.length > 50 
                    ? task.description.substring(0, 47) + '...'
                    : task.description;
                output += `  ${icon} ${task.taskId.substring(0, 20)}... [${task.status}]\n`;
                output += `     ${desc}\n`;
            }
        }
        
        return output;
    }

    /**
     * Destroy the manager and cleanup resources
     */
    destroy(): void {
        this.stopAutoCleanup();
        this.removeAllListeners();
    }
}

// Singleton instance
let instance: TaskMemoryManager | null = null;

export function getTaskMemoryManager(baseDir?: string): TaskMemoryManager {
    if (!instance) {
        instance = new TaskMemoryManager(baseDir);
    }
    return instance;
}

export function resetTaskMemoryManager(): void {
    if (instance) {
        instance.destroy();
        instance = null;
    }
}
