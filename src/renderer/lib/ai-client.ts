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

    // IPC 연결 해제 감지: 일정 시간 토큰 없으면 안전하게 종료
    const IPC_TIMEOUT_MS = 120000; // 2분
    let ipcTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIpcTimer = () => {
      if (ipcTimer) clearTimeout(ipcTimer);
      ipcTimer = setTimeout(() => {
        if (!done) {
          error = new Error('AI 응답 수신이 중단되었습니다.');
          done = true;
          resolver?.();
        }
      }, IPC_TIMEOUT_MS);
    };

    try {
      resetIpcTimer();
      while (tokenQueue.length > 0 || !done) {
        if (tokenQueue.length > 0) {
          resetIpcTimer();
          yield tokenQueue.shift()!;
        } else {
          await new Promise<void>((r) => {
            resolver = r;
            // resolver 할당 후 상태 재확인 — done/token이 할당 직전에 변경된 경우 즉시 해제
            if (done || tokenQueue.length > 0) r();
          });
          resolver = null;
        }
      }
      // done=true 후 큐에 남은 토큰 소진
      while (tokenQueue.length > 0) yield tokenQueue.shift()!;

      if (error) throw error;
    } finally {
      if (ipcTimer) clearTimeout(ipcTimer);
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
