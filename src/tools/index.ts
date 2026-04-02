/**
 * AgentX — Tools Index
 * 
 * Barrel export for all built-in tools and the registry.
 */

export { ToolRegistry } from './registry.js';
export type { ToolDefinition, ToolParam, ToolResult } from './registry.js';

export { createReadFileTool } from './read-file.js';
export { createWriteFileTool } from './write-file.js';
export { createEditFileTool } from './edit-file.js';
export { createRunCommandTool } from './run-command.js';
export { createSearchFilesTool } from './search-files.js';
export { createListDirTool } from './list-dir.js';

// Undo/Change tracking
export { ChangeTracker, getChangeTracker, formatChange } from './change-tracker.js';
export type { FileChange, UndoResult } from './change-tracker.js';
