/**
 * AgentX — Conversation Manager
 * 
 * Manages the message history for the agent loop.
 * Handles truncation when approaching token limits,
 * and provides conversation statistics.
 */

import { Message } from '../providers/base.js';

export class Conversation {
  private messages: Message[] = [];
  private systemPrompt: string = '';
  private maxHistoryTokens: number;

  constructor(maxHistoryTokens: number = 80000) {
    this.maxHistoryTokens = maxHistoryTokens;
  }

  /**
   * Set the system prompt (always first message).
   */
  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  /**
   * Add a user message.
   */
  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
    this.truncateIfNeeded();
  }

  /**
   * Add an assistant message.
   */
  addAssistant(content: string): void {
    this.messages.push({ role: 'assistant', content });
    this.truncateIfNeeded();
  }

  /**
   * Add a tool result message.
   */
  addToolResult(name: string, content: string, status: string = 'success'): void {
    this.messages.push({
      role: 'tool_result',
      content,
      name,
      status,
    });
    this.truncateIfNeeded();
  }

  /**
   * Get all messages including system prompt.
   * This is what gets sent to the LLM.
   */
  getMessages(): Message[] {
    const allMessages: Message[] = [];

    if (this.systemPrompt) {
      allMessages.push({ role: 'system', content: this.systemPrompt });
    }

    allMessages.push(...this.messages);
    return allMessages;
  }

  /**
   * Get conversation statistics.
   */
  getStats(): { messageCount: number; estimatedTokens: number; turns: number } {
    const totalChars = this.messages.reduce((sum, m) => sum + m.content.length, 0)
      + this.systemPrompt.length;
    
    // Rough estimate: 1 token ≈ 4 characters
    const estimatedTokens = Math.ceil(totalChars / 4);
    const turns = this.messages.filter(m => m.role === 'user').length;

    return {
      messageCount: this.messages.length,
      estimatedTokens,
      turns,
    };
  }

  /**
   * Clear all messages (keeps system prompt).
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Truncate oldest messages if exceeding token limit.
   * Keeps the most recent messages, preserving context.
   * Always keeps the first user message as anchor.
   */
  private truncateIfNeeded(): void {
    const stats = this.getStats();
    if (stats.estimatedTokens <= this.maxHistoryTokens) return;

    // Keep removing oldest messages (after the first user message)
    // until we're under the limit
    while (this.messages.length > 2) {
      const stats = this.getStats();
      if (stats.estimatedTokens <= this.maxHistoryTokens * 0.8) break;

      // Remove the second message (keep first as anchor)
      this.messages.splice(1, 1);
    }
  }

  /**
   * Export conversation to a serializable format.
   */
  export(): { systemPrompt: string; messages: Message[] } {
    return {
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
    };
  }

  /**
   * Import conversation from a serialized format.
   */
  import(data: { systemPrompt: string; messages: Message[] }): void {
    this.systemPrompt = data.systemPrompt;
    this.messages = [...data.messages];
  }
}
