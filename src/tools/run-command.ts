/**
 * AgentX Tool — run_command
 *
 * Executes shell commands with safety controls:
 * - Timeout enforcement
 * - Output truncation
 * - Working directory sandboxing
 * - Enhanced error context for LLM understanding
 * - Non-interactive mode (no prompts)
 * - Ctrl+X interrupt support via async execution
 */

import { spawn, ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { ToolDefinition, ToolResult } from './registry.js';

const DEFAULT_TIMEOUT = 60_000;    // 60 seconds
const MAX_OUTPUT = 50_000;          // 50KB output limit

// Global reference to current running process for interrupt handling
let currentProcess: ChildProcess | null = null;

/**
 * Kill the currently running command (called by Ctrl+X handler)
 */
export function interruptCurrentCommand(): boolean {
    if (currentProcess && !currentProcess.killed) {
        currentProcess.kill('SIGTERM');
        setTimeout(() => {
            if (currentProcess && !currentProcess.killed) {
                currentProcess.kill('SIGKILL');
            }
        }, 1000);
        return true;
    }
    return false;
}

/** Common error patterns with helpful hints */
const ERROR_HINTS: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /Cannot find module/i, hint: 'Missing module — run npm install first or check file path' },
    { pattern: /ENOENT.*no such file/i, hint: 'File or directory does not exist — create it first' },
    { pattern: /command not found|is not recognized/i, hint: 'Command not installed — install it or use a different approach' },
    { pattern: /EADDRINUSE/i, hint: 'Port already in use — kill existing process or use different port' },
    { pattern: /permission denied/i, hint: 'Permission issue — may need elevated privileges' },
    { pattern: /SyntaxError|Unexpected token/i, hint: 'Code syntax error — check the source file' },
    { pattern: /Security Warning.*Script Execution/i, hint: 'PowerShell security prompt — command auto-bypassed with -UseBasicParsing' },
];

/**
 * Transform commands to be non-interactive on Windows.
 */
function makeNonInteractive(command: string): string {
    let transformed = command;
    
    if (/Invoke-WebRequest/i.test(transformed) && !/-UseBasicParsing/i.test(transformed)) {
        transformed = transformed.replace(
            /Invoke-WebRequest/gi,
            'Invoke-WebRequest -UseBasicParsing'
        );
    }
    
    if (process.platform === 'win32' && /^curl\s/i.test(transformed)) {
        transformed = transformed.replace(/^curl\s/i, 'curl.exe ');
    }
    
    return transformed;
}

export function createRunCommandTool(workingDir: string): ToolDefinition {
    return {
        name: 'run_command',
        description: 'Execute a shell command and return its output (stdout + stderr). Commands run in the working directory. Has a 60-second timeout. Use for running tests, installing packages, git operations, builds, etc. Commands are automatically made non-interactive. Press Ctrl+X to interrupt.',
        params: [
            { name: 'command', type: 'string', description: 'Shell command to execute', required: true },
            { name: 'cwd', type: 'string', description: 'Working directory for the command (default: project root)', required: false },
        ],
        handler: async (params): Promise<ToolResult> => {
            const rawCommand = params.command;
            const command = makeNonInteractive(rawCommand);
            const cwd = params.cwd ? resolve(workingDir, params.cwd) : workingDir;

            return new Promise((resolvePromise) => {
                const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
                const shellArgs = process.platform === 'win32' ? ['-Command', command] : ['-c', command];
                
                const child = spawn(shell, shellArgs, {
                    cwd,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    env: {
                        ...process.env,
                        DEBIAN_FRONTEND: 'noninteractive',
                        GIT_TERMINAL_PROMPT: '0',
                        npm_config_yes: 'true',
                    },
                });

                currentProcess = child;
                
                let stdout = '';
                let stderr = '';
                let wasInterrupted = false;
                
                const timeout = setTimeout(() => {
                    if (!child.killed) {
                        child.kill('SIGTERM');
                        setTimeout(() => {
                            if (!child.killed) child.kill('SIGKILL');
                        }, 1000);
                    }
                }, DEFAULT_TIMEOUT);

                child.stdout?.on('data', (data) => {
                    stdout += data.toString();
                });

                child.stderr?.on('data', (data) => {
                    stderr += data.toString();
                });

                child.on('close', (code, signal) => {
                    clearTimeout(timeout);
                    currentProcess = null;
                    
                    const combined = [stdout, stderr].filter(Boolean).join('\n');
                    
                    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                        wasInterrupted = true;
                        resolvePromise({
                            output: `$ ${command}\n\n⚠️ Command interrupted by user (Ctrl+X)\n\n${truncateOutput(combined)}`,
                            status: 'error',
                        });
                        return;
                    }

                    if (code === 0) {
                        resolvePromise({
                            output: `$ ${command}\n\n${truncateOutput(combined || '(no output)')}`,
                            status: 'success',
                        });
                    } else {
                        const hint = findErrorHint(combined);
                        const hintText = hint ? `\n\n💡 Hint: ${hint}` : '';
                        
                        resolvePromise({
                            output: `$ ${command}\n\nExit code: ${code}\n\n${truncateOutput(combined)}${hintText}\n\n⚠️ If this keeps failing, try a different approach instead of retrying.`,
                            status: 'error',
                        });
                    }
                });

                child.on('error', (error) => {
                    clearTimeout(timeout);
                    currentProcess = null;
                    
                    resolvePromise({
                        output: `$ ${command}\n\nFailed to execute: ${error.message}`,
                        status: 'error',
                    });
                });
            });
        },
    };
}

/**
 * Truncate output to MAX_OUTPUT characters with indicator.
 */
function truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT) return output;

    const half = Math.floor(MAX_OUTPUT / 2);
    const truncated = output.length - MAX_OUTPUT;

    return (
        output.substring(0, half) +
        `\n\n... [${truncated} characters truncated] ...\n\n` +
        output.substring(output.length - half)
    );
}

/**
 * Find a helpful hint based on error output patterns.
 */
function findErrorHint(output: string): string | undefined {
    for (const { pattern, hint } of ERROR_HINTS) {
        if (pattern.test(output)) {
            return hint;
        }
    }
    return undefined;
}
