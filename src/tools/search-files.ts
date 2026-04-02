/**
 * AgentX Tool — search_files
 * 
 * Search for text patterns in files across the project.
 * Uses recursive file scanning with regex/literal matching.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { ToolDefinition, ToolResult } from './registry.js';

const MAX_RESULTS = 30;
const MAX_FILE_SIZE = 256 * 1024; // Skip files > 256KB

// Skip these directories
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', '__pycache__', '.cache',
  'dist', 'build', 'out', '.turbo', 'coverage', '.svelte-kit',
  'vendor', 'target', '.venv', 'venv', '.tox',
]);

// Skip binary file extensions
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.pdf',
  '.zip', '.gz', '.tar', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.pyc', '.pyo', '.class', '.o', '.obj',
  '.lock', '.sqlite', '.db',
]);

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

export function createSearchFilesTool(workingDir: string): ToolDefinition {
  return {
    name: 'search_files',
    description: 'Search for a text pattern across files in the project. Returns matching lines with file paths and line numbers. Useful for finding where things are defined, imported, or used.',
    params: [
      { name: 'pattern', type: 'string', description: 'Text or regex pattern to search for', required: true },
      { name: 'path', type: 'string', description: 'Directory or file to search in (default: working directory)', required: false },
      { name: 'include', type: 'string', description: 'File extension filter, e.g. ".ts,.tsx" (comma-separated)', required: false },
    ],
    handler: async (params): Promise<ToolResult> => {
      const searchDir = params.path ? resolve(workingDir, params.path) : workingDir;
      const pattern = params.pattern;
      const includeExts = params.include
        ? new Set(params.include.split(',').map(e => e.trim().startsWith('.') ? e.trim() : `.${e.trim()}`))
        : null;

      try {
        let regex: RegExp;
        try {
          regex = new RegExp(pattern, 'gi');
        } catch {
          // If invalid regex, treat as literal string
          regex = new RegExp(escapeRegex(pattern), 'gi');
        }

        const matches: SearchMatch[] = [];
        searchRecursive(searchDir, regex, includeExts, matches, workingDir);

        if (matches.length === 0) {
          return { output: `No matches found for "${pattern}"`, status: 'success' };
        }

        const total = matches.length;
        const displayed = matches.slice(0, MAX_RESULTS);

        const output = displayed
          .map(m => `${m.file}:${m.line}: ${m.content.trim()}`)
          .join('\n');

        const truncMsg = total > MAX_RESULTS
          ? `\n\n[Showing ${MAX_RESULTS} of ${total} matches]`
          : '';

        return {
          output: `Found ${total} matches for "${pattern}":\n\n${output}${truncMsg}`,
          status: 'success',
        };
      } catch (error: any) {
        return { output: `Search failed: ${error.message}`, status: 'error' };
      }
    },
  };
}

function searchRecursive(
  dir: string,
  regex: RegExp,
  includeExts: Set<string> | null,
  matches: SearchMatch[],
  workingDir: string
): void {
  if (matches.length >= MAX_RESULTS * 2) return; // Stop early

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (matches.length >= MAX_RESULTS * 2) return;

    const fullPath = resolve(dir, entry.name);

    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
        searchRecursive(fullPath, regex, includeExts, matches, workingDir);
      }
      continue;
    }

    if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();

      // Skip binary files
      if (BINARY_EXTS.has(ext)) continue;

      // Apply include filter
      if (includeExts && !includeExts.has(ext)) continue;

      // Skip large files
      try {
        const stats = statSync(fullPath);
        if (stats.size > MAX_FILE_SIZE) continue;
      } catch {
        continue;
      }

      try {
        const content = readFileSync(fullPath, 'utf-8');
        const lines = content.split('\n');
        const relPath = relative(workingDir, fullPath);

        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0; // Reset regex state
          if (regex.test(lines[i])) {
            matches.push({
              file: relPath,
              line: i + 1,
              content: lines[i].substring(0, 200), // Truncate long lines
            });
            if (matches.length >= MAX_RESULTS * 2) return;
          }
        }
      } catch {
        // Skip files that can't be read as utf-8
      }
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
