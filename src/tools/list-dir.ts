/**
 * AgentX Tool — list_dir
 * 
 * Lists directory contents with file types, sizes, and structure.
 */

import { readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { ToolDefinition, ToolResult } from './registry.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '__pycache__', '.cache',
  'dist', 'build', 'out', '.turbo', 'coverage',
]);

export function createListDirTool(workingDir: string): ToolDefinition {
  return {
    name: 'list_dir',
    description: 'List the contents of a directory showing files and subdirectories with sizes. Use to understand project structure.',
    params: [
      { name: 'path', type: 'string', description: 'Directory path (default: working directory)', required: false },
      { name: 'depth', type: 'number', description: 'Maximum depth for recursive listing (default: 1, max: 3)', required: false },
    ],
    handler: async (params): Promise<ToolResult> => {
      const dirPath = params.path ? resolve(workingDir, params.path) : workingDir;
      const maxDepth = Math.min(parseInt(params.depth || '1'), 3);

      try {
        const lines: string[] = [];
        const relDir = relative(workingDir, dirPath) || '.';
        lines.push(`📁 ${relDir}/`);
        listRecursive(dirPath, '', maxDepth, 0, lines, workingDir);

        return { output: lines.join('\n'), status: 'success' };
      } catch (error: any) {
        return { output: `Failed to list directory: ${error.message}`, status: 'error' };
      }
    },
  };
}

function listRecursive(
  dir: string,
  prefix: string,
  maxDepth: number,
  currentDepth: number,
  lines: string[],
  workingDir: string,
): void {
  if (currentDepth >= maxDepth) return;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort: directories first, then files, alphabetically
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  // Limit entries
  const maxEntries = 50;
  const displayEntries = entries.slice(0, maxEntries);
  const isLast = (index: number) => index === displayEntries.length - 1;

  for (let i = 0; i < displayEntries.length; i++) {
    const entry = displayEntries[i];
    const connector = isLast(i) ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast(i) ? '    ' : '│   ');
    const fullPath = resolve(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) {
        lines.push(`${prefix}${connector}📁 ${entry.name}/ ${dimText('[ignored]')}`);
        continue;
      }

      // Count children for info
      let childCount = 0;
      try {
        childCount = readdirSync(fullPath).length;
      } catch { /* ignore */ }

      lines.push(`${prefix}${connector}📁 ${entry.name}/ (${childCount} items)`);
      listRecursive(fullPath, childPrefix, maxDepth, currentDepth + 1, lines, workingDir);
    } else {
      try {
        const stats = statSync(fullPath);
        const size = formatSize(stats.size);
        lines.push(`${prefix}${connector}📄 ${entry.name} ${dimText(`(${size})`)}`);
      } catch {
        lines.push(`${prefix}${connector}📄 ${entry.name}`);
      }
    }
  }

  if (entries.length > maxEntries) {
    lines.push(`${prefix}└── ... and ${entries.length - maxEntries} more items`);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function dimText(text: string): string {
  return text; // Terminal colors handled by the UI layer
}
