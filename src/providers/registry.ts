/**
 * AgentX — Provider Registry
 * 
 * Manages all configured LLM providers and supports hot-switching
 * between them at runtime. The registry is the single source of truth
 * for which provider is active.
 */

import { LLMProvider, ProviderConfig } from './base.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { OllamaProvider } from './ollama.js';

export class ProviderRegistry {
  private providers: Map<string, LLMProvider> = new Map();
  private activeProviderName: string = '';

  /**
   * Register a provider from config.
   * Automatically selects the right provider class based on type.
   */
  register(name: string, config: ProviderConfig): void {
    let provider: LLMProvider;

    switch (config.type) {
      case 'openai-compatible':
        // Detect if this is actual OpenAI (supports tool calling)
        const isNativeOpenAI = config.baseUrl.includes('api.openai.com');
        provider = new OpenAICompatibleProvider(name, config, isNativeOpenAI);
        break;

      case 'ollama':
        provider = new OllamaProvider(config);
        break;

      default:
        // Treat unknown types as openai-compatible (most common)
        provider = new OpenAICompatibleProvider(name, config, false);
        break;
    }

    this.providers.set(name, provider);
  }

  /**
   * Set the active provider by name.
   */
  setActive(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider "${name}" not found. Available: ${this.listNames().join(', ')}`);
    }
    this.activeProviderName = name;
  }

  /**
   * Get the currently active provider.
   */
  getActive(): LLMProvider {
    const provider = this.providers.get(this.activeProviderName);
    if (!provider) {
      throw new Error(`No active provider set. Configure one in ~/.agentx/config.yaml`);
    }
    return provider;
  }

  /**
   * Get the active provider name.
   */
  getActiveName(): string {
    return this.activeProviderName;
  }

  /**
   * Get a specific provider by name.
   */
  get(name: string): LLMProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * List all registered provider names.
   */
  listNames(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * List all providers with their details.
   */
  listAll(): Array<{ name: string; provider: LLMProvider; isActive: boolean }> {
    return Array.from(this.providers.entries()).map(([name, provider]) => ({
      name,
      provider,
      isActive: name === this.activeProviderName,
    }));
  }

  /**
   * Check if a provider is registered.
   */
  has(name: string): boolean {
    return this.providers.has(name);
  }
}
