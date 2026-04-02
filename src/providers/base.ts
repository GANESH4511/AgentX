/**
 * AgentX — LLM Provider Interface
 * 
 * Every LLM provider implements this contract. The abstraction allows
 * hot-switching between providers at runtime. Mirrors RuFlo's ADR-026
 * tiered model routing.
 */

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool_result';
  content: string;
  name?: string;      // Tool name for tool_result messages
  status?: string;    // success | error for tool_result messages
}

export interface Model {
  id: string;
  name: string;
  maxTokens: number | null;
  type: string;       // llm, embedding, audio, rerank
}

export interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
}

export interface StreamChunk {
  content: string;
  done: boolean;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface ProviderConfig {
  type: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  models?: {
    tier1Fast?: string;
    tier2Default?: string;
    tier3Complex?: string;
  };
}

/**
 * Abstract LLM Provider — all providers implement this
 */
export abstract class LLMProvider {
  abstract readonly name: string;
  abstract readonly supportsToolCalling: boolean;
  abstract readonly supportsStreaming: boolean;

  protected config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  /**
   * Stream a chat completion from the LLM.
   * Yields chunks of text as they arrive.
   */
  abstract chat(messages: Message[], options?: ChatOptions): AsyncGenerator<StreamChunk>;

  /**
   * Non-streaming chat completion (convenience wrapper).
   */
  async chatComplete(messages: Message[], options?: ChatOptions): Promise<string> {
    let fullContent = '';
    for await (const chunk of this.chat(messages, options)) {
      fullContent += chunk.content;
    }
    return fullContent;
  }

  /**
   * List available models from this provider.
   */
  abstract listModels(): Promise<Model[]>;

  /**
   * Get token limit for a specific model.
   */
  abstract getTokenLimit(model: string): number;

  /**
   * Get the model ID for a given tier (1=fast, 2=default, 3=complex).
   * Falls back to defaultModel if tier not configured.
   */
  getModelForTier(tier: 1 | 2 | 3): string {
    const models = this.config.models;
    if (!models) return this.config.defaultModel;
    
    switch (tier) {
      case 1: return models.tier1Fast || this.config.defaultModel;
      case 2: return models.tier2Default || this.config.defaultModel;
      case 3: return models.tier3Complex || this.config.defaultModel;
    }
  }

  /**
   * Get the default model for this provider.
   */
  getDefaultModel(): string {
    return this.config.defaultModel;
  }
}
