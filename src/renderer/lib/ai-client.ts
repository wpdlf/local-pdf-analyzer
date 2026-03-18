import type { SummaryType, AppSettings } from '../types';
import { OllamaProvider, ClaudeProvider, OpenAiProvider, type AiProvider } from './ai-provider';
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
      case 'claude':
        if (!settings.claudeApiKey) {
          throw Object.assign(new Error('Claude API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.'), { code: 'API_KEY_MISSING' });
        }
        return new ClaudeProvider(settings.claudeApiKey);
      case 'openai':
        if (!settings.openaiApiKey) {
          throw Object.assign(new Error('OpenAI API 키가 설정되지 않았습니다. 설정에서 API 키를 입력해주세요.'), { code: 'API_KEY_MISSING' });
        }
        return new OpenAiProvider(settings.openaiApiKey);
      case 'ollama':
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
