/**
 * AgentX Tool — read_file
 * 
 * Reads a file from the filesystem.
 * Supports line ranges for large files.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToolDefinition, ToolResult } from './registry.js';

const MAX_FILE_SIZE = 512 * 1024; // 512KB read limit
const MAX_LINES = 500;            // Max lines per read without range

export function createReadFileTool(workingDir: string): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read the contents of a file. For large files, use start_line and end_line to read a specific range.',
    params: [
      { name: 'path', type: 'string', description: 'File path (absolute or relative to working directory)', required: true },
      { name: 'start_line', type: 'number', description: 'Start line number (1-indexed, inclusive)', required: false },
      { name: 'end_line', type: 'number', description: 'End line number (1-indexed, inclusive)', required: false },
    ],
    handler: async (params): Promise<ToolResult> => {
      const filePath = resolve(workingDir, params.path);

      if (!existsSync(filePath)) {
        return { output: `File not found: ${filePath}`, status: 'error' };
      }

      const stats = statSync(filePath);
      if (stats.isDirectory()) {
        return { output: `"${filePath}" is a directory, not a file. Use list_dir instead.`, status: 'error' };
      }

      if (stats.size > MAX_FILE_SIZE) {
        return {
          output: `File is too large (${(stats.size / 1024).toFixed(1)}KB). Use start_line/end_line to read a portion.`,
          status: 'error',
        };
      }

      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        const startLine = params.start_line ? parseInt(params.start_line) : 1;
        const endLine = params.end_line ? parseInt(params.end_line) : lines.length;

        // Validate range
        const safeStart = Math.max(1, startLine);
        const safeEnd = Math.min(lines.length, endLine);

        if (safeEnd - safeStart + 1 > MAX_LINES && !params.start_line) {
          // Auto-truncate large files
          const truncated = lines.slice(0, MAX_LINES).join('\n');
          return {
            output: `[Showing first ${MAX_LINES} of ${lines.length} lines]\n\n${truncated}\n\n[... ${lines.length - MAX_LINES} more lines. Use start_line/end_line to read more.]`,
            status: 'success',
          };
        }

        const selected = lines.slice(safeStart - 1, safeEnd);

        // Add line numbers
        const numbered = selected
          .map((line, i) => `${String(safeStart + i).padStart(4)} │ ${line}`)
          .join('\n');

        const header = safeStart > 1 || safeEnd < lines.length
          ? `[Lines ${safeStart}-${safeEnd} of ${lines.length}]\n\n`
          : `[${lines.length} lines]\n\n`;

        return { output: `${header}${numbered}`, status: 'success' };
      } catch (error: any) {
        return { output: `Failed to read file: ${error.message}`, status: 'error' };
      }
    },
  };
}
