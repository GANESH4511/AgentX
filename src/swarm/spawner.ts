/**
 * AgentX — Sub-Agent Spawner
 * 
 * Spawns and manages child AgentX processes for multi-agent swarm work.
 * 
 * Architecture:
 *   Parent process (coordinator)
 *     ├── child_1 (stdin/stdout JSON IPC)
 *     ├── child_2
 *     └── child_N
 * 
 * Each child is a stripped-down AgentX running its own ReAct loop
 * without a terminal UI. Communication uses newline-delimited JSON
 * over stdin/stdout (the simplest cross-platform IPC).
 * 
 * Features:
 *   - Agent pooling (reuse warm agents)
 *   - Health checks (timeout, crash recovery)
 *   - Model tier assignment per agent
 *   - Clean shutdown with SIGTERM → SIGKILL cascade
 */

import { ChildProcess, fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Types ──────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'busy' | 'dead' | 'starting';

export interface AgentConfig {
    /** Preferred role (e.g., "coder", "tester", "reviewer") */
    role?: string;
    /** Model tier (1=fast, 2=default, 3=complex) */
    tier?: 1 | 2 | 3;
    /** Specific model ID override */
    model?: string;
    /** Provider name override (uses parent's active provider if unset) */
    provider?: string;
    /** Working directory */
    workingDir?: string;
    /** Extra system prompt injected for this agent's role */
    systemPromptExtra?: string;
    /** Max iterations per task */
    maxIterations?: number;
}

export interface SwarmAgent {
    id: string;
    config: AgentConfig;
    status: AgentStatus;
    pid?: number;
    currentTaskId?: string;
    process?: ChildProcess;
    createdAt: number;
    lastActivityAt: number;
}

/**
 * Messages sent TO a child agent via stdin.
 */
export interface AgentMessage {
    type: 'task' | 'ping' | 'shutdown';
    taskId?: string;
    prompt?: string;
    context?: string;
    role?: string;
    tier?: number;
    model?: string;
    provider?: string;
    workingDir?: string;
    systemPromptExtra?: string;
    maxIterations?: number;
}

/**
 * Messages received FROM a child agent via stdout.
 */
export interface AgentResponse {
    type: 'result' | 'error' | 'pong' | 'progress' | 'ready';
    taskId?: string;
    output?: string;
    error?: string;
    progress?: string;
}

// ─── Spawner ────────────────────────────────────────────────────

export class AgentSpawner extends EventEmitter {
    private agents: Map<string, SwarmAgent> = new Map();
    private maxAgents: number;
    private workerScript: string;
    private healthCheckIntervalMs: number;
    private healthTimer?: ReturnType<typeof setInterval>;

    constructor(options?: {
        maxAgents?: number;
        healthCheckIntervalMs?: number;
    }) {
        super();
        this.maxAgents = options?.maxAgents ?? 5;
        this.healthCheckIntervalMs = options?.healthCheckIntervalMs ?? 30_000;

        // The worker script lives alongside this file
        // When compiled: dist/swarm/worker.js
        // During dev: src/swarm/worker.ts (but we always reference the .js output)
        const thisDir = typeof __dirname !== 'undefined'
            ? __dirname
            : dirname(fileURLToPath(import.meta.url));
        this.workerScript = join(thisDir, 'worker.js');
    }

    /**
     * Spawn a new child agent process.
     * Returns the agent ID.
     */
    spawn(config: AgentConfig = {}): string {
        if (this.agents.size >= this.maxAgents) {
            throw new Error(
                `Agent limit reached (${this.maxAgents}). ` +
                `Increase maxAgents or wait for an agent to finish.`
            );
        }

        const id = `agent-${randomUUID().slice(0, 6)}`;

        const agent: SwarmAgent = {
            id,
            config,
            status: 'starting',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
        };

        // Fork a child process running the worker script
        const child = fork(this.workerScript, [], {
            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
            env: {
                ...process.env,
                AGENTX_SWARM_AGENT_ID: id,
                AGENTX_SWARM_MODE: '1',
            },
            silent: true,  // capture stdout/stderr
        });

        agent.process = child;
        agent.pid = child.pid;

        // ─── Listen for messages from the child ─────────────────
        let buffer = '';

        child.stdout?.on('data', (data: Buffer) => {
            buffer += data.toString();

            // Process newline-delimited JSON messages
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineIdx).trim();
                buffer = buffer.slice(newlineIdx + 1);
                if (!line) continue;

                try {
                    const msg = JSON.parse(line) as AgentResponse;
                    this.handleChildMessage(id, msg);
                } catch {
                    // Non-JSON stdout — log as agent output
                    this.emit('agent:stdout', id, line);
                }
            }
        });

        child.stderr?.on('data', (data: Buffer) => {
            this.emit('agent:stderr', id, data.toString());
        });

        child.on('exit', (code, signal) => {
            const a = this.agents.get(id);
            if (a) {
                a.status = 'dead';
                a.process = undefined;
            }
            this.emit('agent:exit', id, code, signal);
        });

        child.on('error', (err) => {
            this.emit('agent:error', id, err);
        });

        this.agents.set(id, agent);
        this.emit('agent:spawned', agent);

        return id;
    }

    /**
     * Send a task to a specific agent.
     */
    sendTask(agentId: string, taskId: string, prompt: string, context?: string): void {
        const agent = this.agents.get(agentId);
        if (!agent || !agent.process || agent.status === 'dead') {
            throw new Error(`Agent ${agentId} is not available (status: ${agent?.status ?? 'not found'})`);
        }

        agent.status = 'busy';
        agent.currentTaskId = taskId;
        agent.lastActivityAt = Date.now();

        const msg: AgentMessage = {
            type: 'task',
            taskId,
            prompt,
            context,
            role: agent.config.role,
            tier: agent.config.tier,
            model: agent.config.model,
            provider: agent.config.provider,
            workingDir: agent.config.workingDir,
            systemPromptExtra: agent.config.systemPromptExtra,
            maxIterations: agent.config.maxIterations,
        };

        this.writeToAgent(agent, msg);
    }

    /**
     * Get the first idle agent, optionally filtered by role.
     */
    getIdleAgent(role?: string): SwarmAgent | null {
        for (const agent of this.agents.values()) {
            if (agent.status !== 'idle') continue;
            if (role && agent.config.role !== role) continue;
            return agent;
        }
        return null;
    }

    /**
     * Get or spawn an agent for the given config.
     * Tries to reuse an idle agent with matching role first.
     */
    getOrSpawn(config: AgentConfig = {}): string {
        // Try to reuse an idle agent with matching role
        const idle = this.getIdleAgent(config.role);
        if (idle) return idle.id;

        // Spawn a new one
        return this.spawn(config);
    }

    /**
     * Send a ping to check agent health.
     */
    ping(agentId: string): void {
        const agent = this.agents.get(agentId);
        if (!agent || !agent.process || agent.status === 'dead') return;

        this.writeToAgent(agent, { type: 'ping' });
    }

    /**
     * Gracefully shut down a specific agent.
     */
    async kill(agentId: string, graceful = true): Promise<void> {
        const agent = this.agents.get(agentId);
        if (!agent || !agent.process) {
            this.agents.delete(agentId);
            return;
        }

        if (graceful) {
            // Send shutdown message first
            this.writeToAgent(agent, { type: 'shutdown' });

            // Wait up to 3 seconds for graceful exit
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    agent.process?.kill('SIGKILL');
                    resolve();
                }, 3000);

                agent.process?.on('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        } else {
            agent.process.kill('SIGKILL');
        }

        agent.status = 'dead';
        agent.process = undefined;
        this.emit('agent:killed', agentId);
    }

    /**
     * Shut down all agents.
     */
    async killAll(graceful = true): Promise<void> {
        this.stopHealthChecks();

        const kills = Array.from(this.agents.keys()).map(id => this.kill(id, graceful));
        await Promise.allSettled(kills);
    }

    /**
     * Start periodic health checks.
     */
    startHealthChecks(): void {
        this.healthTimer = setInterval(() => {
            const now = Date.now();
            for (const agent of this.agents.values()) {
                if (agent.status === 'dead') continue;

                // Check for stale agents (no activity for 2x health check interval)
                if (now - agent.lastActivityAt > this.healthCheckIntervalMs * 2) {
                    this.emit('agent:stale', agent.id);
                }

                // Ping living agents (already filtered dead agents above)
                if (agent.process) {
                    this.ping(agent.id);
                }
            }
        }, this.healthCheckIntervalMs);
    }

    /**
     * Stop health checks.
     */
    stopHealthChecks(): void {
        if (this.healthTimer) {
            clearInterval(this.healthTimer);
            this.healthTimer = undefined;
        }
    }

    /**
     * Get agent by ID.
     */
    get(agentId: string): SwarmAgent | undefined {
        return this.agents.get(agentId);
    }

    /**
     * List all agents.
     */
    listAll(): SwarmAgent[] {
        return Array.from(this.agents.values());
    }

    /**
     * Get count of agents by status.
     */
    getStats(): Record<AgentStatus, number> {
        const stats: Record<AgentStatus, number> = {
            idle: 0,
            busy: 0,
            dead: 0,
            starting: 0,
        };

        for (const agent of this.agents.values()) {
            stats[agent.status]++;
        }

        return stats;
    }

    // ─── Private ──────────────────────────────────────────────────

    /**
     * Handle a message received from a child agent.
     */
    private handleChildMessage(agentId: string, msg: AgentResponse): void {
        const agent = this.agents.get(agentId);
        if (!agent) return;

        agent.lastActivityAt = Date.now();

        switch (msg.type) {
            case 'ready':
                agent.status = 'idle';
                this.emit('agent:ready', agentId);
                break;

            case 'result':
                agent.status = 'idle';
                agent.currentTaskId = undefined;
                this.emit('agent:result', agentId, msg.taskId, msg.output);
                break;

            case 'error':
                agent.status = 'idle';
                agent.currentTaskId = undefined;
                this.emit('agent:taskError', agentId, msg.taskId, msg.error);
                break;

            case 'progress':
                this.emit('agent:progress', agentId, msg.taskId, msg.progress);
                break;

            case 'pong':
                this.emit('agent:pong', agentId);
                break;
        }
    }

    /**
     * Write a JSON message to an agent's stdin.
     */
    private writeToAgent(agent: SwarmAgent, msg: AgentMessage): void {
        if (!agent.process?.stdin?.writable) {
            throw new Error(`Cannot write to agent ${agent.id}: stdin not writable`);
        }

        const line = JSON.stringify(msg) + '\n';
        agent.process.stdin.write(line);
    }
}
