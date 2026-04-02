#!/usr/bin/env node
/**
 * AgentX CLI Entry Point
 * 
 * The main executable that starts the AgentX terminal agent.
 * Usage: npx agentx [options]
 */

import { Command, type OptionValues } from 'commander';
import { loadConfig, initConfig, getConfigPath } from '../src/config/loader.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Conversation } from '../src/agent/conversation.js';
import { Terminal } from '../src/cli/terminal.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ReactLoop } from '../src/agent/react-loop.js';
import { createReadFileTool } from '../src/tools/read-file.js';
import { createWriteFileTool } from '../src/tools/write-file.js';
import { createEditFileTool } from '../src/tools/edit-file.js';
import { createRunCommandTool } from '../src/tools/run-command.js';
import { createSearchFilesTool } from '../src/tools/search-files.js';
import { createListDirTool } from '../src/tools/list-dir.js';
import { MCPClientManager } from '../src/mcp/client.js';
import { MCPToolBridge } from '../src/mcp/tool-bridge.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('agentx')
  .description('⚡ AgentX — Terminal AI Agent Runtime')
  .version('0.1.0')
  .option('-p, --provider <name>', 'LLM provider to use')
  .option('-m, --model <name>', 'Model to use')
  .option('-t, --tier <number>', 'Model tier (1=fast, 2=default, 3=complex)', '2')
  .option('-d, --dir <path>', 'Working directory (default: cwd)')
  .option('--no-tools', 'Disable tool use (simple chat mode)')
  .option('--init', 'Initialize config file at ~/.agentx/config.yaml')
  .action(async (opts: OptionValues) => {
    // Handle --init
    if (opts.init) {
      const path = initConfig();
      console.log(chalk.green(`✓ Config created at: ${path}`));
      console.log(chalk.dim('  Edit this file to add providers and API keys.'));
      return;
    }

    try {
      await startAgent(opts);
    } catch (error: any) {
      console.error(chalk.red(`\n  Fatal: ${error.message}\n`));
      process.exit(1);
    }
  });

// Sub-command: config
program
  .command('config')
  .description('Manage AgentX configuration')
  .action(() => {
    console.log(chalk.dim(`  Config file: ${getConfigPath()}`));
    console.log(chalk.dim('  Run: agentx --init  to create default config'));
  });

// Sub-command: providers
program
  .command('providers')
  .description('List configured providers')
  .action(() => {
    const config = loadConfig();
    console.log(chalk.bold('\n  Configured Providers:\n'));
    for (const [name, pConfig] of Object.entries(config.providers)) {
      const isActive = name === config.activeProvider;
      const marker = isActive ? chalk.green('● ') : chalk.dim('○ ');
      const modelShort = pConfig.defaultModel.split('/').pop();
      console.log(`  ${marker}${chalk.blue(name)} → ${chalk.dim(pConfig.type)} (${modelShort})`);
    }
    console.log('');
  });

// Sub-command: models
program
  .command('models')
  .description('List models from the active provider')
  .action(async () => {
    const config = loadConfig();
    const registry = buildRegistry(config);
    registry.setActive(config.activeProvider);
    const provider = registry.getActive();

    console.log(chalk.dim(`\n  Fetching models from ${config.activeProvider}...\n`));

    try {
      const models = await provider.listModels();
      for (const model of models) {
        const tokens = model.maxTokens ? chalk.dim(` (${(model.maxTokens / 1000).toFixed(0)}K)`) : '';
        const type = model.type !== 'llm' ? chalk.yellow(` [${model.type}]`) : '';
        console.log(`  ${chalk.blue(model.id)}${tokens}${type}`);
      }
      console.log('');
    } catch (error: any) {
      console.error(chalk.red(`  Error: ${error.message}`));
    }
  });

// Sub-command: mcp add
program
  .command('mcp-add')
  .description('Add an MCP server to config')
  .argument('<name>', 'Server name (e.g., "filesystem")')
  .argument('<command>', 'Command to run (e.g., "npx")')
  .argument('[args...]', 'Arguments for the command')
  .action(async (name: string, command: string, args: string[]) => {
    const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
    const { parse, stringify } = await import('yaml');
    const configPath = getConfigPath();

    if (!existsSync(configPath)) {
      console.error(chalk.red('  Config file not found. Run: agentx --init'));
      return;
    }

    const raw = readFileSync(configPath, 'utf-8');
    const config = parse(raw);

    // Check if server already exists
    if (config.mcp?.servers?.some((s: any) => s.name === name)) {
      console.error(chalk.red(`  Server "${name}" already exists in config`));
      return;
    }

    // Add the server
    if (!config.mcp) config.mcp = {};
    if (!config.mcp.servers) config.mcp.servers = [];

    config.mcp.servers.push({
      name,
      command,
      args: args.length > 0 ? args : [],
    });

    // Write back
    writeFileSync(configPath, stringify(config), 'utf-8');

    console.log(chalk.green(`\n  ✓ Added MCP server "${name}"`));
    console.log(chalk.dim(`    Command: ${command} ${args.join(' ')}`));
    console.log(chalk.dim(`\n  Restart AgentX to connect.\n`));
  });

/**
 * Build a ProviderRegistry from config.
 */
function buildRegistry(config: ReturnType<typeof loadConfig>): ProviderRegistry {
  const registry = new ProviderRegistry();

  for (const [name, pConfig] of Object.entries(config.providers)) {
    registry.register(name, {
      type: pConfig.type,
      baseUrl: pConfig.baseUrl,
      apiKey: pConfig.apiKey,
      defaultModel: pConfig.defaultModel,
      models: pConfig.models ? {
        tier1Fast: pConfig.models.tier1Fast,
        tier2Default: pConfig.models.tier2Default,
        tier3Complex: pConfig.models.tier3Complex,
      } : undefined,
    });
  }

  return registry;
}

