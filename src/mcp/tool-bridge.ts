/**
 * AgentX — MCP Tool Bridge
 * 
 * Converts MCP tools (discovered from MCP servers) into AgentX ToolDefinition
 * objects and registers them in the ToolRegistry. This is the key integration
 * point between the MCP protocol and AgentX's XML tool system.
 * 
 * When the LLM calls an MCP tool via XML, the bridge:
 * 1. Receives the tool name + params from the ToolRegistry
 * 2. Finds which MCP server owns the tool
 * 3. Calls the tool via the MCPClientManager
 * 4. Returns the result in AgentX ToolResult format
 */

import type { ToolDefinition, ToolParam, ToolResult, ToolRegistry } from '../tools/registry.js';
import type { MCPClientManager, MCPTool, MCPServerConfig } from './client.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ToolBridgeStats {
  /** Number of MCP servers connected */
  connectedServers: number;
  /** Total MCP tools registered */
  totalMcpTools: number;
  /** Breakdown by server */
  perServer: Array<{ name: string; toolCount: number }>;
}

// ─── Tool Bridge ────────────────────────────────────────────────

export class MCPToolBridge {
  /** Tracks which MCP-origin tools we've registered (for cleanup) */
  private mcpToolNames: Set<string> = new Set();

  constructor(
    private mcpManager: MCPClientManager,
  ) {}

  /**
   * Get all MCP tools as AgentX ToolDefinitions (for registration).
   */
  getAllTools(): ToolDefinition[] {
    const allMcpTools = this.mcpManager.getAllTools();
    return allMcpTools.map(mcpTool => this.convertMCPTool(mcpTool));
  }

  /**
   * Call an MCP tool directly by name.
   */
  async callTool(serverName: string, toolName: string, params: Record<string, string>): Promise<{ content: string; isError: boolean }> {
    return this.mcpManager.callTool(serverName, toolName, params);
  }

  /**
   * Check if tools from a specific server are available.
   */
  hasToolsFromServer(serverName: string): boolean {
    return this.mcpManager.isConnected(serverName) &&
           this.mcpManager.getServerTools(serverName).length > 0;
  }

  /**
   * Convert an MCP tool into an AgentX ToolDefinition.
   * 
   * The handler proxies calls to the MCPClientManager, converting
   * string params from XML back into the proper types expected by
   * the MCP server via JSON Schema coercion.
   */
  private convertMCPTool(mcpTool: MCPTool): ToolDefinition {
    const prefixedName = `mcp_${mcpTool.serverName}_${mcpTool.name}`;

    // Extract parameters from JSON Schema
    const params = this.extractParams(mcpTool.inputSchema);

    // Build the handler that proxies to MCP
    const handler = async (rawParams: Record<string, string>): Promise<ToolResult> => {
      // Coerce string values back to proper types based on JSON Schema
      const coerced = this.coerceParams(rawParams, mcpTool.inputSchema);

      const result = await this.mcpManager.callTool(
        mcpTool.serverName,
        mcpTool.name,      // Use original name (not prefixed) for the MCP call
        coerced,
      );

      return {
        output: result.content,
        status: result.isError ? 'error' : 'success',
      };
    };

    return {
      name: prefixedName,
      description: `[MCP:${mcpTool.serverName}] ${mcpTool.description}`,
      params,
      handler,
    };
  }

  /**
   * Extract ToolParam[] from a JSON Schema object.
   * Maps JSON Schema types to AgentX's simpler type system.
   */
  private extractParams(schema: MCPTool['inputSchema']): ToolParam[] {
    const params: ToolParam[] = [];
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);

    for (const [name, propSchema] of Object.entries(properties)) {
      const prop = propSchema as Record<string, unknown>;
      const jsonType = prop.type as string | undefined;

      // Map JSON Schema type → AgentX ToolParam type
      let type: ToolParam['type'] = 'string';
      if (jsonType === 'number' || jsonType === 'integer') {
        type = 'number';
      } else if (jsonType === 'boolean') {
        type = 'boolean';
      }
      // Arrays, objects, etc. get serialized as strings (JSON)

      params.push({
        name,
        type,
        description: (prop.description as string) ?? `Parameter: ${name}`,
        required: required.has(name),
      });
    }

    return params;
  }

  /**
   * Coerce string parameter values (from XML) into proper JSON types
   * based on the tool's JSON Schema.
   */
  private coerceParams(
    raw: Record<string, string>,
    schema: MCPTool['inputSchema']
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const properties = schema.properties ?? {};

    for (const [key, rawValue] of Object.entries(raw)) {
      const propSchema = properties[key] as Record<string, unknown> | undefined;
      const jsonType = propSchema?.type as string | undefined;

      if (jsonType === 'number' || jsonType === 'integer') {
        const num = Number(rawValue);
        result[key] = isNaN(num) ? rawValue : num;
      } else if (jsonType === 'boolean') {
        result[key] = rawValue === 'true' || rawValue === '1';
      } else if (jsonType === 'array' || jsonType === 'object') {
        // Try to parse JSON; fall back to raw string
        try {
          result[key] = JSON.parse(rawValue);
        } catch {
          result[key] = rawValue;
        }
      } else {
        result[key] = rawValue;
      }
    }

    return result;
  }

  /**
   * Unregister all MCP tools from the ToolRegistry.
   * Called before reconnection or shutdown.
   */
  unregisterAll(): void {
    // Note: ToolRegistry doesn't have an unregister method yet,
    // so we track names for informational purposes.
    // In a future iteration, we'd add registry.unregister(name).
    this.mcpToolNames.clear();
  }

  /**
   * Get stats about the current MCP integration.
   */
  getStats(): ToolBridgeStats {
    const servers = this.mcpManager.getConnectedServers();
    return {
      connectedServers: servers.length,
      totalMcpTools: this.mcpToolNames.size,
      perServer: servers.map(name => ({
        name,
        toolCount: this.mcpManager.getServerTools(name).length,
      })),
    };
  }

  /**
   * Check if a tool name is an MCP-bridged tool.
   */
  isMcpTool(toolName: string): boolean {
    return this.mcpToolNames.has(toolName);
  }

  /**
   * Disconnect all MCP servers and clean up.
   */
  async shutdown(): Promise<void> {
    this.unregisterAll();
    await this.mcpManager.disconnectAll();
  }
}
