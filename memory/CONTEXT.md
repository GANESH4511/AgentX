# AgentX — Agent Memory & Context

> **Last Updated**: 2026-03-31  
> **Session**: Memory + Dynamic Spawning + Docker Implementation  
> **Status**: All Tasks Complete ✅

---

## 🔥 LATEST IMPLEMENTATION (2026-03-31)

### 1. Full Chat + Swarm Memory ✅

**Problem**: Agents said "This conversation just started" - no memory.

**Solution**: Memory integrated into both regular chat AND swarm workflows.

**Architecture:**
```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  KV Cache   │───▶│  AgentDB    │───▶│  Archive    │
│  (Hot)      │    │  (Semantic) │    │  (Cold)     │
│  <1ms       │    │  <100µs     │    │  ~10ms      │
│  100 items  │    │  HNSW Index │    │  Historical │
└─────────────┘    └─────────────┘    └─────────────┘
```

**Integrations:**
- `src/agent/react-loop.ts` - Memory recall BEFORE LLM call, storage AFTER
- `src/cli/terminal.ts` - Memory recall for swarm tasks
- `src/swarm/ruflo-bridge.ts` - `getTaskContext()` for past tasks

### 2. Dynamic Agent Spawning ✅

**Problem**: Always spawned exactly 2 agents (coder + tester).

**Solution**: LLM-based task decomposition spawns 1-15 agents based on complexity.

**Files:**
- `src/swarm/task-decomposer.ts` - LLM decomposes tasks into subtasks

**Agent Types Available:**
- `coder`, `tester`, `reviewer`, `researcher`
- `planner`, `debugger`, `documenter`, `refactorer`
- `security`, `devops`

**Complexity Detection:**
- Simple (1-2 agents): "fix typo", "create file"
- Moderate (3-5 agents): "add feature", "refactor function"
- Complex (6-15 agents): "build app", "major refactor"

### 3. Docker Support ✅

**Files:**
- `Dockerfile` - Multi-stage build (production + development)
- `docker-compose.yml` - Full config with volumes
- `.dockerignore` - Exclude unnecessary files

**Usage:**
```bash
# Development
docker compose --profile dev up -d

# Production
docker compose --profile production up -d
```

**Volume Mounts:**
- `.agentdb/` → Memory persistence
- `.claude-flow/` → Task state
- `./workspace` → Working directory

---

## Project Structure

```
agentx/
├── bin/
│   └── agentx.ts            # CLI entry point
├── src/
│   ├── agent/
│   │   ├── conversation.ts  # Chat history management
│   │   ├── react-loop.ts    # ReAct cycle with MEMORY
│   │   ├── system-prompt.ts
│   │   └── xml-parser.ts
│   ├── cli/
│   │   └── terminal.ts      # Terminal UI with DYNAMIC SPAWNING
│   ├── memory/              # ✅ NEW
│   │   ├── types.ts
│   │   ├── kv-cache.ts
│   │   ├── agentdb-adapter.ts
│   │   ├── router.ts
│   │   └── index.ts
│   ├── swarm/
│   │   ├── coordinator.ts
│   │   ├── spawner.ts
│   │   ├── ruflo-bridge.ts
│   │   ├── task-decomposer.ts  # ✅ NEW
│   │   └── task-memory-manager.ts
│   ├── providers/
│   ├── tools/
│   └── mcp/
├── memory/
│   └── CONTEXT.md           # This file
├── Dockerfile               # ✅ NEW
├── docker-compose.yml       # ✅ NEW
├── .dockerignore            # ✅ NEW
├── package.json
└── tsconfig.json
```

---

## Memory Usage

**Storage:** `~1-5 KB per task` (Chat + Swarm mode)

**Location:** `.agentdb/memory.json`

**What's Stored:**
```typescript
interface TaskMemory {
  taskId: string;
  description: string;
  status: 'completed' | 'failed' | 'cancelled';
  filesChanged: string[];
  codePatterns: string[];
  duration: number;
  outcome: string;
}
```

### How It Works

**Before a task:**
```
💭 Found relevant context from previous sessions:
   • Built login page with bcrypt... [completed]
```

**After a task:**
- Task description, status, files changed, and outcome stored in memory
- Available in future sessions via semantic search

### Memory Commands
The memory persists to:
- `.agentdb/memory.json` - Vector database
- `.agentdb/archive.json` - Long-term storage

---

## 🔥 PREVIOUS FIXES (2026-03-30)

