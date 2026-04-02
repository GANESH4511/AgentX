# AgentX

AgentX is a terminal-first AI coding agent runtime built in TypeScript.

## Release Status

First public release: v0.1.0

This is the initial release of AgentX.Core architecture and major feature sets are implemented and usable end-to-end, and this release is focused on real-world usage plus feedback-driven hardening.

It is designed to be a host runtime that can:

- Talk to multiple LLM providers (OpenAI-compatible endpoints and Ollama)
- Execute coding tools through an XML-based tool-calling loop
- Connect to MCP servers and expose MCP tools to the model dynamically
- Run multi-agent swarm workflows using child worker processes

In practice, this project is a replacement-style host runtime for orchestrated agent workflows where provider flexibility and tool autonomy matter.

## Initial Release Scope (v0.1.0)

What is included in this first release:

- Interactive terminal chat runtime
- ReAct-style autonomous tool loop
- XML tool-calling protocol for non-native tool-call models
- Built-in coding tools (read/write/edit/search/list/command)
- MCP server connectivity and dynamic tool injection
- Multi-agent swarm orchestration (AgentX and RuFlo-integrated paths)
- Live swarm monitoring and interrupt controls
- Persistent change tracking and undo commands

What to expect at this stage:

- Core workflows are implemented and production-style in structure
- Some ergonomics and guardrails will continue improving in subsequent releases
- Documentation and testing depth will expand after this initial public version

## Table of Contents

