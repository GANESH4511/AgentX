/**
 * Memory System Types
 * 
 * Type definitions for the cross-session memory system.
 */

export type MemoryType = 'task' | 'conversation' | 'code_pattern' | 'decision' | 'preference';
export type MemorySource = 'kv' | 'agentdb' | 'archive';

/**
 * Base memory entry
 */
export interface MemoryEntry {
    id: string;
    type: MemoryType;
    content: any;
    timestamp: number;
    importance: number;  // 0-1 scale
    embedding?: number[];
    metadata?: Record<string, any>;
}

/**
 * Task memory - remembers completed tasks
 */
export interface TaskMemoryEntry extends MemoryEntry {
    type: 'task';
    content: {
        taskId: string;
        description: string;
        status: 'completed' | 'failed' | 'cancelled';
        filesChanged: string[];
        codePatterns: string[];
        duration: number;
        outcome: string;
        error?: string;
    };
}

/**
 * Conversation memory - remembers chat context
 */
export interface ConversationMemoryEntry extends MemoryEntry {
    type: 'conversation';
    content: {
        sessionId: string;
        role: 'user' | 'assistant';
        message: string;
        taskContext?: string;
    };
}

/**
 * Code pattern memory - remembers successful patterns
 */
export interface CodePatternMemoryEntry extends MemoryEntry {
    type: 'code_pattern';
    content: {
        pattern: string;
        description: string;
        language: string;
        successRate: number;
        usageCount: number;
        examples: string[];
    };
}

/**
 * Decision memory - remembers choices made
 */
export interface DecisionMemoryEntry extends MemoryEntry {
    type: 'decision';
    content: {
        question: string;
        choice: string;
        context: string;
        outcome: 'positive' | 'negative' | 'neutral';
    };
}

/**
 * Preference memory - remembers user preferences
 */
export interface PreferenceMemoryEntry extends MemoryEntry {
    type: 'preference';
    content: {
        key: string;
        value: any;
        inferredFrom?: string;
    };
}

/**
 * Memory recall query
 */
export interface MemoryQuery {
    query: string;
    type?: MemoryType | MemoryType[];
    limit?: number;
    minImportance?: number;
    sources?: MemorySource[];
    timeRange?: {
        start?: number;
        end?: number;
    };
}

/**
 * Memory recall result
 */
export interface MemoryResult {
    entry: MemoryEntry;
    score: number;
    source: MemorySource;
}

/**
 * Memory store options
 */
export interface MemoryStoreOptions {
    importance?: number;
    generateEmbedding?: boolean;
    metadata?: Record<string, any>;
}

/**
 * Memory configuration
 */
export interface MemoryConfig {
    kv: {
        maxItems: number;
        ttlMs: number;
    };
    agentdb: {
        dbPath: string;
        dimension: number;
        quantization: 'none' | 'scalar' | 'product';
        cacheSize: number;
    };
    archive: {
        maxAge: number;
        pruneThreshold: number;
    };
    consolidation: {
        interval: number;
        minImportance: number;
    };
}

/**
 * Default memory configuration
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    kv: {
        maxItems: 100,
        ttlMs: 30 * 60 * 1000,  // 30 minutes
    },
    agentdb: {
        dbPath: '.agentdb/memory.db',
        dimension: 384,  // MiniLM dimension
        quantization: 'scalar',
        cacheSize: 1000,
    },
    archive: {
        maxAge: 30 * 24 * 60 * 60 * 1000,  // 30 days
        pruneThreshold: 10000,
    },
    consolidation: {
        interval: 60 * 60 * 1000,  // 1 hour
        minImportance: 0.3,
    },
};