/**
 * Register all built-in tools.
 */
function registerTools(workingDir: string, mcpBridge?: MCPToolBridge | null): ToolRegistry {
  const tools = new ToolRegistry();

  tools.register(createReadFileTool(workingDir));
  tools.register(createWriteFileTool(workingDir));
  tools.register(createEditFileTool(workingDir));
  tools.register(createRunCommandTool(workingDir));
  tools.register(createSearchFilesTool(workingDir));
  tools.register(createListDirTool(workingDir));

  // Register MCP tools if available
  if (mcpBridge) {
    const mcpTools = mcpBridge.getAllTools();
    for (const mcpTool of mcpTools) {
      tools.register(mcpTool);
    }
  }

  return tools;
}

/**
 * Main agent loop.
 */
async function startAgent(opts: {
  provider?: string;
  model?: string;
  tier?: string;
  dir?: string;
  tools?: boolean;
  init?: boolean;
}): Promise<void> {
  // Load config
  const config = loadConfig();
  const { resolve } = await import('node:path');
  const workingDir = opts.dir ? resolve(opts.dir) : process.cwd();
  const toolsEnabled = opts.tools !== false;

  // Set up provider registry
  const registry = buildRegistry(config);

  // Set active provider (CLI flag > config)
  const activeProvider = opts.provider || config.activeProvider;
  
  if (!registry.has(activeProvider)) {
    throw new Error(
      `Provider "${activeProvider}" not configured. ` +
      `Available: ${registry.listNames().join(', ')}. ` +
      `Run: agentx --init`
    );
  }

  registry.setActive(activeProvider);

  // Initialize MCP servers
  const mcpManager = new MCPClientManager();
  let mcpBridge: MCPToolBridge | null = null;

  if (config.mcp.servers.length > 0) {
    console.log(chalk.dim(`\n  Connecting to ${config.mcp.servers.length} MCP server(s)...`));

    try {
      const results = await mcpManager.connectAll(config.mcp.servers);
      let totalTools = 0;

      for (const [name, result] of results) {
        if (result.tools) {
          console.log(chalk.green(`  ✓ ${name}: ${result.tools.length} tools`));
          totalTools += result.tools.length;
        } else {
          console.log(chalk.yellow(`  ⚠ ${name}: ${result.error}`));
        }
      }

      if (totalTools > 0) {
        mcpBridge = new MCPToolBridge(mcpManager);
        console.log(chalk.dim(`  Total ${totalTools} MCP tools available\n`));
      }
    } catch (error: any) {
      console.log(chalk.yellow(`  ⚠ MCP connection failed: ${error.message}\n`));
    }
  }

  // Create conversation
  const conversation = new Conversation(config.agent.maxHistoryTokens);

  // Create terminal UI
  const terminal = new Terminal(registry, conversation, mcpBridge || undefined);

  // Set model from CLI flags
  if (opts.model) {
    terminal.setActiveModel(opts.model);
  } else if (opts.tier) {
    const tier = parseInt(opts.tier) as 1 | 2 | 3;
    const provider = registry.getActive();
    terminal.setActiveModel(provider.getModelForTier(tier));
  }

  // Show welcome
  terminal.showBanner();

  if (toolsEnabled) {
    // ─── Phase B: Agent Mode (ReAct Loop with Tools) ────────────
    const tools = registerTools(workingDir, mcpBridge);
    terminal.showInfo(`${tools.count} tools loaded • Agent mode active`);

    const reactLoop = new ReactLoop(
      registry.getActive(),
      tools,
      conversation,
      terminal,
    );

    // Initialize system prompt with tool definitions
    reactLoop.initialize(workingDir);

    // Main agent loop
    while (true) {
      const input = await terminal.prompt();
      if (!input) continue;

      // Handle slash commands
      const wasCommand = await terminal.processSlashCommand(input);
      if (wasCommand) {
        // Re-initialize system prompt if provider/model changed
        reactLoop.setProvider(registry.getActive());
        continue;
      }

      // Run the ReAct loop
      try {
        await reactLoop.run(input, {
          maxIterations: config.agent.maxIterations,
          model: terminal.getActiveModel(),
          temperature: 0.7,
          maxTokens: 4096,
          workingDir,
        });
      } catch (error: any) {
        terminal.showError(error.message);
      }
    }
  } else {
    // ─── Phase A Fallback: Simple Chat Mode ─────────────────────
    conversation.setSystemPrompt(
      'You are AgentX, a helpful AI coding assistant running in the terminal. ' +
      'Be concise and direct. Use code blocks for code examples.'
    );

    terminal.showInfo('Simple chat mode (tools disabled)');

    while (true) {
      const input = await terminal.prompt();
      if (!input) continue;

      const wasCommand = await terminal.processSlashCommand(input);
      if (wasCommand) continue;

      conversation.addUser(input);

      const provider = registry.getActive();
      const model = terminal.getActiveModel();

      try {
        const stream = provider.chat(conversation.getMessages(), {
          model,
          maxTokens: 4096,
          temperature: 0.7,
        });

        const response = await terminal.streamResponse(stream);
        conversation.addAssistant(response);
      } catch (error: any) {
        terminal.showError(error.message);
      }
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(chalk.dim('\n\n  Goodbye! 👋\n'));
  process.exit(0);
});

program.parse();
