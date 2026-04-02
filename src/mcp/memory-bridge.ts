/**
 * AgentX — RuFlo Memory Bridge
 * 
 * High-level convenience helpers for interacting with RuFlo's memory
 * system through MCP tools. RuFlo exposes memory operations as MCP tools:
 * 
 *   - memory_search  → vector search over stored knowledge
 *   - memory_store   → store key-value knowledge with embeddings
 *   - memory_delete  → remove stored memories
 *   - memory_list    → list stored memory keys
 * 
 * This bridge provides typed wrappers so agents can use memory naturally
 * without constructing raw MCP tool calls.
 * 
 * Also provides helpers for RuFlo hooks:
 *   - hooks_fire     → fire a named hook (pre_task, post_task, etc.)
 *   - hooks_list     → list registered hooks
 */

import type { MCPClientManager } from './client.js';

// ─── Types ──────────────────────────────────────────────────────

export interface MemorySearchResult {
  key: string;
  value: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryEntry {
  key: string;
  value: string;
  metadata?: Record<string, unknown>;
}

export interface HookResult {
  hook: string;
  fired: boolean;
  output?: string;
}

// ─── Memory Bridge ──────────────────────────────────────────────

export class RuFloMemoryBridge {
  constructor(
    private mcpManager: MCPClientManager,
    private serverName: string = 'ruflo',
  ) {}

  /**
   * Search RuFlo's vector memory for relevant knowledge.
   * 
   * @param query - Natural language search query
   * @param limit - Maximum number of results (default: 5)
   * @returns Parsed search results with scores
   */
  async search(query: string, limit: number = 5): Promise<MemorySearchResult[]> {
    const result = await this.mcpManager.callTool(
      this.serverName,
      'memory_search',
      { query, limit },
    );

    if (result.isError) {
      console.error(`Memory search failed: ${result.content}`);
      return [];
    }

    // Try to parse the result as JSON (RuFlo returns JSON array)
    try {
      const parsed = JSON.parse(result.content);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) => ({
          key: item.key ?? item.id ?? '',
          value: item.value ?? item.content ?? item.text ?? '',
          score: item.score ?? item.similarity ?? 0,
          metadata: item.metadata,
        }));
      }
    } catch {
      // Not JSON — return as single text result
    }

    return [{
      key: 'raw',
      value: result.content,
      score: 1.0,
    }];
  }

  /**
   * Store a piece of knowledge in RuFlo's vector memory.
   * 
   * @param key - Unique identifier for this memory
   * @param value - The content to store (will be embedded)
   * @param metadata - Optional metadata (tags, source, etc.)
   */
  async store(
    key: string,
    value: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    const args: Record<string, unknown> = { key, value };
    if (metadata) {
      args.metadata = JSON.stringify(metadata);
    }

    const result = await this.mcpManager.callTool(
      this.serverName,
      'memory_store',
      args,
    );

    if (result.isError) {
      console.error(`Memory store failed: ${result.content}`);
      return false;
    }

    return true;
  }

  /**
   * Delete a memory entry by key.
   */
  async delete(key: string): Promise<boolean> {
    const result = await this.mcpManager.callTool(
      this.serverName,
      'memory_delete',
      { key },
    );

    return !result.isError;
  }

  /**
   * List all stored memory keys.
   */
  async list(): Promise<string[]> {
    const result = await this.mcpManager.callTool(
      this.serverName,
      'memory_list',
      {},
    );

    if (result.isError) {
      return [];
    }

    try {
      const parsed = JSON.parse(result.content);
      if (Array.isArray(parsed)) {
        return parsed.map((item: any) =>
          typeof item === 'string' ? item : item.key ?? String(item)
        );
      }
    } catch {
      // Not JSON
    }

    return result.content ? [result.content] : [];
  }

  // ─── Hook Helpers ───────────────────────────────────────────

  /**
   * Fire a named RuFlo hook.
   * 
   * Hooks are extension points in RuFlo's workflow:
   *   - pre_task   → Before agent starts working on a task
   *   - post_task  → After agent completes a task
   *   - on_error   → When an error occurs
   *   - on_commit  → Before git commit
   * 
   * @param hookName - Name of the hook to fire
   * @param context - Optional context data to pass to the hook
   */
  async fireHook(
    hookName: string,
    context?: Record<string, unknown>
  ): Promise<HookResult> {
    const args: Record<string, unknown> = { hook: hookName };
    if (context) {
      args.context = JSON.stringify(context);
    }

    const result = await this.mcpManager.callTool(
      this.serverName,
      'hooks_fire',
      args,
    );

    return {
      hook: hookName,
      fired: !result.isError,
      output: result.content,
    };
  }

  /**
   * List all registered hooks.
   */
  async listHooks(): Promise<string[]> {
    const result = await this.mcpManager.callTool(
      this.serverName,
      'hooks_list',
      {},
    );

    if (result.isError) {
      return [];
    }

    try {
      const parsed = JSON.parse(result.content);
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
    } catch {
      // Not JSON
    }

    return [];
  }

  // ─── Compound Patterns ──────────────────────────────────────

  /**
   * "Remember and retrieve" pattern:
   * Search memory first; if nothing relevant found, store the new info.
   * Commonly used at the start of agent tasks to build context.
   */
  async contextualRecall(
    query: string,
    fallbackMemory?: { key: string; value: string }
  ): Promise<MemorySearchResult[]> {
    const results = await this.search(query, 3);

    // If we got meaningful results, return them
    if (results.length > 0 && results[0].score > 0.5) {
      return results;
    }

    // Otherwise, store the fallback if provided
    if (fallbackMemory) {
      await this.store(fallbackMemory.key, fallbackMemory.value, {
        source: 'contextual_recall',
        query,
      });
    }

    return results;
  }

  /**
   * Check if the RuFlo MCP server is connected and responsive.
   */
  isConnected(): boolean {
    return this.mcpManager.isConnected(this.serverName);
  }
}
