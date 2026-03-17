import type { SummaryType, AppSettings } from '../types';
import { OllamaProvider, type AiProvider } from './ai-provider';
import { buildPrompt } from './prompts';

export class AiClient {
  private provider: AiProvider;
  private model: string;

  constructor(settings: AppSettings) {
    this.model = settings.model;
    this.provider = this.createProvider(settings);
  }

  private createProvider(settings: AppSettings): AiProvider {
    switch (settings.provider) {
      case 'ollama':
        return new OllamaProvider(settings.ollamaBaseUrl);
      // 추후 확장:
      // case 'claude': return new ClaudeProvider(settings.apiKey);
      // case 'openai': return new OpenAiProvider(settings.apiKey);
      default:
        return new OllamaProvider(settings.ollamaBaseUrl);
    }
  }

  async *summarize(text: string, type: SummaryType): AsyncGenerator<string> {
    const prompt = buildPrompt(text, type);
    yield* this.provider.generate(prompt, {
      model: this.model,
      temperature: 0.3,
    });
  }

  async isAvailable(): Promise<boolean> {
    return this.provider.isAvailable();
  }

  async listModels(): Promise<string[]> {
    return this.provider.listModels();
  }
}
