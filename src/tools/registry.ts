/**
 * AgentX — Tool Registry
 * 
 * Central registry for all available tools. Tools register themselves
 * with a name, description, parameter schema, and handler function.
 * The registry generates XML tool definitions for the system prompt
 * and dispatches tool calls to the correct handler.
 */

export interface ToolParam {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  params: ToolParam[];
  handler: (params: Record<string, string>) => Promise<ToolResult>;
}

export interface ToolResult {
  output: string;
  status: 'success' | 'error';
}

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  /**
   * Register a tool.
   */
  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Execute a tool by name with the given parameters.
   */
  async execute(name: string, params: Record<string, string>): Promise<ToolResult> {
    const tool = this.tools.get(name);

    if (!tool) {
      return {
        output: `Unknown tool: "${name}". Available tools: ${this.listNames().join(', ')}`,
        status: 'error',
      };
    }

    // Validate required params
    for (const param of tool.params) {
      if (param.required && !(param.name in params)) {
        return {
          output: `Missing required parameter "${param.name}" for tool "${name}"`,
          status: 'error',
        };
      }
    }

    try {
      return await tool.handler(params);
    } catch (error: any) {
      return {
        output: `Tool "${name}" failed: ${error.message}`,
        status: 'error',
      };
    }
  }

  /**
   * Get all registered tool names.
   */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get all tool definitions.
   */
  listAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /**
   * Check if a tool is registered.
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Generate XML tool definitions for the system prompt.
   * This tells the LLM what tools are available and how to call them.
   */
  generateToolsXml(): string {
    const tools = this.listAll();
    if (tools.length === 0) return '';

    const toolDefs = tools.map(tool => {
      const paramDefs = tool.params
        .map(p => {
          const reqAttr = p.required ? ' required="true"' : '';
          return `      <${p.name} type="${p.type}"${reqAttr}>${p.description}</${p.name}>`;
        })
        .join('\n');

      return `  <tool name="${tool.name}">
    <description>${tool.description}</description>
    <params>
${paramDefs}
    </params>
  </tool>`;
    }).join('\n\n');

    return `<available_tools>\n${toolDefs}\n</available_tools>`;
  }

  /**
   * Get the count of registered tools.
   */
  get count(): number {
    return this.tools.size;
  }
}
