/**
 * KV Cache - In-memory LRU cache for immediate context
 * 
 * Features:
 * - LRU (Least Recently Used) eviction
 * - TTL (Time-To-Live) expiration
 * - O(1) get/set operations
 * - Automatic cleanup
 */

import { EventEmitter } from 'events';
import type { MemoryEntry, MemoryType, MemoryResult } from './types.js';

interface CacheEntry {
    value: MemoryEntry;
    timestamp: number;
    accessCount: number;
}

interface KVCacheConfig {
    maxItems: number;
    ttlMs: number;
    cleanupInterval?: number;
}

export class KVCache extends EventEmitter {
    private cache: Map<string, CacheEntry> = new Map();
    private accessOrder: string[] = [];
    private config: KVCacheConfig;
    private cleanupTimer: NodeJS.Timeout | null = null;

    constructor(config: Partial<KVCacheConfig> = {}) {
        super();
        this.config = {
            maxItems: config.maxItems ?? 100,
            ttlMs: config.ttlMs ?? 30 * 60 * 1000,
            cleanupInterval: config.cleanupInterval ?? 60 * 1000,
        };
        this.startCleanup();
    }

    /**
     * Store a memory entry
     */
    set(key: string, entry: MemoryEntry): void {
        // Remove old entry if exists
        if (this.cache.has(key)) {
            this.accessOrder = this.accessOrder.filter(k => k !== key);
        }

        // Evict if at capacity
        while (this.cache.size >= this.config.maxItems) {
            this.evictLRU();
        }

        // Store new entry
        this.cache.set(key, {
            value: entry,
            timestamp: Date.now(),
            accessCount: 0,
        });
        this.accessOrder.push(key);
        
        this.emit('set', key, entry);
    }

    /**
     * Retrieve a memory entry
     */
    get(key: string): MemoryEntry | undefined {
        const entry = this.cache.get(key);
        if (!entry) return undefined;

        // Check TTL
        if (Date.now() - entry.timestamp > this.config.ttlMs) {
            this.delete(key);
            return undefined;
        }

        // Update access
        entry.accessCount++;
        this.accessOrder = this.accessOrder.filter(k => k !== key);
        this.accessOrder.push(key);

        return entry.value;
    }

    /**
     * Delete a memory entry
     */
    delete(key: string): boolean {
        const existed = this.cache.delete(key);
        if (existed) {
            this.accessOrder = this.accessOrder.filter(k => k !== key);
            this.emit('delete', key);
        }
        return existed;
    }

    /**
     * Check if key exists
     */
    has(key: string): boolean {
        const entry = this.cache.get(key);
        if (!entry) return false;
        
        // Check TTL
        if (Date.now() - entry.timestamp > this.config.ttlMs) {
            this.delete(key);
            return false;
        }
        return true;
    }

    /**
     * Search cache by query (simple keyword match)
     */
    search(query: string, options: { type?: MemoryType; limit?: number } = {}): MemoryResult[] {
        const results: MemoryResult[] = [];
        const queryLower = query.toLowerCase();
        const limit = options.limit ?? 10;

        for (const [key, entry] of this.cache.entries()) {
            // Skip expired
            if (Date.now() - entry.timestamp > this.config.ttlMs) {
                continue;
            }

            // Filter by type
            if (options.type && entry.value.type !== options.type) {
                continue;
            }

            // Simple keyword matching
            const content = JSON.stringify(entry.value.content).toLowerCase();
            if (content.includes(queryLower)) {
                // Score based on recency and importance
                const recencyScore = 1 - (Date.now() - entry.timestamp) / this.config.ttlMs;
                const score = (entry.value.importance * 0.5) + (recencyScore * 0.5);
                
                results.push({
                    entry: entry.value,
                    score,
                    source: 'kv',
                });
            }
        }

        // Sort by score and limit
        return results
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Get all entries of a type
     */
    getByType(type: MemoryType): MemoryEntry[] {
        const results: MemoryEntry[] = [];
        
        for (const entry of this.cache.values()) {
            if (entry.value.type === type) {
                // Skip expired
                if (Date.now() - entry.timestamp <= this.config.ttlMs) {
                    results.push(entry.value);
                }
            }
        }

        return results;
    }

    /**
     * Get recent entries
     */
    getRecent(limit: number = 10): MemoryEntry[] {
        const results: MemoryEntry[] = [];
        
        // Access order is oldest to newest, so reverse
        for (let i = this.accessOrder.length - 1; i >= 0 && results.length < limit; i--) {
            const key = this.accessOrder[i];
            const entry = this.cache.get(key);
            if (entry && Date.now() - entry.timestamp <= this.config.ttlMs) {
                results.push(entry.value);
            }
        }

        return results;
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.cache.clear();
        this.accessOrder = [];
        this.emit('clear');
    }

    /**
     * Get cache statistics
     */
    getStats(): { size: number; maxItems: number; oldestAge: number } {
        let oldestAge = 0;
        const now = Date.now();

        for (const entry of this.cache.values()) {
            const age = now - entry.timestamp;
            if (age > oldestAge) {
                oldestAge = age;
            }
        }

        return {
            size: this.cache.size,
            maxItems: this.config.maxItems,
            oldestAge,
        };
    }

    /**
     * Export all entries (for persistence)
     */
    export(): MemoryEntry[] {
        const entries: MemoryEntry[] = [];
        
        for (const entry of this.cache.values()) {
            if (Date.now() - entry.timestamp <= this.config.ttlMs) {
                entries.push(entry.value);
            }
        }

        return entries;
    }

    /**
     * Import entries (restore from persistence)
     */
    import(entries: MemoryEntry[]): void {
        for (const entry of entries) {
            this.set(entry.id, entry);
        }
    }

    /**
     * Evict least recently used entry
     */
    private evictLRU(): void {
        if (this.accessOrder.length === 0) return;
        
        const key = this.accessOrder.shift()!;
        const entry = this.cache.get(key);
        this.cache.delete(key);
        
        if (entry) {
            this.emit('evict', key, entry.value);
        }
    }

    /**
     * Start automatic cleanup of expired entries
     */
    private startCleanup(): void {
        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, this.config.cleanupInterval);
    }

    /**
     * Clean up expired entries
     */
    private cleanup(): void {
        const now = Date.now();
        const expired: string[] = [];

        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.config.ttlMs) {
                expired.push(key);
            }
        }

        for (const key of expired) {
            this.delete(key);
        }

        if (expired.length > 0) {
            this.emit('cleanup', expired.length);
        }
    }

    /**
     * Destroy the cache and cleanup resources
     */
    destroy(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.clear();
        this.removeAllListeners();
    }
}

// Singleton instance
let instance: KVCache | null = null;

export function getKVCache(config?: Partial<KVCacheConfig>): KVCache {
    if (!instance) {
        instance = new KVCache(config);
    }
    return instance;
}

export function resetKVCache(): void {
    if (instance) {
        instance.destroy();
        instance = null;
    }
}