- [Release Status](#release-status)
- [Why AgentX](#why-agentx)
- [Core Features](#core-features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [CLI Commands](#cli-commands)
- [MCP Integration](#mcp-integration)
- [Swarm Orchestration](#swarm-orchestration)
- [Troubleshooting](#troubleshooting)
- [Post-v0.1.0 Roadmap](#post-v010-roadmap)

## Why AgentX

Most terminal coding agents are tightly bound to a single provider or specific tool-call protocol. AgentX focuses on portability:

- Provider abstraction: switch provider/model/tier at runtime
- Protocol abstraction: XML tool calls work even with models that do not support native function calling
- Orchestration abstraction: use built-in swarm orchestration or bridge to external MCP-based systems

This allows one runtime to serve as a practical control plane for coding tasks, memory hooks, and parallel worker execution.

## Core Features

- Interactive terminal UI with streaming responses
- ReAct loop with tool execution and loop detection
- XML tool call parser and tool result feedback cycle
- Built-in file, edit, search, directory, and shell tools
- MCP client manager with dynamic tool discovery and bridging
- Optional RuFlo-style memory/hook wrappers via MCP
- Multi-agent swarm execution with role-aware workers
- Undo support for agent-made file changes

## Architecture

AgentX has four main layers:

1. Provider Layer
- Normalizes LLM calls (`chat`, `complete`, `listModels`) across providers.

2. Agent Loop Layer
- Conversation manager + system prompt builder + XML parser + ReAct loop.

3. Tool Layer
- Tool registry + built-in tools + MCP tool bridge.

4. Orchestration Layer
- Terminal UX, MCP integration, and swarm worker management.

High-level loop:

1. User submits prompt.
2. Agent sends system + history + user messages to provider.
3. Model streams response.
4. If response includes `<tool_call ...>...</tool_call>`, tools execute.
5. Tool output is injected back as `<tool_result ...>`.
6. Loop continues until no tool call is emitted or max iterations is reached.

## Tech Stack

- Runtime: Node.js (ESM)
- Language: TypeScript
- CLI: commander
- Terminal UX: readline + chalk
- Config: YAML
- MCP: `@modelcontextprotocol/sdk`
- Tests: Jest

## Project Structure

```text
agentx/
├── bin/
│   └── agentx.ts                 # CLI entrypoint
├── src/
│   ├── agent/
│   │   ├── index.ts              # Agent module exports
│   │   ├── conversation.ts       # Message history, truncation
│   │   ├── kv-cache.ts           # Key-value cache for agent state
│   │   ├── react-loop.ts         # ReAct reason-act-observe loop
│   │   ├── system-prompt.ts      # Dynamic prompt with tool schema
│   │   └── xml-parser.ts         # XML tool call parser
│   ├── cli/
│   │   └── terminal.ts           # Terminal UI + slash commands + swarm controls
│   ├── config/
│   │   └── loader.ts             # ~/.agentx/config.yaml loader
│   ├── mcp/
│   │   ├── index.ts              # MCP module exports
│   │   ├── client.ts             # MCP stdio client + tool discovery
│   │   ├── memory-bridge.ts      # Convenience wrappers for memory/hooks tools
│   │   └── tool-bridge.ts        # MCP tool -> AgentX tool mapping
│   ├── memory/                   # Memory management utilities
│   ├── providers/
│   │   ├── base.ts
│   │   ├── ollama.ts
│   │   ├── openai-compatible.ts
│   │   └── registry.ts
│   ├── swarm/
│   │   ├── index.ts              # Swarm module exports
│   │   ├── coordinator.ts        # Swarm coordination logic
│   │   ├── ruflo-bridge.ts       # RuFlo integration bridge
│   │   ├── ruflo-status-reporter.ts # Live status reporting
│   │   ├── spawner.ts            # Worker process spawning
│   │   ├── task-decomposer.ts    # Task breakdown and planning
│   │   ├── task-memory-manager.ts # Task state persistence
│   │   ├── task-queue.ts         # Task queue management
│   │   └── worker.ts             # Worker process implementation
│   └── tools/
│       ├── index.ts              # Tool module exports
│       ├── change-tracker.ts     # File change tracking for undo
│       ├── edit-file.ts          # Text replacement tool
│       ├── list-dir.ts           # Directory listing tool
│       ├── read-file.ts          # File reading tool
│       ├── registry.ts           # Tool registration system
│       ├── run-command.ts        # Shell command execution
│       ├── search-files.ts       # Recursive file search
│       └── write-file.ts         # File writing tool
├── memory/
│   └── CONTEXT.md
├── .agentdb/                     # AgentDB vector database storage
├── .claude/                      # Claude configuration
├── .claude-flow/                 # Claude-flow integration
├── .github/                      # GitHub workflows and config
├── .env.example                  # Environment variable template
├── .mcp.json                     # MCP server configuration
├── docker-compose.yml            # Docker configuration
├── package.json
├── tsconfig.json
└── CLAUDE.md                     # Claude Code instructions
```

## Requirements

- Node.js 18+
- npm
- One LLM provider endpoint:
  - OpenAI-compatible API (for example InfinitAI/OpenAI/Groq/Together-style)
  - or local Ollama

Optional:

- MCP-compatible server(s)
- RuFlo MCP server if you want hybrid RuFlo+AgentX orchestration

## Installation

### From npm (Recommended)

```bash
# Run directly without installing
npx agentx-runtime

# Or install globally
npm install -g agentx-runtime
agentx
```

### From Source

```bash
git clone https://github.com/GANESH4511/AgentX.git
cd AgentX
npm install
npm run build
```

## Quick Start

### Using npx (Quickest)

```bash
# 1. Set your API key
# PowerShell:
$env:INFINITAI_API_KEY = "your_key_here"
# Bash:
export INFINITAI_API_KEY="your_key_here"

# 2. Run AgentX
npx agentx-runtime --init   # First time: generates config
npx agentx-runtime          # Start the agent
```

### Using Global Install

```bash
# Install once
npm install -g agentx-runtime

# Run anywhere
agentx --init   # First time: generates config
agentx          # Start the agent
```

### From Source

1. Initialize config:

```bash
npx tsx bin/agentx.ts --init
```

2. Set API key env var (example for InfinitAI/OpenAI-compatible):

PowerShell:

```powershell
$env:INFINITAI_API_KEY = "your_key_here"
```

Bash:

```bash
export INFINITAI_API_KEY="your_key_here"
```

3. Start interactive agent:

```bash
npx tsx bin/agentx.ts
```

4. Try provider/model overrides:

```bash
npx tsx bin/agentx.ts --provider infinitai --tier 3
npx tsx bin/agentx.ts --provider infinitai --model meta/llama-3.3-70b-instruct
```

5. Optional simple chat mode (disable tools):

```bash
npx tsx bin/agentx.ts --no-tools
```

## Configuration

Config path:

- `~/.agentx/config.yaml` (Windows: `%USERPROFILE%\.agentx\config.yaml`)

Generated default config includes:

- Active provider
- Provider definitions (type, base URL, API key, default model, tier models)
- Routing thresholds
- MCP server definitions
- Agent limits (iterations/history)
- Swarm settings

Example:

```yaml
active_provider: infinitai

providers:
  infinitai:
    type: openai-compatible
    base_url: https://infinitai.sifymdp.digital/maas/v1
    api_key: ${INFINITAI_API_KEY}
    default_model: meta/llama-3.3-70b-instruct
    models:
      tier1_fast: meta/llama-3.3-70b-instruct
      tier2_default: meta/llama-3.3-70b-instruct
      tier3_complex: meta/llama-3.3-70b-instruct

routing:
  auto_tier: true
  complexity_threshold_low: 0.3
  complexity_threshold_high: 0.7

mcp:
  servers:
    - name: ruflo
      command: npx
      args: ["-y", "@claude-flow/cli@latest", "mcp", "start"]

agent:
  max_iterations: 10
  max_history_tokens: 80000
  working_directory: "."

swarm:
  max_agents: 5
  task_timeout_ms: 300000
  auto_spawn: true
  backend: ruflo
```

Notes:

- Environment variables like `${INFINITAI_API_KEY}` are substituted at load time.
- Snake case keys in YAML are normalized to camelCase internally.

## CLI Commands

Main command:

```bash
npx tsx bin/agentx.ts [options]
```

Options:

- `-p, --provider <name>`: choose provider
- `-m, --model <name>`: choose explicit model
- `-t, --tier <1|2|3>`: choose tier model
- `-d, --dir <path>`: set working directory
- `--no-tools`: disable tool mode
- `--init`: generate default config

Subcommands:

- `config`: print config location
- `providers`: list configured providers
- `models`: fetch models from active provider
- `mcp-add <name> <command> [args...]`: add MCP server entry to config

Examples:

```bash
npx tsx bin/agentx.ts providers
npx tsx bin/agentx.ts models
npx tsx bin/agentx.ts config
npx tsx bin/agentx.ts mcp-add filesystem npx -y @modelcontextprotocol/server-filesystem .
```

## In-Chat Slash Commands

During interactive mode:

- `/help`
- `/clear`
- `/history`
- `/status`
- `/provider <name>` or `/p <name>`
- `/providers`
- `/model <name>` or `/m <name>`
- `/models`
- `/tier <1|2|3>` or `/t <1|2|3>`
- `/swarm <task>`
- `/swarm status`
- `/swarm clear`
- `/swarm kill`
- `/swarm backend [ruflo|agentx|hybrid]`
- `/undo`
- `/undo list`
- `/undo all`
- `/undo <N>`
- `/undo clear`
- `/exit`

Keyboard shortcuts:

- `Ctrl+X`: interrupt running swarm or command
- `Ctrl+T`: live swarm status

## Tool System (XML Protocol)

AgentX expects the model to produce tool calls as XML blocks.

Example model output:

```xml
I will inspect the file first.

<tool_call name="read_file">
  <path>src/index.ts</path>
</tool_call>
```

AgentX executes the tool and feeds back:

```xml
<tool_result name="read_file" status="success">
<output>
...file content...
</output>
</tool_result>
```

Why XML?

- Works with providers/models that do not support native function calling
- Easy to parse in streamed text responses
- Provider-agnostic behavior across model families

ReAct loop safeguards:

- Max iteration limit
- Repeated failure detection
- Loop-break hint injection

## Built-in Tools

Core tools registered at startup:

- `read_file`: reads full file or line range
- `write_file`: writes or creates files, creates parent directories
- `edit_file`: exact-match text replacement for targeted edits
- `run_command`: executes shell commands with timeout and error hints
- `search_files`: recursive pattern search with filtering and ignores
- `list_dir`: structured directory listing

Built-in safety controls include:

- Output truncation for large command output
- File size and line limits for reads
- Ignore lists for recursive search/list operations
- Command timeout handling

## MCP Integration

AgentX can connect to one or many MCP servers over stdio.

What happens on startup:

1. Connect to configured MCP servers in parallel.
2. Run `tools/list` and discover tool schemas.
3. Convert each MCP tool to an AgentX tool definition.
4. Prefix names as `mcp_<server>_<tool>` to avoid collisions.

Parameter handling:

- XML values come in as strings.
- MCP bridge coerces values back using each tool's JSON Schema:
  - number/integer -> Number
  - boolean -> bool coercion
  - array/object -> JSON parse attempt

If you use RuFlo MCP tools, AgentX can also use typed memory helpers (`memory_search`, `memory_store`, hooks, etc.) through the memory bridge.

## Swarm Orchestration

AgentX supports three swarm backends:

- `ruflo`: RuFlo orchestration + AgentX worker execution
- `agentx`: pure in-process AgentX swarm coordinator
- `hybrid`: RuFlo state + AgentX worker execution

Swarm flow (typical):

1. Create high-level task.
2. Spawn role-specific workers (`coder`, `tester`, `reviewer`, etc.).
3. Dispatch tasks via queue.
4. Workers run headless ReAct loops in child processes.
5. Aggregate results/errors and report status.

Worker process behavior:

- Receives newline-delimited JSON commands over stdin
- Executes assigned task with tools
- Streams progress + returns result/error over stdout JSON
- Handles ping/pong and graceful shutdown

## Undo and Change Tracking

Agent file modifications are tracked by a persistent change tracker.

Tracked operations:

- file create
- file update

Undo capabilities:

- Undo last change
- Undo last N changes
- Undo all changes in session history
- View tracked changes with timestamps

Persistence location:

- `~/.agentx/undo-history.json`

## Programmatic API

You can also consume AgentX modules directly from TypeScript/Node.

Exports are available from:

- `src/index.ts`

Key exported modules include:

- Provider interfaces and implementations
- Conversation and terminal classes
- Config loader
- MCP manager/bridge
- Swarm coordinator/spawner/task queue

## Development

Build:

```bash
npm run build
```

Type-check only:

```bash
npx tsc --noEmit
```

Start from compiled output (after build):

```bash
node dist/bin/agentx.js
```

Notes:

- `npm start` in current `package.json` points to `dist/src/index.js`.
- For interactive CLI usage, prefer `node dist/bin/agentx.js` or `npx tsx bin/agentx.ts`.

## Testing

Run tests:

```bash
npm test
```

Jest is configured with Node test environment.

## Troubleshooting

1. Provider fails with auth or 401
- Confirm API key env var is set in current shell.
- Confirm `base_url` and model id are valid for your provider.

2. No models shown in `/models`
- Some endpoints do not support `/models`; provider may return empty list.
- Try explicit `--model` values known to your provider.

3. MCP server connection fails
- Validate command/args in config.
- Test the MCP server command manually in terminal.
- Remove or fix invalid server entries.

4. Swarm interruption not working as expected
- Use `Ctrl+X` to interrupt running swarm tasks.
- Use `Ctrl+T` to inspect live status.

5. Tool loop/retries
- Increase task specificity in prompt.
- Switch to a stronger tier/model for more reliable tool formatting.

## Post-v0.1.0 Roadmap

- Add unregister support in `ToolRegistry` for dynamic MCP refresh cleanup
- Add richer policy controls for `run_command`
- Improve structured logs and tracing for swarm workers
- Add more granular test coverage for parser/tool-bridge/worker IPC
- Publish package with global `agentx` bin entry

## License

MIT
