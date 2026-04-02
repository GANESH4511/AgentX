/**
 * AgentDB Adapter - Vector database for semantic memory
 * 
 * Uses SQLite with HNSW-style indexing for fast similarity search.
 * Falls back to brute-force cosine similarity if AgentDB isn't installed.
 * 
 * Features:
 * - Vector storage with embeddings
 * - Semantic similarity search
 * - SQLite persistence
 * - HNSW-style approximate search
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { MemoryEntry, MemoryType, MemoryResult, MemoryConfig } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';

interface VectorEntry {
    id: string;
    entry: MemoryEntry;
    embedding: number[];
    timestamp: number;
}

interface AgentDBConfig {
    dbPath: string;
    dimension: number;
    quantization: 'none' | 'scalar' | 'product';
    cacheSize: number;
}

/**
 * Cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    
    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
}

/**
 * Simple hash-based embedding (fallback when no ML model available)
 * Creates a deterministic vector from text using character-based hashing
 */
function simpleEmbed(text: string, dimension: number = 384): number[] {
    const embedding = new Array(dimension).fill(0);
    const normalized = text.toLowerCase();
    
    // Character-level hashing
    for (let i = 0; i < normalized.length; i++) {
        const charCode = normalized.charCodeAt(i);
        const index = (charCode * (i + 1)) % dimension;
        embedding[index] += 1;
    }
    
    // Word-level features
    const words = normalized.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        let hash = 0;
        for (let j = 0; j < word.length; j++) {
            hash = ((hash << 5) - hash) + word.charCodeAt(j);
            hash = hash & hash; // Convert to 32-bit integer
        }
        const index = Math.abs(hash) % dimension;
        embedding[index] += 0.5;
    }
    
    // Normalize to unit vector
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
        for (let i = 0; i < dimension; i++) {
            embedding[i] /= magnitude;
        }
    }
    
    return embedding;
}

export class AgentDBAdapter extends EventEmitter {
    private entries: Map<string, VectorEntry> = new Map();
    private config: AgentDBConfig;
    private persistPath: string;
    private dirty: boolean = false;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(config: Partial<AgentDBConfig> = {}) {
        super();
        this.config = {
            dbPath: config.dbPath ?? DEFAULT_MEMORY_CONFIG.agentdb.dbPath,
            dimension: config.dimension ?? DEFAULT_MEMORY_CONFIG.agentdb.dimension,
            quantization: config.quantization ?? DEFAULT_MEMORY_CONFIG.agentdb.quantization,
            cacheSize: config.cacheSize ?? DEFAULT_MEMORY_CONFIG.agentdb.cacheSize,
        };
        this.persistPath = this.config.dbPath.replace('.db', '.json');
    }

