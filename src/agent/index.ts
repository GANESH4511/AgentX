/**
 * AgentX — Agent Index
 * 
 * Barrel export for agent core components.
 */

export { ReactLoop } from './react-loop.js';
export type { ReactLoopOptions } from './react-loop.js';

export { Conversation } from './conversation.js';

export { buildSystemPrompt } from './system-prompt.js';

export {
  parseToolCalls,
  hasToolCalls,
  extractReasoning,
  formatToolResult,
} from './xml-parser.js';
export type { ParsedToolCall } from './xml-parser.js';

export {
  KVCache,
  getKVCache,
  resetKVCache,
  remember,
  recall,
  forget,
  saveConversation,
  loadConversation,
} from './kv-cache.js';
export type { CacheEntry, KVCacheConfig, CacheStats } from './kv-cache.js';
