/**
 * AgentX — Ollama Provider
 * 
 * Specialized provider for local Ollama models.
 * Ollama uses OpenAI-compatible format but with some quirks.
 */

import { LLMProvider, Message, Model, ChatOptions, StreamChunk, ProviderConfig } from './base.js';

interface OllamaTag {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

export class OllamaProvider extends LLMProvider {
  readonly name = 'ollama';
  readonly supportsToolCalling = false;
  readonly supportsStreaming = true;

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'http://localhost:11434',
    });
  }

  /**
   * Stream chat via Ollama's /api/chat endpoint (native format).
   */
  async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
    const model = options?.model || this.config.defaultModel;
    const url = `${this.config.baseUrl}/api/chat`;

    const formattedMessages = messages.map(msg => {
      if (msg.role === 'tool_result') {
        return {
          role: 'user',
          content: `<tool_result name="${msg.name}" status="${msg.status || 'success'}">\n${msg.content}\n</tool_result>`
        };
      }
      return { role: msg.role, content: msg.content };
    });

    const body = JSON.stringify({
      model,
      messages: formattedMessages,
      stream: true,
      options: {
        num_predict: options?.maxTokens ?? 4096,
        temperature: options?.temperature ?? 0.7,
        top_p: options?.topP,
        stop: options?.stop,
      },
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error (${response.status}): ${errorText}`);
    }

    if (!response.body) {
      throw new Error('Ollama returned no body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            
            yield {
              content: parsed.message?.content || '',
              done: parsed.done || false,
              finishReason: parsed.done ? 'stop' : undefined,
              usage: parsed.done && parsed.eval_count ? {
                promptTokens: parsed.prompt_eval_count || 0,
                completionTokens: parsed.eval_count || 0,
                totalTokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0),
              } : undefined,
            };
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * List local Ollama models via /api/tags.
   */
  async listModels(): Promise<Model[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`);
      if (!response.ok) return [];

      const data = await response.json() as any;
      const models = (data.models || []) as OllamaTag[];

      return models.map(m => ({
        id: m.name,
        name: m.name,
        maxTokens: null,
        type: 'llm',
      }));
    } catch {
      return [];
    }
  }

  getTokenLimit(_model: string): number {
    return 131072; // Most Ollama models support up to 128K
  }
}