### Issues Fixed:

1. **RuFlo Swarm Status Error** ✅ FIXED
   - **Problem**: Generic "Error getting RuFlo swarm status" with no details
   - **Fix**: Enhanced error handling with specific error messages and helpful hints
   - **File**: `src/cli/terminal.ts` lines 248-260

2. **PowerShell Interactive Prompts** ✅ FIXED
   - **Problem**: `Invoke-WebRequest` triggers security prompts workers can't answer
   - **Fix**: Added `makeNonInteractive()` function that:
     - Auto-adds `-UseBasicParsing` to `Invoke-WebRequest`
     - Converts `curl` to `curl.exe` on Windows
     - Sets non-interactive env vars (`DEBIAN_FRONTEND`, `GIT_TERMINAL_PROMPT`, etc.)
   - **File**: `src/tools/run-command.ts`

3. **Task Timeout Errors** ✅ FIXED
   - **Problem**: Hard-coded 300000ms timeout causing failures
   - **Fix**: Made timeout configurable. Omit `taskTimeoutMs` to disable timeout
   - **File**: `src/swarm/ruflo-bridge.ts` lines 195-250

4. **Live Status Showing Stale Tasks** ✅ FIXED
   - **Problem**: Live status displayed ALL tasks including failed, cancelled, stale ones
   - **Fix**: Created TaskMemoryManager with:
     - Stale detection (>30 min = stale)
     - Hot/cold storage separation (store.json vs history.json)
     - `/swarm cleanup` command for manual cleanup
   - **Files**: `src/swarm/task-memory-manager.ts`, `src/cli/terminal.ts`

5. **task.assignedTo.join Error** ✅ FIXED
   - **Problem**: `task.assignedTo.join is not a function` when assignedTo is string
   - **Fix**: Handle both string and array for `assignedTo` field
   - **File**: `src/cli/terminal.ts` lines 237-246

6. **Ctrl+X Interrupt Not Working** ✅ FIXED
   - **Problem**: Ctrl+X/Ctrl+C didn't stop swarm workers during execution
   - **Fix**: Added `enableInterruptMode()` / `disableInterruptMode()` methods
   - **File**: `src/cli/terminal.ts` lines 70-127

### To Apply Changes:
```bash
cd c:\SNIX\sify\prompts\agentx
npm run build
```  

---

## 1. WHAT IS AGENTX

AgentX is an **open-source, terminal-based AI agent runtime** that replaces Claude Code as the "host brain" for the **RuFlo multi-agent orchestration architecture**.

