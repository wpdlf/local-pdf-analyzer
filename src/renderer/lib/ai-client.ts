import type { SummaryType, AppSettings } from '../types';

export class AiClient {
  private settings: AppSettings;
  private _lastRequestId: string | null = null;

  get lastRequestId(): string | null {
    return this._lastRequestId;
  }

  constructor(settings: AppSettings) {
    this.settings = settings;
  }

  prepareSummarize(): string {
    const requestId = crypto.randomUUID();
    this._lastRequestId = requestId;
    return requestId;
  }

  async *summarize(text: string, type: SummaryType, requestId?: string): AsyncGenerator<string> {
    if (!requestId) {
      requestId = this.prepareSummarize();
    }

    // 토큰 수신을 위한 큐
    const tokenQueue: string[] = [];
    let done = false;
    let error: Error | null = null;
    let resolver: (() => void) | null = null;

    const unsubToken = window.electronAPI.ai.onToken((id, token) => {
      if (id !== requestId) return;
      tokenQueue.push(token);
      resolver?.();
    });

    const unsubDone = window.electronAPI.ai.onDone((id) => {
      if (id !== requestId) return;
      done = true;
      resolver?.();
    });

    // Main 프로세스에 생성 요청 (API 키는 Main에서 처리)
    const resultPromise = window.electronAPI.ai.generate(requestId, {
      text,
      type,
      provider: this.settings.provider,
      model: this.settings.model,
      ollamaBaseUrl: this.settings.ollamaBaseUrl,
      temperature: 0.3,
    });

    // 에러 감지를 위해 비동기로 결과 확인
    resultPromise.then((result) => {
      if (!result.success) {
        error = Object.assign(new Error(result.error || '요약 생성에 실패했습니다.'), {
          code: result.code || 'GENERATE_FAIL',
        });
        done = true;
        resolver?.();
      }
    }).catch((err) => {
      error = Object.assign(new Error(err instanceof Error ? err.message : '요약 요청에 실패했습니다.'), {
        code: 'GENERATE_FAIL',
      });
      done = true;
      resolver?.();
    });

    try {
      while (!done || tokenQueue.length > 0) {
        if (tokenQueue.length > 0) {
          yield tokenQueue.shift()!;
        } else if (!done) {
          await new Promise<void>((r) => { resolver = r; });
          resolver = null;
        }
      }

      if (error) throw error;
    } finally {
      unsubToken();
      unsubDone();
      // break/return으로 중단 시 서버 측 요청도 abort
      if (!done && requestId) {
        window.electronAPI.ai.abort(requestId);
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    return window.electronAPI.ai.checkAvailable(
      this.settings.provider,
      this.settings.ollamaBaseUrl,
    );
  }

  async analyzeImage(imageBase64: string): Promise<string | null> {
    const result = await window.electronAPI.ai.analyzeImage(imageBase64);
    if (result.success && result.description) {
      return result.description;
    }
    return null;
  }

  abort(requestId: string): void {
    window.electronAPI.ai.abort(requestId);
  }
}