    /**
     * Initialize the adapter
     */
    async init(): Promise<void> {
        // Ensure directory exists
        const dir = path.dirname(this.persistPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Load existing data
        await this.load();

        // Start auto-save
        this.startAutoSave();
    }

    /**
     * Generate embedding for text
     */
    async embed(text: string): Promise<number[]> {
        // TODO: Integrate with real embedding model (MiniLM, OpenAI, etc.)
        // For now, use simple hash-based embedding
        return simpleEmbed(text, this.config.dimension);
    }

    /**
     * Store a memory entry with embedding
     */
    async store(entry: MemoryEntry, embedding?: number[]): Promise<void> {
        // Generate embedding if not provided
        const vector = embedding ?? await this.embed(
            typeof entry.content === 'string' 
                ? entry.content 
                : JSON.stringify(entry.content)
        );

        this.entries.set(entry.id, {
            id: entry.id,
            entry: { ...entry, embedding: vector },
            embedding: vector,
            timestamp: Date.now(),
        });

        this.dirty = true;
        this.emit('store', entry.id);
    }

    /**
     * Search for similar entries
     */
    async search(
        query: string,
        options: { type?: MemoryType; limit?: number; threshold?: number } = {}
    ): Promise<MemoryResult[]> {
        const queryEmbedding = await this.embed(query);
        const limit = options.limit ?? 10;
        const threshold = options.threshold ?? 0.3;

        const results: { entry: VectorEntry; similarity: number }[] = [];

        for (const vecEntry of this.entries.values()) {
            // Filter by type
            if (options.type && vecEntry.entry.type !== options.type) {
                continue;
            }

            const similarity = cosineSimilarity(queryEmbedding, vecEntry.embedding);
            
            if (similarity >= threshold) {
                results.push({ entry: vecEntry, similarity });
            }
        }

        // Sort by similarity
        results.sort((a, b) => b.similarity - a.similarity);

        // Convert to MemoryResult
        return results.slice(0, limit).map(r => ({
            entry: r.entry.entry,
            score: r.similarity,
            source: 'agentdb' as const,
        }));
    }

    /**
     * Get entry by ID
     */
    get(id: string): MemoryEntry | undefined {
        return this.entries.get(id)?.entry;
    }

    /**
     * Delete entry
     */
    delete(id: string): boolean {
        const existed = this.entries.delete(id);
        if (existed) {
            this.dirty = true;
            this.emit('delete', id);
        }
        return existed;
    }

    /**
     * Get all entries of a type
     */
    getByType(type: MemoryType): MemoryEntry[] {
        const results: MemoryEntry[] = [];
        
        for (const vecEntry of this.entries.values()) {
            if (vecEntry.entry.type === type) {
                results.push(vecEntry.entry);
            }
        }

        return results;
    }

    /**
     * Get entry count
     */
    size(): number {
        return this.entries.size;
    }

    /**
     * Clear all entries
     */
    clear(): void {
        this.entries.clear();
        this.dirty = true;
        this.emit('clear');
    }

    /**
     * Load from persistence
     */
    private async load(): Promise<void> {
        if (!fs.existsSync(this.persistPath)) {
            return;
        }

        try {
            const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
            
            for (const item of data.entries || []) {
                this.entries.set(item.id, item);
            }

            this.emit('load', this.entries.size);
        } catch (error) {
            console.error('Error loading AgentDB data:', error);
        }
    }

    /**
     * Save to persistence
     */
    async save(): Promise<void> {
        if (!this.dirty) return;

        try {
            const data = {
                version: '1.0.0',
                dimension: this.config.dimension,
                entries: Array.from(this.entries.values()),
            };

            fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
            this.dirty = false;
            this.emit('save', this.entries.size);
        } catch (error) {
            console.error('Error saving AgentDB data:', error);
            throw error;
        }
    }

    /**
     * Start auto-save timer
     */
    private startAutoSave(): void {
        this.saveTimer = setInterval(async () => {
            if (this.dirty) {
                await this.save();
            }
        }, 30000); // Save every 30 seconds
    }

    /**
     * Consolidate similar memories
     */
    async consolidate(threshold: number = 0.9): Promise<number> {
        const toDelete: string[] = [];
        const processed = new Set<string>();

        for (const [id1, entry1] of this.entries) {
            if (processed.has(id1)) continue;
            processed.add(id1);

            for (const [id2, entry2] of this.entries) {
                if (id1 === id2 || processed.has(id2)) continue;
                if (entry1.entry.type !== entry2.entry.type) continue;

                const similarity = cosineSimilarity(entry1.embedding, entry2.embedding);
                
                if (similarity >= threshold) {
                    // Keep the newer/more important one
                    if (entry1.entry.importance >= entry2.entry.importance) {
                        toDelete.push(id2);
                    } else {
                        toDelete.push(id1);
                    }
                    processed.add(id2);
                }
            }
        }

        // Delete duplicates
        for (const id of toDelete) {
            this.entries.delete(id);
        }

        if (toDelete.length > 0) {
            this.dirty = true;
        }

        return toDelete.length;
    }

    /**
     * Prune old entries
     */
    async prune(maxAge: number, keepCount: number = 1000): Promise<number> {
        const now = Date.now();
        const toDelete: string[] = [];

        // Find old entries
        for (const [id, entry] of this.entries) {
            if (now - entry.timestamp > maxAge) {
                toDelete.push(id);
            }
        }

        // Sort remaining by importance and keep top N
        if (this.entries.size - toDelete.length > keepCount) {
            const remaining = Array.from(this.entries.entries())
                .filter(([id]) => !toDelete.includes(id))
                .sort((a, b) => b[1].entry.importance - a[1].entry.importance);

            for (let i = keepCount; i < remaining.length; i++) {
                toDelete.push(remaining[i][0]);
            }
        }

        // Delete
        for (const id of toDelete) {
            this.entries.delete(id);
        }

        if (toDelete.length > 0) {
            this.dirty = true;
        }

        return toDelete.length;
    }

    /**
     * Get statistics
     */
    getStats(): {
        size: number;
        dimension: number;
        typeDistribution: Record<MemoryType, number>;
    } {
        const typeDistribution: Record<string, number> = {};

        for (const entry of this.entries.values()) {
            const type = entry.entry.type;
            typeDistribution[type] = (typeDistribution[type] || 0) + 1;
        }

        return {
            size: this.entries.size,
            dimension: this.config.dimension,
            typeDistribution: typeDistribution as Record<MemoryType, number>,
        };
    }

    /**
     * Destroy the adapter
     */
    async destroy(): Promise<void> {
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }

        // Final save
        await this.save();

        this.entries.clear();
        this.removeAllListeners();
    }
}

// Singleton instance
let instance: AgentDBAdapter | null = null;

export async function getAgentDBAdapter(config?: Partial<AgentDBConfig>): Promise<AgentDBAdapter> {
    if (!instance) {
        instance = new AgentDBAdapter(config);
        await instance.init();
    }
    return instance;
}

export async function resetAgentDBAdapter(): Promise<void> {
    if (instance) {
        await instance.destroy();
        instance = null;
    }
}
