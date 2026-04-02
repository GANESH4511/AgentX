/**
 * AgentX — Configuration Loader
 * 
 * Loads config from ~/.agentx/config.yaml with env var substitution.
 * Falls back to sensible defaults if no config file exists.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export interface AgentXConfig {
    activeProvider: string;
    providers: Record<string, {
        type: string;
        baseUrl: string;
        apiKey?: string;
        defaultModel: string;
        models?: {
            tier1Fast?: string;
            tier2Default?: string;
            tier3Complex?: string;
        };
    }>;
    routing: {
        autoTier: boolean;
        complexityThresholdLow: number;
        complexityThresholdHigh: number;
    };
    mcp: {
        servers: Array<{
            name: string;
            command: string;
            args: string[];
            env?: Record<string, string>;
        }>;
    };
    agent: {
        maxIterations: number;
        maxHistoryTokens: number;
        workingDirectory: string;
    };
    swarm: {
        maxAgents: number;
        taskTimeoutMs: number;
        autoSpawn: boolean;
        /** Orchestration backend: 'ruflo' (RuFlo+AgentX hybrid), 'agentx' (pure AgentX), 'hybrid' (RuFlo state + AgentX exec) */
        backend: 'ruflo' | 'agentx' | 'hybrid';
    };
}

const CONFIG_DIR = join(homedir(), '.agentx');
const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml');

/**
 * Default configuration — used when no config file exists.
 */
function getDefaultConfig(): AgentXConfig {
    return {
        activeProvider: 'infinitai',
        providers: {
            infinitai: {
                type: 'openai-compatible',
                baseUrl: 'https://infinitai.sifymdp.digital/maas/v1',
                apiKey: '${INFINITAI_API_KEY}',
                defaultModel: 'meta/llama-3.3-70b-instruct',
                models: {
                    tier1Fast: 'meta/llama-3.3-70b-instruct',
                    tier2Default: 'meta/llama-3.3-70b-instruct',
                    tier3Complex: 'meta/llama-3.3-70b-instruct',
                },
            },
        },
        routing: {
            autoTier: true,
            complexityThresholdLow: 0.3,
            complexityThresholdHigh: 0.7,
        },
        mcp: {
            servers: [
                {
                    name: 'ruflo',
                    command: 'npx',
                    args: ['-y', '@claude-flow/cli@latest', 'mcp', 'start'],
                },
            ],
        },
        agent: {
            maxIterations: 10,
            maxHistoryTokens: 80000,
            workingDirectory: '.',
        },
        swarm: {
            maxAgents: 5,
            taskTimeoutMs: 300000,
            autoSpawn: true,
            backend: 'ruflo',  // Default: RuFlo orchestration with AgentX execution
        },
    };
}

/**
 * Substitute ${ENV_VAR} patterns with actual environment variables.
 */
function substituteEnvVars(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (_match, envName) => {
        return process.env[envName] || '';
    });
}

/**
 * Deep substitute env vars in an object.
 */
function deepSubstitute(obj: any): any {
    if (typeof obj === 'string') {
        return substituteEnvVars(obj);
    }
    if (Array.isArray(obj)) {
        return obj.map(deepSubstitute);
    }
    if (obj && typeof obj === 'object') {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = deepSubstitute(value);
        }
        return result;
    }
    return obj;
}

/**
 * Convert YAML snake_case keys to camelCase.
 */
function toCamelCase(key: string): string {
    return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function deepCamelCase(obj: any): any {
    if (Array.isArray(obj)) {
        return obj.map(deepCamelCase);
    }
    if (obj && typeof obj === 'object') {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[toCamelCase(key)] = deepCamelCase(value);
        }
        return result;
    }
    return obj;
}

/**
 * Load configuration from file with env var substitution.
 */
export function loadConfig(): AgentXConfig {
    if (!existsSync(CONFIG_FILE)) {
        return deepSubstitute(getDefaultConfig());
    }

    try {
        const raw = readFileSync(CONFIG_FILE, 'utf-8');
        const parsed = parseYaml(raw);
        const config = deepCamelCase(parsed) as AgentXConfig;

        // Merge with defaults for any missing fields
        const defaults = getDefaultConfig();
        const merged: AgentXConfig = {
            activeProvider: config.activeProvider || defaults.activeProvider,
            providers: config.providers || defaults.providers,
            routing: { ...defaults.routing, ...config.routing },
            mcp: config.mcp || defaults.mcp,
            agent: { ...defaults.agent, ...config.agent },
            swarm: { ...defaults.swarm, ...(config as any).swarm },
        };

        return deepSubstitute(merged);
    } catch (error) {
        console.error(`Warning: Failed to parse config file: ${error}`);
        return deepSubstitute(getDefaultConfig());
    }
}

/**
 * Initialize config directory and write default config file.
 */
export function initConfig(): string {
    if (!existsSync(CONFIG_DIR)) {
        mkdirSync(CONFIG_DIR, { recursive: true });
    }

    if (existsSync(CONFIG_FILE)) {
        return CONFIG_FILE;
    }

    const defaultYaml = `# AgentX Configuration
# Docs: https://github.com/agentx/agentx

# Active provider (must match a key in providers)
active_provider: infinitai

providers:
  infinitai:
    type: openai-compatible
    base_url: https://infinitai.sifymdp.digital/maas/v1
    api_key: \${INFINITAI_API_KEY}
    default_model: meta/llama-3.3-70b-instruct
    models:
      tier1_fast: meta/llama-3.3-70b-instruct
      tier2_default: meta/llama-3.3-70b-instruct
      tier3_complex: meta/llama-3.3-70b-instruct

  # Uncomment to add OpenAI
  # openai:
  #   type: openai-compatible
  #   base_url: https://api.openai.com/v1
  #   api_key: \${OPENAI_API_KEY}
  #   default_model: gpt-4o

  # Uncomment to add Ollama (local)
  # ollama:
  #   type: ollama
  #   base_url: http://localhost:11434
  #   default_model: llama3.2

# Model routing (mirrors RuFlo ADR-026)
routing:
  auto_tier: true
  complexity_threshold_low: 0.3
  complexity_threshold_high: 0.7

# MCP servers
mcp:
  servers:
    - name: ruflo
      command: npx
      args: ["-y", "@claude-flow/cli@latest", "mcp", "start"]
  # Add more servers:
  # - name: filesystem
  #   command: npx
  #   args: ["-y", "@modelcontextprotocol/server-filesystem", "."]

# Agent settings
agent:
  max_iterations: 10
  max_history_tokens: 80000
  working_directory: "."

# Swarm settings (Phase D: Multi-Agent)
swarm:
  max_agents: 5
  task_timeout_ms: 300000
  auto_spawn: true
`;

    writeFileSync(CONFIG_FILE, defaultYaml, 'utf-8');
    return CONFIG_FILE;
}

/**
 * Get the config file path.
 */
export function getConfigPath(): string {
    return CONFIG_FILE;
}

/**
 * Get the config directory path.
 */
export function getConfigDir(): string {
    return CONFIG_DIR;
}
