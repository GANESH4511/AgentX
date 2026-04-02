/**
 * AgentX — XML Tool Call Parser
 * 
 * Parses <tool_call> blocks from LLM output text.
 * Handles mixed text + tool calls, multiple calls per response,
 * and gracefully handles malformed XML.
 */

export interface ParsedToolCall {
  name: string;
  params: Record<string, string>;
  rawXml: string;
}

/**
 * Extract all <tool_call> blocks from LLM response text.
 * 
 * Expected format:
 * ```
 * Some explanation text...
 * 
 * <tool_call name="read_file">
 *   <path>/src/app.ts</path>
 * </tool_call>
 * ```
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];

  // Match <tool_call name="...">...</tool_call> blocks
  const toolCallRegex = /<tool_call\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool_call>/gi;

  let match: RegExpExecArray | null;
  while ((match = toolCallRegex.exec(text)) !== null) {
    const name = match[1];
    const body = match[2];
    const rawXml = match[0];

    // Parse parameters from inner XML tags
    const params = parseParams(body);

    calls.push({ name, params, rawXml });
  }

  return calls;
}

/**
 * Parse parameter tags from inside a tool_call body.
 * 
 * Supports:
 * - <param_name>value</param_name>
 * - Nested whitespace and newlines
 * - Multi-line values (for code content)
 */
function parseParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};

  // Match <tag_name>content</tag_name> pairs
  const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/gi;

  let match: RegExpExecArray | null;
  while ((match = paramRegex.exec(body)) !== null) {
    const key = match[1];
    let value = match[2];

    // Trim leading/trailing whitespace but preserve internal structure
    value = value.replace(/^\n/, '').replace(/\n\s*$/, '');

    // Unescape XML entities
    value = unescapeXml(value);

    params[key] = value;
  }

  return params;
}

/**
 * Check if the text contains any tool calls.
 */
export function hasToolCalls(text: string): boolean {
  return /<tool_call\s+name=["'][^"']+["']\s*>/i.test(text);
}

/**
 * Extract the non-tool-call text (the "reasoning" part).
 */
export function extractReasoning(text: string): string {
  return text
    .replace(/<tool_call\s+name=["'][^"']+["']\s*>[\s\S]*?<\/tool_call>/gi, '')
    .trim();
}

/**
 * Format a tool result as XML for injection back into conversation.
 */
export function formatToolResult(
  name: string,
  output: string,
  status: 'success' | 'error' = 'success'
): string {
  const escapedOutput = escapeXml(output);
  return `<tool_result name="${name}" status="${status}">\n<output>\n${escapedOutput}\n</output>\n</tool_result>`;
}

/**
 * Escape special XML characters in text.
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Unescape XML entities back to characters.
 */
function unescapeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