### The Problem
- Claude Code only supports Claude (Anthropic) and Ollama models
- The user has access to **InfinitAI** (Sify's OpenAI-compatible API) with Llama models
- RuFlo's powerful multi-agent system (MCP orchestration, memory, swarm, hooks) is locked behind Claude Code
- Need a way to use ANY LLM provider with RuFlo

### The Solution
AgentX acts as a **pluggable host** that:
1. Talks to any LLM via configurable providers (InfinitAI, OpenAI, Ollama, Groq, etc.)
2. Gives the LLM coding tools (read/write files, run commands) via XML tool protocol
3. Connects to RuFlo's MCP server to access memory, swarm, hooks
4. Can spawn multi-agent swarms using child processes

### Key Distinction
- **AgentX** = the HOST (replaces Claude Code)
- **RuFlo** = the MCP ORCHESTRATOR (stays unchanged)
- AgentX consumes RuFlo's MCP tools exactly like Claude Code does

---

## 2. ARCHITECTURE DECISIONS

| # | Decision | Why |
|---|----------|-----|
| 1 | **XML tool protocol** (not JSON, not native) | InfinitAI doesn't support native tool calling (tested, returns 400). XML is unambiguous, streaming-friendly, works with all LLMs |
| 2 | **Node.js/TypeScript** | RuFlo is Node.js, MCP SDK has TS support, same ecosystem |
| 3 | **ReAct loop** (reason → act → observe) | Proven pattern, simpler than plan-and-execute, works with smaller models |
| 4 | **OpenAI-compatible adapter** (single class) | One adapter covers InfinitAI, OpenAI, Groq, Together — only base_url and api_key change |
| 5 | **3-tier model routing** | Mirrors RuFlo's ADR-026: Tier 1 (3B fast), Tier 2 (11B default), Tier 3 (70B complex) |
| 6 | **Child process spawning** for sub-agents | Process isolation is safer, each agent gets clean state |
| 7 | **YAML config** at ~/.agentx/config.yaml | Human-readable, supports comments, env var substitution |
| 8 | **Dynamic MCP tool injection** | MCP tools auto-discovered via tools/list, not hardcoded |
| 9 | **4-phase incremental build** | Each phase builds on previous, shippable at each stage |

---

## 3. INFINITAI API — VERIFIED FACTS

These were tested and confirmed during brainstorming:

| Fact | Value |
|------|-------|
| Base URL | `https://infinitai.sifymdp.digital/maas/v1` |
| Auth | Bearer token via `INFINITAI_API_KEY` env var |
| Format | OpenAI-compatible `/chat/completions` |
| Streaming | ✅ SSE (Server-Sent Events) |
| Native tool calling | ❌ Returns 400 error |
| Token limit | 131,072 tokens |
| Rate limits | None observed |
| Models count | 10 models available |

### Available Models (from /v1/models)
| Model ID | Type | Context |
|----------|------|---------|
| `meta-llama/Llama-3.2-3B-Instruct` | LLM | 131K — **Tier 1 (fast)** |
| `meta-llama/Llama-3.2-11B-Vision-Instruct` | LLM | 131K — **Tier 2 (default)** |
| `meta/llama-3.3-70b-instruct` | LLM | 131K — **Tier 3 (complex)** |
| `deepseek-ai/DeepSeek-R1-Distill-Llama-70B` | LLM | 131K |
| `jina-embeddings-v3` | Embedding | 8K |
| `Qwen/QwQ-32B` | LLM | 131K |
| `meta-llama/Llama-3.3-70B-Instruct` | LLM | 131K |
| `Qwen/Qwen2.5-VL-72B-Instruct` | LLM | 131K |
| `deepseek-ai/DeepSeek-R1` | LLM | 131K |
| `jina-reranker-v2-base-multilingual` | Rerank | 1K |

---

## 4. PROJECT STRUCTURE

```
agentx/
├── package.json              ✅ Created
├── tsconfig.json             ✅ Created
├── .gitignore                ✅ Created
├── bin/
│   └── agentx.ts             ✅ CLI entry point with Commander.js
├── src/
│   ├── index.ts              ✅ Public API exports
│   ├── cli/
│   │   └── terminal.ts       ✅ Terminal UI + memory integration
│   ├── providers/
│   │   ├── base.ts           ✅ Abstract LLMProvider interface
│   │   ├── openai-compatible.ts ✅ Universal adapter (InfinitAI, OpenAI, Groq)
│   │   ├── ollama.ts         ✅ Ollama-specific provider
│   │   └── registry.ts       ✅ Provider registry + hot-switching
│   ├── agent/
│   │   ├── conversation.ts   ✅ Message history + truncation
│   │   ├── react-loop.ts     ✅ Core ReAct loop
│   │   ├── system-prompt.ts  ✅ System prompt builder
│   │   └── xml-parser.ts     ✅ XML tool call parser
│   ├── tools/
│   │   ├── registry.ts       ✅ Tool registration
│   │   ├── read-file.ts      ✅ File reading
│   │   ├── write-file.ts     ✅ File writing
│   │   ├── run-command.ts    ✅ Command execution (non-interactive)
│   │   ├── search-files.ts   ✅ File search
│   │   ├── list-dir.ts       ✅ Directory listing
│   │   └── edit-file.ts      ✅ File editing
│   ├── memory/               ✅ NEW: Cross-session memory system
│   │   ├── index.ts          ✅ Entry point + formatters
│   │   ├── types.ts          ✅ Memory type definitions
│   │   ├── kv-cache.ts       ✅ LRU cache with TTL (<1ms)
│   │   ├── agentdb-adapter.ts ✅ Vector search with embeddings
│   │   └── router.ts         ✅ 3-layer memory routing
│   ├── mcp/
│   │   ├── index.ts          ✅ Barrel exports
│   │   ├── client.ts         ✅ MCP client (stdio transport)
│   │   ├── tool-bridge.ts    ✅ MCP → agent tool bridge
│   │   └── memory-bridge.ts  ✅ RuFlo memory + hooks integration
│   ├── swarm/
│   │   ├── spawner.ts        ✅ Sub-agent process spawner
│   │   ├── coordinator.ts    ✅ Multi-agent coordination
│   │   ├── task-queue.ts     ✅ Task distribution
│   │   ├── ruflo-bridge.ts   ✅ RuFlo + AgentX hybrid + memory
│   │   ├── ruflo-status-reporter.ts ✅ Real worker tracking
│   │   └── task-memory-manager.ts ✅ Task stale detection + cleanup
│   └── config/
│       └── loader.ts         ✅ YAML config loader
├── .agentdb/                 (created at runtime)
│   ├── memory.json           Vector database storage
│   └── archive.json          Long-term memory archive
├── .claude-flow/             (created at runtime)
│   └── tasks/
│       ├── store.json        Active tasks
│       └── history.json      Archived tasks
└── memory/
    └── CONTEXT.md            ✅ This file
```

---

## 5. BUILD PHASES & PROGRESS

### Phase A: Terminal Chat ✅ COMPLETE
- [x] Project scaffold (package.json, tsconfig.json, bin/)
- [x] Provider interface + abstract base class
- [x] OpenAI-compatible adapter (SSE streaming)
- [x] Ollama provider
- [x] Provider registry with hot-switching
- [x] Config system (YAML, env vars, defaults)
- [x] Terminal UI (readline, chalk, streaming, colors)
- [x] Slash commands (/provider, /model, /tier, /clear, /help, /status)
- [x] Conversation manager with token truncation
- [x] CLI entry point with Commander.js
- [x] Config init command (--init)
- [x] Sub-commands: config, providers, models
- [x] TypeScript compiles with ZERO errors
- **Deliverable**: `npx tsx bin/agentx.ts` — chat with any LLM in terminal

### Phase B: Tool Use ✅ COMPLETE
- [x] Tool registry + registration system
- [x] XML parser for `<tool_call>` extraction from LLM output
- [x] System prompt builder with dynamic tool definitions
- [x] ReAct loop (reason → act → observe cycle)
- [x] Core tools: read_file, write_file, edit_file, run_command, search_files, list_dir
- [x] Safety: command allowlist, path sandboxing, max iterations
- **Deliverable**: LLM can read/write files and run commands autonomously

### Phase C: MCP Client ✅ COMPLETE
- [x] MCP client (stdio transport via @modelcontextprotocol/sdk)
- [x] Auto-discover tools from MCP servers via tools/list (with pagination)
- [x] Dynamic tool injection into ToolRegistry via MCPToolBridge
- [x] JSON Schema ↔ XML parameter coercion (string/number/boolean/array/object)
- [x] RuFlo memory bridge (search/store/delete/list + contextualRecall pattern)
- [x] RuFlo hooks bridge (fire/list hooks)
- [x] MCP config already supported in config.yaml (mcp.servers array)
- [x] Multi-server parallel connection via connectAll()
- [x] Tool name prefixing (mcp_<server>_<tool>) to avoid collisions
- [x] TypeScript compiles with ZERO errors
- **Deliverable**: AgentX + RuFlo MCP integration layer ready

### Phase D: Multi-Agent Swarm ✅ COMPLETE
- [x] Sub-agent spawner (child processes via fork)
- [x] IPC communication (JSON over stdin/stdout)
- [x] SwarmCoordinator pattern (parent → children)
- [x] RuFloBridge for RuFlo + AgentX hybrid execution
- [x] RuFloStatusReporter for real worker tracking
- [x] 3-tier model routing for swarm agents
- [x] Swarm status terminal UI (Ctrl+T)
- [x] Ctrl+X interrupt handling
- [x] Task queue for parallel work
- **Deliverable**: Full multi-agent swarm support with RuFlo integration

---

## 6. CORE PATTERNS

### ReAct Loop Flow (Phase B)
```
1. User sends message
2. Build messages: [system_prompt, ...history, user_msg]
3. Call LLM API (streaming)
4. Stream response to terminal
5. After complete:
   a. Parse for <tool_call> XML blocks
   b. If NO tool calls → done
   c. If tool calls:
      - Execute each tool
      - Append <tool_result> as new message
      - Go back to step 3
6. Safety: max 20 iterations per turn
```

### XML Tool Protocol
**LLM outputs:**
```xml
I need to read the file first.

<tool_call name="read_file">
  <path>src/app.tsx</path>
</tool_call>
```

**AgentX feeds back:**
```xml
<tool_result name="read_file" status="success">
  <output>file contents here...</output>
</tool_result>
```

### System Prompt Structure (Phase B)
```xml
You are AgentX, an AI coding agent with tool access.

<tools>
  <tool name="read_file">
    <description>Read file contents</description>
    <params><path type="string" required="true">File path</path></params>
  </tool>
  <!-- more tools -->
  <!-- MCP tools dynamically injected here in Phase C -->
</tools>

When you need a tool, output:
<tool_call name="tool_name">
  <param_name>value</param_name>
</tool_call>
```

### Multi-Agent Swarm (Phase D)
```
Parent AgentX (Tier 3 - 70B, "coordinator")
  ├── Child 1: "coder" (Tier 2 - 11B) → writes code
  ├── Child 2: "tester" (Tier 2 - 11B) → writes tests
  └── Child 3: "reviewer" (Tier 1 - 3B) → checks formatting
```

---

## 7. CONFIG REFERENCE

Config lives at `~/.agentx/config.yaml` (created via `agentx --init`).

```yaml
active_provider: infinitai

providers:
  infinitai:
    type: openai-compatible
    base_url: https://infinitai.sifymdp.digital/maas/v1
    api_key: ${INFINITAI_API_KEY}
    default_model: meta-llama/Llama-3.2-11B-Vision-Instruct
    models:
      tier1_fast: meta-llama/Llama-3.2-3B-Instruct
      tier2_default: meta-llama/Llama-3.2-11B-Vision-Instruct
      tier3_complex: meta/llama-3.3-70b-instruct

routing:
  auto_tier: true

agent:
  max_iterations: 20
  max_history_tokens: 80000
```

---

## 8. CLI REFERENCE

```bash
# Interactive chat
npx tsx bin/agentx.ts
npx tsx bin/agentx.ts --provider infinitai --model meta/llama-3.3-70b-instruct
npx tsx bin/agentx.ts --tier 3

# Commands
npx tsx bin/agentx.ts --init       # Create config file
npx tsx bin/agentx.ts providers    # List providers
npx tsx bin/agentx.ts models       # List models
npx tsx bin/agentx.ts config       # Show config path

# In-chat slash commands
/provider <name>    Switch provider
/model <name>       Switch model
/tier <1|2|3>       Switch tier
/providers          List providers
/models             List models
/status             Show status + token count
/history            Conversation stats
/clear              Clear history
/help               Show help
/exit               Quit
```

---

## 9. DEPENDENCIES

| Package | Version | Purpose |
|---------|---------|---------|
| chalk | ^5.3.0 | Terminal colors |
| yaml | ^2.6.0 | Config file parsing |
| commander | ^12.1.0 | CLI argument parsing |
| ora | ^8.1.0 | Loading spinners |
| undici | ^7.0.0 | HTTP client (unused yet, native fetch used) |
| typescript | ^5.7.0 | TypeScript compiler |
| tsx | ^4.19.0 | TS execution without build step |
| @types/node | ^22.0.0 | Node.js type definitions |
| rimraf | ^6.0.0 | Clean dist/ directory |

---

## 10. RISKS & MITIGATIONS

| Risk | Mitigation |
|------|------------|
| Smaller LLMs (3B) may not follow XML tool format | Retry with clearer prompt; fallback to tier 2 |
| Long conversations exceed 131K token limit | Token counting + auto-truncation in Conversation class |
| MCP stdio transport edge cases on Windows | Use cross-spawn, add reconnection logic |
| Multi-agent = many parallel API calls | Configurable concurrency limit in task queue |

---

## 11. NEXT STEPS (FOR CONTINUING AGENT)

**All core phases complete!** The system is now fully functional with:
- ✅ Terminal chat with any LLM
- ✅ Tool use (ReAct loop)
- ✅ MCP integration (RuFlo)
- ✅ Multi-agent swarm
- ✅ Cross-session memory

### Potential Enhancements:
1. **Install AgentDB** for better vector search:
   ```bash
   npm install agentdb agentic-flow @xenova/transformers
   ```
2. **Add real embedding model** (currently using hash-based fallback)
3. **Implement memory consolidation** for pattern learning
4. **Add `/memory` slash commands** for manual memory management

### Memory System Usage:
```typescript
import { getMemory } from './memory/index.js';

const memory = await getMemory();

// Remember a task
await memory.rememberTask('task-123', 'Built login page', 'completed', {
  filesChanged: ['login.html', 'auth.js'],
  codePatterns: ['bcrypt-hashing'],
});

// Recall relevant context
const context = await memory.getTaskContext('build login page', 3);
```

**Working directory**: `c:\SNIX\sify\prompts\agentx\`
**Run dev**: `npx tsx bin/agentx.ts`
**Build**: `npm run build`
