/**
 * AgentX Memory System
 * 
 * Cross-session memory for agents and conversations.
 * 
 * Architecture:
 * - KV Cache: Fast, recent context (<1ms)
 * - AgentDB: Semantic vector search
 * - Archive: Long-term historical storage
 * 
 * Usage:
 * ```typescript
 * import { getMemory } from './memory/index.js';
 * 
 * const memory = await getMemory();
 * 
 * // Remember a task
 * await memory.rememberTask('task-123', 'Built login page', 'completed', {
 *   filesChanged: ['login.html', 'auth.js'],
 *   codePatterns: ['bcrypt-hashing'],
 * });
 * 
 * // Recall relevant context
 * const context = await memory.recall({
 *   query: 'What did we build for login?',
 *   type: 'task',
 *   limit: 5,
 * });
 * ```
 */

export { KVCache, getKVCache, resetKVCache } from './kv-cache.js';
export { AgentDBAdapter, getAgentDBAdapter, resetAgentDBAdapter } from './agentdb-adapter.js';
export { MemoryRouter, getMemoryRouter, resetMemoryRouter } from './router.js';
export * from './types.js';

import { MemoryRouter, getMemoryRouter } from './router.js';

/**
 * Get the singleton memory instance
 */
export async function getMemory(): Promise<MemoryRouter> {
    return getMemoryRouter();
}

/**
 * Format memory results for injection into prompts
 */
export function formatMemoryContext(results: Array<{ entry: any; score: number }>): string {
    if (results.length === 0) {
        return '';
    }

    const lines: string[] = ['## Relevant Context from Previous Sessions\n'];

    for (const result of results) {
        const entry = result.entry;
        const score = (result.score * 100).toFixed(0);

        switch (entry.type) {
            case 'task':
                lines.push(`### Task: ${entry.content.description} (${score}% match)`);
                lines.push(`- Status: ${entry.content.status}`);
                if (entry.content.filesChanged?.length > 0) {
                    lines.push(`- Files: ${entry.content.filesChanged.join(', ')}`);
                }
                if (entry.content.codePatterns?.length > 0) {
                    lines.push(`- Patterns: ${entry.content.codePatterns.join(', ')}`);
                }
                if (entry.content.outcome) {
                    lines.push(`- Outcome: ${entry.content.outcome}`);
                }
                break;

            case 'conversation':
                lines.push(`### Previous ${entry.content.role}: (${score}% match)`);
                lines.push(`> ${entry.content.message.slice(0, 200)}${entry.content.message.length > 200 ? '...' : ''}`);
                break;

            case 'code_pattern':
                lines.push(`### Pattern: ${entry.content.pattern} (${score}% match)`);
                lines.push(`- ${entry.content.description}`);
                lines.push(`- Language: ${entry.content.language}`);
                break;

            case 'decision':
                lines.push(`### Decision: ${entry.content.question} (${score}% match)`);
                lines.push(`- Choice: ${entry.content.choice}`);
                lines.push(`- Outcome: ${entry.content.outcome}`);
                break;

            case 'preference':
                lines.push(`### Preference: ${entry.content.key} (${score}% match)`);
                lines.push(`- Value: ${JSON.stringify(entry.content.value)}`);
                break;
        }

        lines.push('');
    }

    return lines.join('\n');
}
