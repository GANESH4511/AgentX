/**
 * AgentX — Change Tracker & Undo System
 * 
 * Tracks file modifications made by agents and allows rollback.
 * Integrates with write-file and edit-file tools.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────

export interface FileChange {
    id: string;
    path: string;
    absolutePath: string;
    operation: 'create' | 'update' | 'delete';
    originalContent: string | null;  // null means file didn't exist
    newContent: string;
    timestamp: number;
    agentId?: string;
    taskId?: string;
}

export interface UndoResult {
    success: boolean;
    change: FileChange;
    error?: string;
}

// ─── Change Tracker ─────────────────────────────────────────────

export class ChangeTracker {
    private changes: FileChange[] = [];
    private workingDir: string;
    private maxChanges: number;
    private persistPath: string;

    constructor(options?: {
        workingDir?: string;
        maxChanges?: number;
        persistPath?: string;
    }) {
        this.workingDir = options?.workingDir ?? process.cwd();
        this.maxChanges = options?.maxChanges ?? 100;
        this.persistPath = options?.persistPath ?? 
            join(homedir(), '.agentx', 'undo-history.json');
        
        // Load existing changes if persistence is enabled
        this.loadChanges();
    }

    /**
     * Track a file being created.
     */
    trackCreate(
        path: string,
        content: string,
        agentId?: string,
        taskId?: string,
    ): void {
        const absolutePath = this.resolvePath(path);
        
        const change: FileChange = {
            id: this.generateId(),
            path,
            absolutePath,
            operation: 'create',
            originalContent: null,  // File didn't exist before
            newContent: content,
            timestamp: Date.now(),
            agentId,
            taskId,
        };

        this.addChange(change);
    }

    /**
     * Track a file being updated.
     */
    trackUpdate(
        path: string,
        originalContent: string,
        newContent: string,
        agentId?: string,
        taskId?: string,
    ): void {
        const absolutePath = this.resolvePath(path);

        const change: FileChange = {
            id: this.generateId(),
            path,
            absolutePath,
            operation: 'update',
            originalContent,
            newContent,
            timestamp: Date.now(),
            agentId,
            taskId,
        };

        this.addChange(change);
    }

    /**
     * Track a file before modification (auto-detect create vs update).
     */
    trackBeforeWrite(
        path: string,
        newContent: string,
        agentId?: string,
        taskId?: string,
    ): void {
        const absolutePath = this.resolvePath(path);
        
        if (existsSync(absolutePath)) {
            // File exists - it's an update
            try {
                const originalContent = readFileSync(absolutePath, 'utf-8');
                this.trackUpdate(path, originalContent, newContent, agentId, taskId);
            } catch {
                // Can't read, treat as create
                this.trackCreate(path, newContent, agentId, taskId);
            }
        } else {
            // File doesn't exist - it's a create
            this.trackCreate(path, newContent, agentId, taskId);
        }
    }

    /**
     * Undo the last change.
     */
    undoLast(): UndoResult | null {
        if (this.changes.length === 0) {
            return null;
        }

        const change = this.changes.pop()!;
        return this.applyUndo(change);
    }

    /**
     * Undo multiple changes.
     */
    undoN(count: number): UndoResult[] {
        const results: UndoResult[] = [];
        
        for (let i = 0; i < count && this.changes.length > 0; i++) {
            const result = this.undoLast();
            if (result) {
                results.push(result);
            }
        }

        return results;
    }

    /**
     * Undo all changes in session.
     */
    undoAll(): UndoResult[] {
        return this.undoN(this.changes.length);
    }

    /**
     * Undo a specific change by ID.
     */
    undoById(id: string): UndoResult | null {
        const index = this.changes.findIndex(c => c.id === id);
        if (index === -1) {
            return null;
        }

        const change = this.changes.splice(index, 1)[0];
        return this.applyUndo(change);
    }

    /**
     * Get list of changes (most recent first).
     */
    listChanges(limit?: number): FileChange[] {
        const changes = [...this.changes].reverse();
        return limit ? changes.slice(0, limit) : changes;
    }

    /**
     * Get number of changes.
     */
    getChangeCount(): number {
        return this.changes.length;
    }

    /**
     * Clear all tracked changes (without undoing).
     */
    clear(): void {
        this.changes = [];
        this.saveChanges();
    }

    /**
     * Apply an undo operation.
     */
    private applyUndo(change: FileChange): UndoResult {
        try {
            if (change.operation === 'create') {
                // File was created - delete it
                if (existsSync(change.absolutePath)) {
                    unlinkSync(change.absolutePath);
                }
            } else if (change.operation === 'update') {
                // File was updated - restore original content
                if (change.originalContent !== null) {
                    // Ensure directory exists
                    const dir = dirname(change.absolutePath);
                    if (!existsSync(dir)) {
                        mkdirSync(dir, { recursive: true });
                    }
                    writeFileSync(change.absolutePath, change.originalContent, 'utf-8');
                }
            }

            this.saveChanges();
            
            return {
                success: true,
                change,
            };
        } catch (error: any) {
            return {
                success: false,
                change,
                error: error.message || String(error),
            };
        }
    }

    /**
     * Add a change to the stack.
     */
    private addChange(change: FileChange): void {
        this.changes.push(change);

        // Trim if over max
        if (this.changes.length > this.maxChanges) {
            this.changes = this.changes.slice(-this.maxChanges);
        }

        this.saveChanges();
    }

    /**
     * Resolve a path relative to working directory.
     */
    private resolvePath(path: string): string {
        if (path.startsWith('/') || path.match(/^[A-Za-z]:\\/)) {
            return resolve(path);
        }
        return resolve(this.workingDir, path);
    }

    /**
     * Generate a unique change ID.
     */
    private generateId(): string {
        return `chg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    /**
     * Save changes to disk.
     */
    private saveChanges(): void {
        try {
            const dir = dirname(this.persistPath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
            writeFileSync(this.persistPath, JSON.stringify(this.changes, null, 2), 'utf-8');
        } catch {
            // Silently fail - persistence is optional
        }
    }

    /**
     * Load changes from disk.
     */
    private loadChanges(): void {
        try {
            if (existsSync(this.persistPath)) {
                const data = readFileSync(this.persistPath, 'utf-8');
                this.changes = JSON.parse(data);
            }
        } catch {
            this.changes = [];
        }
    }
}

// ─── Singleton Instance ─────────────────────────────────────────

let instance: ChangeTracker | null = null;

export function getChangeTracker(options?: {
    workingDir?: string;
    maxChanges?: number;
}): ChangeTracker {
    if (!instance) {
        instance = new ChangeTracker(options);
    }
    return instance;
}

/**
 * Format a change for display.
 */
export function formatChange(change: FileChange): string {
    const age = Math.round((Date.now() - change.timestamp) / 1000);
    const ageStr = age < 60 ? `${age}s ago` : 
                   age < 3600 ? `${Math.round(age / 60)}m ago` :
                   `${Math.round(age / 3600)}h ago`;
    
    const icon = change.operation === 'create' ? '➕' :
                 change.operation === 'update' ? '✏️' : '🗑️';
    
    return `${icon} ${change.path} (${ageStr})`;
}
