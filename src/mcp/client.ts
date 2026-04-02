/**
 * AgentX — MCP Client
 * 
 * Connects to MCP servers via stdio transport, discovers available tools,
 * and provides a clean interface for executing MCP tool calls.
 * 
 * Each MCP server runs as a child process communicating over stdin/stdout
 * using the Model Context Protocol (JSON-RPC over stdio).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';

// ─── Types ──────────────────────────────────────────────────────

export interface MCPServerConfig {
  /** Unique name for this server (e.g., "ruflo", "filesystem") */
  name: string;
  /** Command to spawn the server process */
  command: string;
  /** Arguments passed to the command */
  args: string[];
  /** Optional environment variables for the server process */
  env?: Record<string, string>;
  /** Optional working directory */
  cwd?: string;
}

export interface MCPTool {
  /** Tool name as reported by the server */
  name: string;
  /** Human-readable description */
  description: string;
  /** JSON Schema for tool input parameters */
  inputSchema: {
    type: 'object';
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  /** The MCP server this tool belongs to */
  serverName: string;
}

export interface MCPToolCallResult {
  /** Text content from the tool response */
  content: string;
  /** Whether the tool call resulted in an error */
  isError: boolean;
}

// ─── MCP Connection ─────────────────────────────────────────────

interface MCPConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: MCPTool[];
  serverName: string;
}

// ─── MCP Client Manager ────────────────────────────────────────

export class MCPClientManager {
  private connections: Map<string, MCPConnection> = new Map();

  /**
   * Connect to an MCP server and discover its tools.
   * Returns the list of tools available from this server.
   */
  async connect(config: MCPServerConfig): Promise<MCPTool[]> {
    // Don't reconnect if already connected
    if (this.connections.has(config.name)) {
      const existing = this.connections.get(config.name)!;
      return existing.tools;
    }

    // On Windows, wrap npx/npm commands with cmd.exe to avoid ENOENT
    let command = config.command;
    let args = config.args ?? [];
    const isWindows = process.platform === 'win32';
    
    if (isWindows && (command === 'npx' || command === 'npm' || command === 'node')) {
      args = ['/c', command, ...args];
      command = 'cmd';
    }

    const serverParams: StdioServerParameters = {
      command,
      args,
      env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
    };

    const transport = new StdioClientTransport(serverParams);

    const client = new Client(
      { name: 'agentx', version: '0.1.0' },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
    } catch (error: any) {
      throw new Error(
        `Failed to connect to MCP server "${config.name}" ` +
        `(${config.command} ${(config.args ?? []).join(' ')}): ${error.message}`
      );
    }

    // Discover tools
    const tools = await this.discoverTools(client, config.name);

    this.connections.set(config.name, {
      client,
      transport,
      tools,
      serverName: config.name,
    });

    return tools;
  }

  /**
   * Discover all tools from an MCP server.
   * Handles pagination via nextCursor.
   */
  private async discoverTools(client: Client, serverName: string): Promise<MCPTool[]> {
    const allTools: MCPTool[] = [];
    let cursor: string | undefined;

    do {
      const response = await client.listTools(cursor ? { cursor } : undefined);

      for (const tool of response.tools) {
        allTools.push({
          name: tool.name,
          description: tool.description ?? 'No description',
          inputSchema: tool.inputSchema as MCPTool['inputSchema'],
          serverName,
        });
      }

      cursor = response.nextCursor;
    } while (cursor);

    return allTools;
  }

  /**
   * Call a tool on an MCP server.
   * The serverName is used to route the call to the correct connection.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<MCPToolCallResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      return {
        content: `MCP server "${serverName}" is not connected`,
        isError: true,
      };
    }

    try {
      const result = await connection.client.callTool({
        name: toolName,
        arguments: args,
      });

      // Extract text content from the result
      // The MCP SDK returns CallToolResult which has `content` array
      const textParts: string[] = [];
      const resultAny = result as any;

      if (resultAny.content && Array.isArray(resultAny.content)) {
        for (const part of resultAny.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            textParts.push(part.text);
          } else if (part.type === 'resource' && part.resource?.text) {
            textParts.push(part.resource.text);
          }
        }
      }

      return {
        content: textParts.join('\n') || 'Tool executed successfully (no output)',
        isError: resultAny.isError === true,
      };
    } catch (error: any) {
      return {
        content: `MCP tool call failed: ${error.message}`,
        isError: true,
      };
    }
  }

  /**
   * Get all tools from all connected servers.
   */
  getAllTools(): MCPTool[] {
    const tools: MCPTool[] = [];
    for (const connection of this.connections.values()) {
      tools.push(...connection.tools);
    }
    return tools;
  }

  /**
   * Get tools from a specific server.
   */
  getServerTools(serverName: string): MCPTool[] {
    return this.connections.get(serverName)?.tools ?? [];
  }

  /**
   * Get the server name that owns a given tool.
   * Returns undefined if the tool is not found in any connected server.
   */
  findToolServer(toolName: string): string | undefined {
    for (const connection of this.connections.values()) {
      if (connection.tools.some(t => t.name === toolName)) {
        return connection.serverName;
      }
    }
    return undefined;
  }

  /**
   * Disconnect from a specific MCP server.
   */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;

    try {
      await connection.transport.close();
    } catch {
      // Ignore close errors — process may have already exited
    }

    this.connections.delete(serverName);
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.allSettled(names.map(name => this.disconnect(name)));
  }

  /**
   * Get the names of all connected servers.
   */
  getConnectedServers(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Check if a specific server is connected.
   */
  isConnected(serverName: string): boolean {
    return this.connections.has(serverName);
  }

  /**
   * Refresh tools from a specific server (e.g., after tools/list_changed).
   */
  async refreshTools(serverName: string): Promise<MCPTool[]> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const tools = await this.discoverTools(connection.client, serverName);
    connection.tools = tools;
    return tools;
  }

  /**
   * Connect to multiple MCP servers in parallel.
   * Returns a map of server names → tools (or errors).
   */
  async connectAll(
    configs: MCPServerConfig[]
  ): Promise<Map<string, { tools?: MCPTool[]; error?: string }>> {
    const results = new Map<string, { tools?: MCPTool[]; error?: string }>();

    const settled = await Promise.allSettled(
      configs.map(async (config) => {
        const tools = await this.connect(config);
        return { name: config.name, tools };
      })
    );

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const name = configs[i].name;

      if (result.status === 'fulfilled') {
        results.set(name, { tools: result.value.tools });
      } else {
        results.set(name, { error: result.reason?.message ?? 'Unknown error' });
      }
    }

    return results;
  }
}
