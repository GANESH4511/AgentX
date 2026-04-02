/**
 * AgentX — KV Cache for Persistent Session Memory
 * 
 * A simple key-value cache that persists data to disk.
 * Used to maintain conversation context and state across sessions.
 * 
 * Features:
 *   - File-based persistence (JSON)
 *   - TTL (time-to-live) support
 *   - Namespace support for organizing keys
 *   - Automatic cleanup of expired entries
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
    value: T;
    createdAt: number;
    expiresAt?: number;
    namespace?: string;
    tags?: string[];
}

export interface KVCacheConfig {
    /** Path to the cache file. Default: ~/.agentx/cache.json */
    cachePath?: string;
    /** Default TTL in milliseconds. 0 = no expiration */
    defaultTTL?: number;
    /** Auto-save on every write. Default: true */
    autoSave?: boolean;
    /** Auto-cleanup expired entries on load. Default: true */
    autoCleanup?: boolean;
}

export interface CacheStats {
    totalEntries: number;
    namespaces: string[];
    oldestEntry: number | null;
    newestEntry: number | null;
    sizeBytes: number;
}

// ─── KV Cache Implementation ────────────────────────────────────

export class KVCache {
    private cache: Map<string, CacheEntry> = new Map();
    private config: Required<KVCacheConfig>;
    private dirty = false;

    constructor(config: KVCacheConfig = {}) {
        this.config = {
            cachePath: config.cachePath ?? join(homedir(), '.agentx', 'cache.json'),
            defaultTTL: config.defaultTTL ?? 0,
            autoSave: config.autoSave ?? true,
            autoCleanup: config.autoCleanup ?? true,
        };

        this.load();
    }

    /**
     * Get a value from the cache.
     * Returns undefined if not found or expired.
     */
    get<T = unknown>(key: string, namespace?: string): T | undefined {
        const fullKey = this.makeKey(key, namespace);
        const entry = this.cache.get(fullKey);

        if (!entry) return undefined;

        // Check expiration
        if (entry.expiresAt && entry.expiresAt < Date.now()) {
            this.cache.delete(fullKey);
            this.markDirty();
            return undefined;
        }

        return entry.value as T;
    }

    /**
     * Set a value in the cache.
     */
    set<T>(
        key: string,
        value: T,
        options: { ttl?: number; namespace?: string; tags?: string[] } = {},
    ): void {
        const fullKey = this.makeKey(key, options.namespace);
        const ttl = options.ttl ?? this.config.defaultTTL;

        const entry: CacheEntry<T> = {
            value,
            createdAt: Date.now(),
            expiresAt: ttl > 0 ? Date.now() + ttl : undefined,
            namespace: options.namespace,
            tags: options.tags,
        };

        this.cache.set(fullKey, entry);
        this.markDirty();

        if (this.config.autoSave) {
            this.save();
        }
    }

    /**
     * Delete a key from the cache.
     */
    delete(key: string, namespace?: string): boolean {
        const fullKey = this.makeKey(key, namespace);
        const deleted = this.cache.delete(fullKey);
        
        if (deleted) {
            this.markDirty();
            if (this.config.autoSave) {
                this.save();
            }
        }
        
        return deleted;
    }

    /**
     * Check if a key exists and is not expired.
     */
    has(key: string, namespace?: string): boolean {
        return this.get(key, namespace) !== undefined;
    }

    /**
     * List all keys, optionally filtered by namespace or tags.
     */
    list(options: { namespace?: string; tag?: string; limit?: number } = {}): string[] {
        const keys: string[] = [];

        for (const [fullKey, entry] of this.cache.entries()) {
            // Check expiration
            if (entry.expiresAt && entry.expiresAt < Date.now()) {
                continue;
            }

            // Filter by namespace
            if (options.namespace && entry.namespace !== options.namespace) {
                continue;
            }

            // Filter by tag
            if (options.tag && (!entry.tags || !entry.tags.includes(options.tag))) {
                continue;
            }

            const actualKey = entry.namespace
                ? fullKey.slice(entry.namespace.length + 1)
                : fullKey;
            keys.push(actualKey);

            if (options.limit && keys.length >= options.limit) {
                break;
            }
        }

        return keys;
    }

    /**
     * Get all entries in a namespace.
     */
    getNamespace<T = unknown>(namespace: string): Map<string, T> {
        const result = new Map<string, T>();

        for (const [fullKey, entry] of this.cache.entries()) {
            if (entry.namespace !== namespace) continue;
            if (entry.expiresAt && entry.expiresAt < Date.now()) continue;

            const actualKey = fullKey.slice(namespace.length + 1);
            result.set(actualKey, entry.value as T);
        }

        return result;
    }

