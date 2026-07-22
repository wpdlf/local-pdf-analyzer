import type { SummaryType, AppSettings } from '../types';
import { t, translateMainError } from './i18n';

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

  async *summarize(text: string, type: SummaryType, requestId?: string, customPrompt?: string): AsyncGenerator<string> {
    if (!requestId) {
      requestId = this.prepareSummarize();
    }

    // 토큰 수신을 위한 큐
    const tokenQueue: string[] = [];
    let done = false;
    let error: Error | null = null;
    let resolver: (() => void) | null = null;

    // R28: listener/timer 등록을 try/finally로 감싸 — onToken/onDone/generate가 동기 throw하거나
    // try 진입 전에 예외가 발생해도 unsub이 보장되도록 함.
    let unsubToken: (() => void) | null = null;
    let unsubDone: (() => void) | null = null;
    const IPC_TIMEOUT_MS = 120000; // 2분 — IPC 연결 해제 감지
    let ipcTimer: ReturnType<typeof setTimeout> | null = null;
    // QA18(C-MED): IPC 타임아웃으로 종료됐는지. done 과 별개로 추적해야 finally 의 abort 가
    // 도달한다(타임아웃 콜백이 done=true 를 세팅하므로 `!done` 만으로는 영원히 거짓).
    let ipcTimedOut = false;

    try {
      unsubToken = window.electronAPI.ai.onToken((id, token) => {
        if (id !== requestId) return;
        tokenQueue.push(token);
        resolver?.();
      });

      unsubDone = window.electronAPI.ai.onDone((id) => {
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
        language: this.settings.summaryLanguage || 'ko',
        // 커스텀 템플릿(type==='custom')일 때만 사용자 프롬프트를 함께 전달.
        ...(type === 'custom' && customPrompt ? { customPrompt } : {}),
      });

      // 에러 감지를 위해 비동기로 결과 확인.
      // R29 (v0.18.13): 마이크로태스크 race 방지를 위해 .catch 만 등록하고
      // 메인 루프 종료 후 `await resultPromise` 로 재확인한다. 이전 구현은
      // onDone 에 의해 main loop 가 빠져나간 다음 generate() 의 거절 마이크로태스크가
      // 실행되면, `if (error) throw` 가 동기 실행돼 거절이 누락되고 사용자가
      // 빈/부분 요약을 "성공" 으로 보는 경로가 있었다.
      const captureResult = (result: { success: boolean; error?: string; code?: string; errorKey?: string; errorParams?: Record<string, string> }): void => {
        if (!result.success) {
          // QA7: main 의 errorKey 를 UI 언어로 번역(429/529·타임아웃·응답차단 등이 영어 UI 에
          // 한국어 원문으로 노출되던 i18n 우회 해소). errorKey 없는 에러는 error 원문 fallback.
          error = Object.assign(new Error(translateMainError(result, t('ai.generateFail'))), {
            code: result.code || 'GENERATE_FAIL',
          });
          done = true;
          resolver?.();
        }
      };
      const captureRejection = (err: unknown): void => {
        error = Object.assign(new Error(err instanceof Error ? err.message : t('ai.requestFail')), {
          code: 'GENERATE_FAIL',
        });
        done = true;
        resolver?.();
      };
      resultPromise.then(captureResult, captureRejection);

      const resetIpcTimer = (): void => {
        if (ipcTimer) clearTimeout(ipcTimer);
        ipcTimer = setTimeout(() => {
          if (!done) {
            ipcTimedOut = true;
            error = new Error(t('ai.streamInterrupted'));
            done = true;
            resolver?.();
          }
        }, IPC_TIMEOUT_MS);
      };

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

      // R29 (v0.18.13): generate() 의 거절 마이크로태스크가 메인 루프 종료 직후에야
      // 도착하는 경우가 있어 throw 전에 명시적으로 재확인. 이미 captureRejection 이
      // 처리한 거절은 여기서 await 가 같은 값으로 한 번 더 거절되지만, 동일 변수에
      // 덮어쓰는 것이라 idempotent.
      // QA18(C-MED): 단 IPC 타임아웃으로 끊긴 경우는 await 하지 않는다. resultPromise 는
      // main 의 invoke 응답이라, 애초에 "main 이 응답하지 않는다"가 이 타임아웃의 전제다 →
      // 여기서 await 하면 제너레이터가 영구 정지해 streamInterrupted 조차 표면화되지 않고
      // finally 의 abort 도 실행되지 않는다(타임아웃의 목적이 통째로 무효화되던 경로).
      // 거절은 line 90 의 .then(captureResult, captureRejection) 이 이미 처리하므로
      // unhandled rejection 도 생기지 않는다.
      if (!ipcTimedOut) {
        await resultPromise.then(captureResult, captureRejection);
      }

      if (error) throw error;
    } finally {
      if (ipcTimer) clearTimeout(ipcTimer);
      unsubToken?.();
      unsubDone?.();
      // break/return으로 중단 시 서버 측 요청도 abort
      // QA18(C-MED, 과금): IPC 타임아웃도 abort 대상이다. 타임아웃 콜백이 done=true 를 먼저
      // 세팅하는 탓에 `!done` 가드가 스스로를 무력화해, "연결 끊김 감지" 경로가 정작 abort 를
      // 보내지 않았다 — 렌더러는 streamInterrupted 로 실패 처리하고 손을 떼는데 main 의
      // 스트림은 계속 돌며 클라우드 토큰을 소진하고 activeRequests 엔트리도 남았다.
      // (main 의 60초 idle 타이머는 데이터가 흐르는 한 계속 리셋되므로 상한이 되지 못한다.)
      if ((!done || ipcTimedOut) && requestId) {
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

  async analyzeImage(imageBase64: string, requestId?: string): Promise<string | null> {
    // R30 P2 (v0.18.18): 호출자가 requestId 를 제공하면 Stop 시 main 의 ai:abort 로
    // in-flight Vision 호출을 끊을 수 있다 (특히 cloud 토큰 절약).
    const result = await window.electronAPI.ai.analyzeImage(imageBase64, requestId);
    if (result.success && result.description) {
      return result.description;
    }
    return null;
  }

  abort(requestId: string): void {
    window.electronAPI.ai.abort(requestId);
  }
}
