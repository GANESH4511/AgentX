/**
 * Memory Router - Routes queries to appropriate memory layer
 * 
 * Architecture:
 * - KV Cache: Fast, recent context (<1ms)
 * - AgentDB: Semantic search (<100µs with HNSW)
 * - Archive: Historical data (~10ms)
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { KVCache, getKVCache } from './kv-cache.js';
import { AgentDBAdapter, getAgentDBAdapter } from './agentdb-adapter.js';
import type {
    MemoryEntry,
    MemoryType,
    MemoryQuery,
    MemoryResult,
    MemoryStoreOptions,
    MemoryConfig,
    TaskMemoryEntry,
    ConversationMemoryEntry,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';

interface ArchiveData {
    version: string;
    entries: MemoryEntry[];
}

export class MemoryRouter extends EventEmitter {
    private kvCache: KVCache;
    private agentDB: AgentDBAdapter | null = null;
    private archivePath: string;
    private config: MemoryConfig;
    private initialized: boolean = false;
    private consolidationTimer: NodeJS.Timeout | null = null;

    constructor(config: Partial<MemoryConfig> = {}) {
        super();
        this.config = {
            kv: { ...DEFAULT_MEMORY_CONFIG.kv, ...config.kv },
            agentdb: { ...DEFAULT_MEMORY_CONFIG.agentdb, ...config.agentdb },
            archive: { ...DEFAULT_MEMORY_CONFIG.archive, ...config.archive },
            consolidation: { ...DEFAULT_MEMORY_CONFIG.consolidation, ...config.consolidation },
        };
        this.kvCache = getKVCache(this.config.kv);
        this.archivePath = path.join(path.dirname(this.config.agentdb.dbPath), 'archive.json');
    }

    /**
     * Initialize the memory system
     */
    async init(): Promise<void> {
        if (this.initialized) return;

        // Initialize AgentDB
        this.agentDB = await getAgentDBAdapter(this.config.agentdb);

        // Ensure archive directory exists
        const archiveDir = path.dirname(this.archivePath);
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }

        // Start consolidation timer
        this.startConsolidation();

        this.initialized = true;
        this.emit('init');
    }

    /**
     * Store a memory entry
     */
    async remember(
        type: MemoryType,
        content: any,
        options: MemoryStoreOptions = {}
    ): Promise<string> {
        await this.ensureInitialized();

        const id = this.generateId(type);
        const entry: MemoryEntry = {
            id,
            type,
            content,
            timestamp: Date.now(),
            importance: options.importance ?? this.calculateImportance(type, content),
            metadata: options.metadata,
        };

        // Store in KV cache (hot storage)
        this.kvCache.set(id, entry);

        // Store in AgentDB (semantic storage) with embedding
        if (this.agentDB && options.generateEmbedding !== false) {
            const text = typeof content === 'string' ? content : JSON.stringify(content);
            await this.agentDB.store(entry);
        }

        this.emit('remember', entry);
        return id;
    }

    /**
     * Recall memories based on query
     */
    async recall(query: MemoryQuery): Promise<MemoryResult[]> {
        await this.ensureInitialized();

        const results: MemoryResult[] = [];
        const sources = query.sources ?? ['kv', 'agentdb', 'archive'];
        const limit = query.limit ?? 10;

        // Search KV cache (fastest)
        if (sources.includes('kv')) {
            const kvResults = this.kvCache.search(query.query, {
                type: Array.isArray(query.type) ? query.type[0] : query.type,
                limit,
            });
            results.push(...kvResults);
        }

        // Search AgentDB (semantic) with lower threshold for hash-based embeddings
        if (sources.includes('agentdb') && this.agentDB) {
            const agentResults = await this.agentDB.search(query.query, {
                type: Array.isArray(query.type) ? query.type[0] : query.type,
                limit,
                threshold: 0.1, // Lower threshold for hash-based embeddings
            });
            results.push(...agentResults);
        }

        // Search archive (historical)
        if (sources.includes('archive')) {
            const archiveResults = await this.searchArchive(query);
            results.push(...archiveResults);
        }

        // Dedupe by ID and sort by score
        const seen = new Set<string>();
        const deduped = results.filter(r => {
            if (seen.has(r.entry.id)) return false;
            seen.add(r.entry.id);
            return true;
        });

        // Filter by importance
        const filtered = deduped.filter(r => 
            r.entry.importance >= (query.minImportance ?? 0)
        );

        // Sort by score and limit
        return filtered
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Remember a completed task
     */
    async rememberTask(
        taskId: string,
        description: string,
        status: 'completed' | 'failed' | 'cancelled',
        details: {
            filesChanged?: string[];
            codePatterns?: string[];
            duration?: number;
            outcome?: string;
            error?: string;
        } = {}
    ): Promise<string> {
        return this.remember('task', {
            taskId,
            description,
            status,
            filesChanged: details.filesChanged ?? [],
            codePatterns: details.codePatterns ?? [],
            duration: details.duration ?? 0,
            outcome: details.outcome ?? '',
            error: details.error,
        }, {
            importance: status === 'completed' ? 0.8 : 0.5,
            metadata: { taskId },
        });
    }

    /**
     * Remember a conversation message
     */
    async rememberConversation(
        sessionId: string,
        role: 'user' | 'assistant',
        message: string,
        taskContext?: string
    ): Promise<string> {
        return this.remember('conversation', {
            sessionId,
            role,
            message,
            taskContext,
        }, {
            importance: role === 'user' ? 0.6 : 0.4,
            metadata: { sessionId },
        });
    }

    /**
     * Remember a code pattern
     */
    async rememberPattern(
        pattern: string,
        description: string,
        language: string,
        examples: string[] = []
    ): Promise<string> {
        return this.remember('code_pattern', {
            pattern,
            description,
            language,
            successRate: 1.0,
            usageCount: 1,
            examples,
        }, {
            importance: 0.7,
        });
    }

    /**
     * Get context for a new task (find similar past tasks)
     */
    async getTaskContext(description: string, limit: number = 3): Promise<MemoryResult[]> {
        return this.recall({
            query: description,
            type: 'task',
            limit,
            sources: ['agentdb', 'archive'],
        });
    }

    /**
     * Get recent conversation context
     */
    async getConversationContext(sessionId: string, limit: number = 10): Promise<MemoryEntry[]> {
        const results = this.kvCache.getByType('conversation');
        
        return results
            .filter(e => (e.content as any).sessionId === sessionId)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }

    /**
     * Search archive for historical data
     */
    private async searchArchive(query: MemoryQuery): Promise<MemoryResult[]> {
        if (!fs.existsSync(this.archivePath)) {
            return [];
        }

        try {
            const data: ArchiveData = JSON.parse(fs.readFileSync(this.archivePath, 'utf-8'));
            const queryLower = query.query.toLowerCase();
            const results: MemoryResult[] = [];

            for (const entry of data.entries) {
                // Filter by type
                if (query.type) {
                    const types = Array.isArray(query.type) ? query.type : [query.type];
                    if (!types.includes(entry.type)) continue;
                }

                // Filter by time range
                if (query.timeRange) {
                    if (query.timeRange.start && entry.timestamp < query.timeRange.start) continue;
                    if (query.timeRange.end && entry.timestamp > query.timeRange.end) continue;
                }

                // Simple keyword match
                const content = JSON.stringify(entry.content).toLowerCase();
                if (content.includes(queryLower)) {
                    // Score based on recency and importance
                    const age = Date.now() - entry.timestamp;
                    const recencyScore = Math.max(0, 1 - age / this.config.archive.maxAge);
                    const score = (entry.importance * 0.6) + (recencyScore * 0.4);

                    results.push({
                        entry,
                        score,
                        source: 'archive',
                    });
                }
            }

            return results;
        } catch (error) {
            console.error('Error searching archive:', error);
            return [];
        }
    }

    /**
     * Archive old memories from KV cache
     */
    async archiveOld(): Promise<number> {
        const entries = this.kvCache.export();
        if (entries.length === 0) return 0;

        // Load existing archive
        let archive: ArchiveData = { version: '1.0.0', entries: [] };
        if (fs.existsSync(this.archivePath)) {
            try {
                archive = JSON.parse(fs.readFileSync(this.archivePath, 'utf-8'));
            } catch { }
        }

        // Add entries with importance threshold
        let archived = 0;
        for (const entry of entries) {
            if (entry.importance >= this.config.consolidation.minImportance) {
                // Avoid duplicates
                if (!archive.entries.some(e => e.id === entry.id)) {
                    archive.entries.push(entry);
                    archived++;
                }
            }
        }

        // Prune old archive entries
        const now = Date.now();
        archive.entries = archive.entries.filter(e => 
            now - e.timestamp < this.config.archive.maxAge
        );

        // Keep under threshold
        if (archive.entries.length > this.config.archive.pruneThreshold) {
            archive.entries.sort((a, b) => b.importance - a.importance);
            archive.entries = archive.entries.slice(0, this.config.archive.pruneThreshold);
        }

        // Save archive
        fs.writeFileSync(this.archivePath, JSON.stringify(archive, null, 2));

        return archived;
    }

    /**
     * Start periodic consolidation
     */
    private startConsolidation(): void {
        this.consolidationTimer = setInterval(async () => {
            await this.consolidate();
        }, this.config.consolidation.interval);
    }

    /**
     * Consolidate memories (merge similar, prune old)
     */
    async consolidate(): Promise<{ archived: number; consolidated: number; pruned: number }> {
        const result = { archived: 0, consolidated: 0, pruned: 0 };

        try {
            // Archive important memories from KV cache
            result.archived = await this.archiveOld();

            // Consolidate similar memories in AgentDB
            if (this.agentDB) {
                result.consolidated = await this.agentDB.consolidate(0.9);
            }

            // Prune old entries in AgentDB
            if (this.agentDB) {
                result.pruned = await this.agentDB.prune(
                    this.config.archive.maxAge,
                    this.config.agentdb.cacheSize
                );
            }

            this.emit('consolidate', result);
        } catch (error) {
            console.error('Consolidation error:', error);
        }

        return result;
    }

    /**
     * Get memory statistics
     */
    getStats(): {
        kvCache: { size: number; maxItems: number };
        agentdb: { size: number; typeDistribution: Record<string, number> };
        archive: { size: number };
    } {
        const kvStats = this.kvCache.getStats();
        const agentStats = this.agentDB?.getStats() ?? { size: 0, dimension: 0, typeDistribution: {} };
        
        let archiveSize = 0;
        if (fs.existsSync(this.archivePath)) {
            try {
                const archive = JSON.parse(fs.readFileSync(this.archivePath, 'utf-8'));
                archiveSize = archive.entries?.length ?? 0;
            } catch { }
        }

        return {
            kvCache: { size: kvStats.size, maxItems: kvStats.maxItems },
            agentdb: { size: agentStats.size, typeDistribution: agentStats.typeDistribution },
            archive: { size: archiveSize },
        };
    }

    /**
     * Clear all memories
     */
    async clear(): Promise<void> {
        this.kvCache.clear();
        this.agentDB?.clear();
        
        if (fs.existsSync(this.archivePath)) {
            fs.unlinkSync(this.archivePath);
        }

        this.emit('clear');
    }

    /**
     * Generate unique ID for memory entry
     */
    private generateId(type: MemoryType): string {
        return `${type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    /**
     * Calculate importance based on type and content
     */
    private calculateImportance(type: MemoryType, content: any): number {
        switch (type) {
            case 'task':
                return content.status === 'completed' ? 0.8 : 0.5;
            case 'code_pattern':
                return 0.7;
            case 'decision':
                return 0.6;
            case 'conversation':
                return content.role === 'user' ? 0.5 : 0.4;
            case 'preference':
                return 0.3;
            default:
                return 0.5;
        }
    }

    /**
     * Ensure system is initialized
     */
    private async ensureInitialized(): Promise<void> {
        if (!this.initialized) {
            await this.init();
        }
    }

    /**
     * Destroy the memory system
     */
    async destroy(): Promise<void> {
        if (this.consolidationTimer) {
            clearInterval(this.consolidationTimer);
            this.consolidationTimer = null;
        }

        this.kvCache.destroy();
        await this.agentDB?.destroy();
        
        this.initialized = false;
        this.removeAllListeners();
    }
}

// Singleton instance
let instance: MemoryRouter | null = null;

export async function getMemoryRouter(config?: Partial<MemoryConfig>): Promise<MemoryRouter> {
    if (!instance) {
        instance = new MemoryRouter(config);
        await instance.init();
    }
    return instance;
}

export async function resetMemoryRouter(): Promise<void> {
    if (instance) {
        await instance.destroy();
        instance = null;
    }
}
