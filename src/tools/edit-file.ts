/**
 * AgentX Tool — edit_file
 * 
 * Performs targeted search-and-replace edits on files.
 * Safer than rewriting entire files — only changes the matched section.
 * 
 * Now tracks changes for undo functionality.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ToolDefinition, ToolResult } from './registry.js';
import { getChangeTracker } from './change-tracker.js';

export function createEditFileTool(workingDir: string): ToolDefinition {
  return {
    name: 'edit_file',
    description: 'Edit a file by replacing a specific text section with new content. Finds the exact match of old_content in the file and replaces it with new_content. Use this instead of write_file when you only need to change part of a file.',
    params: [
      { name: 'path', type: 'string', description: 'File path (absolute or relative to working directory)', required: true },
      { name: 'old_content', type: 'string', description: 'Exact text to find and replace (must match exactly, including whitespace)', required: true },
      { name: 'new_content', type: 'string', description: 'Replacement text', required: true },
    ],
    handler: async (params): Promise<ToolResult> => {
      const filePath = resolve(workingDir, params.path);

      if (!existsSync(filePath)) {
        return { output: `File not found: ${filePath}`, status: 'error' };
      }

      try {
        const content = readFileSync(filePath, 'utf-8');
        const oldContent = params.old_content;
        const newContent = params.new_content;

        // Count occurrences
        const occurrences = content.split(oldContent).length - 1;

        if (occurrences === 0) {
          // Try to help: show nearby content
          const lines = content.split('\n');
          const shortOld = oldContent.split('\n')[0].trim();
          const nearbyLines = lines
            .map((line, i) => ({ line, num: i + 1 }))
            .filter(({ line }) => line.includes(shortOld.substring(0, 30)))
            .slice(0, 3);

          let hint = '';
          if (nearbyLines.length > 0) {
            hint = '\n\nSimilar content found at:\n' +
              nearbyLines.map(({ line, num }) => `  Line ${num}: ${line.trim().substring(0, 80)}`).join('\n');
          }

          return {
            output: `old_content not found in ${filePath}. The text must match exactly including whitespace and indentation.${hint}`,
            status: 'error',
          };
        }

        if (occurrences > 1) {
          return {
            output: `old_content found ${occurrences} times in ${filePath}. Please use a larger/unique snippet to match exactly one location.`,
            status: 'error',
          };
        }

        // Track the change BEFORE performing the edit
        const tracker = getChangeTracker({ workingDir });
        const updated = content.replace(oldContent, newContent);
        tracker.trackUpdate(params.path, content, updated);

        // Perform the replacement
        writeFileSync(filePath, updated, 'utf-8');

        // Calculate diff stats
        const oldLines = oldContent.split('\n').length;
        const newLines = newContent.split('\n').length;
        const addedLines = Math.max(0, newLines - oldLines);
        const removedLines = Math.max(0, oldLines - newLines);

        return {
          output: `Edited ${filePath} (+${addedLines} -${removedLines} lines)`,
          status: 'success',
        };
      } catch (error: any) {
        return { output: `Failed to edit file: ${error.message}`, status: 'error' };
      }
    },
  };
}
