/**
 * AgentX — OpenAI-Compatible Provider
 * 
 * Universal adapter for any OpenAI-compatible API:
 * InfinitAI, OpenAI, Groq, Together, Fireworks, etc.
 * 
 * Uses raw fetch (undici) for streaming SSE support.
 */

import { LLMProvider, Message, Model, ChatOptions, StreamChunk, ProviderConfig } from './base.js';

interface OpenAIMessage {
    role: string;
    content: string;
}

interface SSELine {
    data?: string;
}

export class OpenAICompatibleProvider extends LLMProvider {
    readonly name: string;
    readonly supportsToolCalling: boolean;
    readonly supportsStreaming = true;

    private tokenLimits: Map<string, number> = new Map();

    constructor(name: string, config: ProviderConfig, supportsToolCalling = false) {
        super(config);
        this.name = name;
        this.supportsToolCalling = supportsToolCalling;
    }

    /**
     * Convert internal Message format to OpenAI format.
     * Tool results get formatted as user messages with XML wrapper.
     */
    private formatMessages(messages: Message[]): OpenAIMessage[] {
        return messages.map(msg => {
            if (msg.role === 'tool_result') {
                // Content already contains <tool_result> XML from formatToolResult()
                return {
                    role: 'user',
                    content: msg.content,
                };
            }
            return { role: msg.role, content: msg.content };
        });
    }

    /**
     * Stream chat completion via SSE (Server-Sent Events).
     */
    async *chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk> {
        const model = options?.model || this.config.defaultModel;
        const url = `${this.config.baseUrl}/chat/completions`;

        // First try streaming
        const streamBody = JSON.stringify({
            model,
            messages: this.formatMessages(messages),
            max_tokens: options?.maxTokens ?? 4096,
            temperature: options?.temperature ?? 0.7,
            top_p: options?.topP,
            stop: options?.stop,
            stream: true,
        });

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        // Add timeout to prevent hanging forever
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: streamBody,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                // If streaming fails, fallback to non-streaming
                if (response.status === 400 && errorText.includes('Streaming')) {
                    // Fallback to non-streaming mode
                    const content = await this.complete(messages, options);
                    yield { content, done: true };
                    return;
                }
                throw new Error(`${this.name} API error (${response.status}): ${errorText}`);
            }

            if (!response.body) {
                throw new Error(`${this.name} API returned no body`);
            }

            // Parse SSE stream
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';  // Keep incomplete line in buffer

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('data: ')) continue;

                        const data = trimmed.slice(6); // Remove "data: " prefix
                        if (data === '[DONE]') {
                            yield { content: '', done: true };
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            const choice = parsed.choices?.[0];
                            if (!choice) continue;

                            const content = choice.delta?.content || '';
                            const finishReason = choice.finish_reason;

                            yield {
                                content,
                                done: !!finishReason,
                                finishReason: finishReason || undefined,
                                usage: parsed.usage ? {
                                    promptTokens: parsed.usage.prompt_tokens || 0,
                                    completionTokens: parsed.usage.completion_tokens || 0,
                                    totalTokens: parsed.usage.total_tokens || 0,
                                } : undefined,
                            };
                        } catch {
                            // Skip malformed JSON chunks
                        }
                    }
                }
            } finally {
                reader.releaseLock();
            }
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`${this.name} API timeout: request took longer than 60 seconds`);
            }
            throw error;
        }
    }

    /**
     * List models from the provider's /models endpoint.
     */
    async listModels(): Promise<Model[]> {
        const url = `${this.config.baseUrl}/models`;
        const headers: Record<string, string> = {};

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        try {
            const response = await fetch(url, { headers });
            if (!response.ok) {
                throw new Error(`Failed to list models: ${response.status}`);
            }

            const data = await response.json() as any;
            const modelList = data.data || data.models || [];

            const models: Model[] = modelList.map((m: any) => {
                const maxTokens = m.max_tokens || m.context_length || null;
                if (maxTokens && m.id) {
                    this.tokenLimits.set(m.id, maxTokens);
                }
                return {
                    id: m.id,
                    name: m.name || m.id,
                    maxTokens,
                    type: m.model_type || m.object || 'llm',
                };
            });

            return models;
        } catch (error) {
            // Return empty list if /models is not supported
            return [];
        }
    }

    /**
     * Non-streaming chat completion (fallback for workers or when streaming fails).
     */
    async complete(messages: Message[], options?: ChatOptions): Promise<string> {
        const model = options?.model || this.config.defaultModel;
        const url = `${this.config.baseUrl}/chat/completions`;

        const body = JSON.stringify({
            model,
            messages: this.formatMessages(messages),
            max_tokens: options?.maxTokens ?? 4096,
            temperature: options?.temperature ?? 0.7,
            top_p: options?.topP,
            stop: options?.stop,
            stream: false,  // Non-streaming
        });

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 minute timeout

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body,
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`${this.name} API error (${response.status}): ${errorText}`);
            }

            const data = await response.json() as any;
            const content = data.choices?.[0]?.message?.content || '';
            return content;
        } catch (error: any) {
            clearTimeout(timeoutId);
            if (error.name === 'AbortError') {
                throw new Error(`${this.name} API timeout`);
            }
            throw error;
        }
    }

    /**
     * Get token limit for a model.
     */
    getTokenLimit(model: string): number {
        return this.tokenLimits.get(model) || 131072; // Default 131K
    }
}
