/**
 * AgentX Tool — write_file
 * 
 * Writes content to a file, creating parent directories if needed.
 * Supports creating new files and overwriting existing ones.
 * 
 * Now tracks changes for undo functionality.
 */

import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ToolDefinition, ToolResult } from './registry.js';
import { getChangeTracker } from './change-tracker.js';

export function createWriteFileTool(workingDir: string): ToolDefinition {
  return {
    name: 'write_file',
    description: 'Write content to a file. Creates the file and parent directories if they don\'t exist. Overwrites the file if it already exists.',
    params: [
      { name: 'path', type: 'string', description: 'File path (absolute or relative to working directory)', required: true },
      { name: 'content', type: 'string', description: 'Full file content to write', required: true },
    ],
    handler: async (params): Promise<ToolResult> => {
      const filePath = resolve(workingDir, params.path);
      const content = params.content;

      try {
        // Create parent directories
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        const existed = existsSync(filePath);
        
        // Track the change BEFORE writing
        const tracker = getChangeTracker({ workingDir });
        if (existed) {
          const originalContent = readFileSync(filePath, 'utf-8');
          tracker.trackUpdate(params.path, originalContent, content);
        } else {
          tracker.trackCreate(params.path, content);
        }

        writeFileSync(filePath, content, 'utf-8');

        const lineCount = content.split('\n').length;
        const sizeKB = (Buffer.byteLength(content, 'utf-8') / 1024).toFixed(1);
        const action = existed ? 'Updated' : 'Created';

        return {
          output: `${action} ${filePath} (${lineCount} lines, ${sizeKB}KB)`,
          status: 'success',
        };
      } catch (error: any) {
        return { output: `Failed to write file: ${error.message}`, status: 'error' };
      }
    },
  };
}