    /**
     * Clear all entries, optionally filtered by namespace.
     */
    clear(namespace?: string): number {
        let deleted = 0;

        if (namespace) {
            for (const [fullKey, entry] of this.cache.entries()) {
                if (entry.namespace === namespace) {
                    this.cache.delete(fullKey);
                    deleted++;
                }
            }
        } else {
            deleted = this.cache.size;
            this.cache.clear();
        }

        if (deleted > 0) {
            this.markDirty();
            if (this.config.autoSave) {
                this.save();
            }
        }

        return deleted;
    }

    /**
     * Remove all expired entries.
     */
    cleanup(): number {
        const now = Date.now();
        let removed = 0;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.expiresAt && entry.expiresAt < now) {
                this.cache.delete(key);
                removed++;
            }
        }

        if (removed > 0) {
            this.markDirty();
            if (this.config.autoSave) {
                this.save();
            }
        }

        return removed;
    }

    /**
     * Get cache statistics.
     */
    getStats(): CacheStats {
        let oldest: number | null = null;
        let newest: number | null = null;
        const namespaces = new Set<string>();

        for (const entry of this.cache.values()) {
            if (entry.namespace) {
                namespaces.add(entry.namespace);
            }
            if (oldest === null || entry.createdAt < oldest) {
                oldest = entry.createdAt;
            }
            if (newest === null || entry.createdAt > newest) {
                newest = entry.createdAt;
            }
        }

        const jsonStr = JSON.stringify(this.toJSON());
        const sizeBytes = Buffer.byteLength(jsonStr, 'utf-8');

        return {
            totalEntries: this.cache.size,
            namespaces: Array.from(namespaces),
            oldestEntry: oldest,
            newestEntry: newest,
            sizeBytes,
        };
    }

    /**
     * Load cache from disk.
     */
    load(): void {
        try {
            if (existsSync(this.config.cachePath)) {
                const content = readFileSync(this.config.cachePath, 'utf-8');
                const data = JSON.parse(content) as Record<string, CacheEntry>;
                
                this.cache.clear();
                for (const [key, entry] of Object.entries(data)) {
                    this.cache.set(key, entry);
                }

                if (this.config.autoCleanup) {
                    this.cleanup();
                }
            }
        } catch {
            this.cache.clear();
        }
        
        this.dirty = false;
    }

    /**
     * Save cache to disk.
     */
    save(): void {
        if (!this.dirty) return;

        try {
            const dir = dirname(this.config.cachePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            const content = JSON.stringify(this.toJSON(), null, 2);
            writeFileSync(this.config.cachePath, content, 'utf-8');
            this.dirty = false;
        } catch {
            // Silently fail - cache is in-memory anyway
        }
    }

    /**
     * Force save (even if not dirty).
     */
    forceSave(): void {
        this.dirty = true;
        this.save();
    }

    private toJSON(): Record<string, CacheEntry> {
        const obj: Record<string, CacheEntry> = {};
        for (const [key, entry] of this.cache.entries()) {
            obj[key] = entry;
        }
        return obj;
    }

    private makeKey(key: string, namespace?: string): string {
        return namespace ? `${namespace}:${key}` : key;
    }

    private markDirty(): void {
        this.dirty = true;
    }
}

// ─── Singleton Instance ─────────────────────────────────────────

let defaultCache: KVCache | null = null;

export function getKVCache(config?: KVCacheConfig): KVCache {
    if (!defaultCache) {
        defaultCache = new KVCache(config);
    }
    return defaultCache;
}

export function resetKVCache(): void {
    defaultCache = null;
}

// ─── Convenience Functions ──────────────────────────────────────

export function remember(
    key: string,
    value: unknown,
    options: { ttl?: number; namespace?: string } = {},
): void {
    const cache = getKVCache();
    cache.set(key, value, { namespace: options.namespace ?? 'session', ttl: options.ttl });
}

export function recall<T = unknown>(key: string, namespace?: string): T | undefined {
    const cache = getKVCache();
    return cache.get<T>(key, namespace ?? 'session');
}

export function forget(key: string, namespace?: string): boolean {
    const cache = getKVCache();
    return cache.delete(key, namespace ?? 'session');
}

export function saveConversation(sessionId: string, messages: unknown[]): void {
    const cache = getKVCache();
    cache.set(`conversation:${sessionId}`, {
        messages,
        savedAt: Date.now(),
    }, { namespace: 'conversations', ttl: 7 * 24 * 60 * 60 * 1000 }); // 7 days
}

export function loadConversation(sessionId: string): unknown[] | undefined {
    const cache = getKVCache();
    const data = cache.get<{ messages: unknown[] }>(`conversation:${sessionId}`, 'conversations');
    return data?.messages;
}
