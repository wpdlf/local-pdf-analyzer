export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AiProvider {
  generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string>;
  listModels(): Promise<string[]>;
  isAvailable(): Promise<boolean>;
}

export class OllamaProvider implements AiProvider {
  constructor(private baseUrl: string = 'http://localhost:11434') {}

  async *generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string> {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model || 'llama3.2',
        prompt,
        stream: true,
        options: {
          temperature: options?.temperature ?? 0.3,
          ...(options?.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama 요청 실패: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('스트림을 읽을 수 없습니다');

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.response) {
            yield parsed.response;
          }
        } catch {
          // 파싱 실패 무시 (불완전한 JSON)
        }
      }
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      const data = await response.json();
      return (data.models || []).map((m: { name: string }) => m.name);
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl);
      return response.ok;
    } catch {
      return false;
    }
  }
}
