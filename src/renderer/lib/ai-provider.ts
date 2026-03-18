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

// ─── Ollama Provider ───

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

    try {
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
            // 파싱 실패 무시
          }
        }
      }
    } finally {
      reader.releaseLock();
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

// ─── Claude Provider ───

export class ClaudeProvider implements AiProvider {
  constructor(private apiKey: string) {}

  async *generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: options?.model || 'claude-sonnet-4-20250514',
        max_tokens: options?.maxTokens || 4096,
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.3,
      }),
    });

    if (response.status === 401) {
      throw Object.assign(new Error('Claude API 키가 유효하지 않습니다. 설정에서 확인해주세요.'), { code: 'API_KEY_INVALID' });
    }

    if (!response.ok) {
      throw new Error(`Claude API 요청 실패: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('스트림을 읽을 수 없습니다');

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(Boolean);

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield parsed.delta.text;
            }
          } catch {
            // 파싱 실패 무시
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<string[]> {
    return ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'];
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ─── OpenAI Provider ───

export class OpenAiProvider implements AiProvider {
  constructor(private apiKey: string) {}

  async *generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || 'gpt-4o-mini',
        stream: true,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.3,
        ...(options?.maxTokens ? { max_tokens: options.maxTokens } : {}),
      }),
    });

    if (response.status === 401) {
      throw Object.assign(new Error('OpenAI API 키가 유효하지 않습니다. 설정에서 확인해주세요.'), { code: 'API_KEY_INVALID' });
    }

    if (!response.ok) {
      throw new Error(`OpenAI API 요청 실패: ${response.status} ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('스트림을 읽을 수 없습니다');

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(Boolean);

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              yield content;
            }
          } catch {
            // 파싱 실패 무시
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async listModels(): Promise<string[]> {
    return ['gpt-4o', 'gpt-4o-mini'];
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
