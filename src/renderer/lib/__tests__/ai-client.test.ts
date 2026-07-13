import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiClient } from '../ai-client';
import { DEFAULT_SETTINGS } from '../../types';

// window.electronAPI 모킹
const mockElectronAPI = {
  ai: {
    generate: vi.fn(),
    abort: vi.fn(),
    checkAvailable: vi.fn(),
    onToken: vi.fn((_cb: (id: string, token: string) => void) => vi.fn()),
    onDone: vi.fn((_cb: (id: string) => void) => vi.fn()),
    analyzeImage: vi.fn(),
  },
};
vi.stubGlobal('window', { electronAPI: mockElectronAPI });
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

describe('AiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('올바르게 초기화된다', () => {
    const client = new AiClient(DEFAULT_SETTINGS);
    expect(client).toBeDefined();
  });

  it('isAvailable()이 Main 프로세스에 위임한다', async () => {
    mockElectronAPI.ai.checkAvailable.mockResolvedValueOnce(true);
    const client = new AiClient(DEFAULT_SETTINGS);
    const result = await client.isAvailable();
    expect(result).toBe(true);
    expect(mockElectronAPI.ai.checkAvailable).toHaveBeenCalledWith('ollama', 'http://localhost:11434');
  });

  it('isAvailable()이 false를 반환할 수 있다', async () => {
    mockElectronAPI.ai.checkAvailable.mockResolvedValueOnce(false);
    const client = new AiClient(DEFAULT_SETTINGS);
    const result = await client.isAvailable();
    expect(result).toBe(false);
  });

  it('summarize()가 토큰 스트림을 반환한다', async () => {
    // onToken/onDone 콜백을 캡처하여 시뮬레이션
    let tokenCallback: ((id: string, token: string) => void) | null = null;
    let doneCallback: ((id: string) => void) | null = null;

    mockElectronAPI.ai.onToken.mockImplementation((cb) => {
      tokenCallback = cb;
      return vi.fn();
    });
    mockElectronAPI.ai.onDone.mockImplementation((cb) => {
      doneCallback = cb;
      return vi.fn();
    });
    mockElectronAPI.ai.generate.mockImplementation(async (requestId: string) => {
      // 비동기로 토큰 전송 시뮬레이션
      // v0.18.19 patch R32 P3: 50ms 로 상향 (이전 10ms) — CI 러너의 일시 부하로 인한
      // race flake 마진 확보 (Surface 4 P4). 향후 fake timers 마이그레이션 후보.
      setTimeout(() => {
        tokenCallback?.(requestId, 'Hello');
        tokenCallback?.(requestId, ' World');
        doneCallback?.(requestId);
      }, 50);
      return { success: true };
    });

    const client = new AiClient(DEFAULT_SETTINGS);
    const tokens: string[] = [];
    for await (const token of client.summarize('test text', 'full')) {
      tokens.push(token);
    }
    expect(tokens).toEqual(['Hello', ' World']);
  });

  it('summarize() 에러 시 예외를 던진다', async () => {
    let doneCallback: ((id: string) => void) | null = null;

    mockElectronAPI.ai.onToken.mockImplementation(() => vi.fn());
    mockElectronAPI.ai.onDone.mockImplementation((cb) => {
      doneCallback = cb;
      return vi.fn();
    });
    mockElectronAPI.ai.generate.mockImplementation(async () => {
      setTimeout(() => doneCallback?.('test-uuid'), 50); // R32 P3: 10→50ms
      return { success: false, error: 'API 키가 없습니다', code: 'API_KEY_MISSING' };
    });

    const client = new AiClient(DEFAULT_SETTINGS);
    await expect(async () => {
      for await (const _ of client.summarize('test', 'full')) {
        // consume
      }
    }).rejects.toThrow('API 키가 없습니다');
  });

  // QA7: errorKey 가 있으면 main 의 error 원문(한국어 고정) 대신 UI 언어로 번역된 메시지를 던진다.
  it('summarize() errorKey 동반 에러 → 번역 메시지(원문 아님)로 예외', async () => {
    let doneCallback: ((id: string) => void) | null = null;
    mockElectronAPI.ai.onToken.mockImplementation(() => vi.fn());
    mockElectronAPI.ai.onDone.mockImplementation((cb) => { doneCallback = cb; return vi.fn(); });
    mockElectronAPI.ai.generate.mockImplementation(async () => {
      setTimeout(() => doneCallback?.('test-uuid'), 50);
      // error 원문은 sentinel — errorKey 가 우선하면 이 문자열이 노출되지 않아야 한다
      return { success: false, error: 'RAW_SHOULD_NOT_SHOW', errorKey: 'cloudRateLimit', errorParams: { provider: 'Claude' } };
    });

    const client = new AiClient(DEFAULT_SETTINGS);
    let thrown: Error | null = null;
    try {
      for await (const _ of client.summarize('test', 'full')) { /* consume */ }
    } catch (e) { thrown = e as Error; }
    expect(thrown).toBeTruthy();
    expect(thrown!.message).not.toContain('RAW_SHOULD_NOT_SHOW'); // errorKey 우선
    expect(thrown!.message).toContain('Claude');                  // provider 치환
    expect(thrown!.message).toContain('rate limit');              // cloudRateLimit 사전 문구
  });

  // QA13(D-LOW): analyzeImage 실패/빈설명 → null 강등은 요약 파이프라인의 텍스트 fallback 이
  // 의존하는 계약이다(throw/undefined 로 새면 preflight 가 깨진다). 성공/실패 양쪽 가드.
  it('analyzeImage() 성공 → description 반환', async () => {
    mockElectronAPI.ai.analyzeImage.mockResolvedValueOnce({ success: true, description: '차트 설명' });
    const client = new AiClient(DEFAULT_SETTINGS);
    expect(await client.analyzeImage('imgdata', 'req-1')).toBe('차트 설명');
    expect(mockElectronAPI.ai.analyzeImage).toHaveBeenCalledWith('imgdata', 'req-1');
  });

  it('analyzeImage() 실패/빈 설명 → null 로 강등(throw 아님)', async () => {
    mockElectronAPI.ai.analyzeImage.mockResolvedValueOnce({ success: false, error: '429 소진' });
    const client = new AiClient(DEFAULT_SETTINGS);
    expect(await client.analyzeImage('imgdata')).toBeNull();
    mockElectronAPI.ai.analyzeImage.mockResolvedValueOnce({ success: true, description: undefined });
    expect(await client.analyzeImage('imgdata')).toBeNull();
  });

  it('abort()가 Main 프로세스에 위임한다', () => {
    const client = new AiClient(DEFAULT_SETTINGS);
    client.abort('request-123');
    expect(mockElectronAPI.ai.abort).toHaveBeenCalledWith('request-123');
  });

  // R28 회귀: 소비자가 첫 토큰만 받고 break 해도 listener/timer/abort가 모두 정리되어야 함.
  it('summarize() 소비자가 조기 break 해도 onToken/onDone unsub과 abort가 호출된다', async () => {
    const unsubToken = vi.fn();
    const unsubDone = vi.fn();
    let tokenCallback: ((id: string, token: string) => void) | null = null;

    mockElectronAPI.ai.onToken.mockImplementation((cb) => {
      tokenCallback = cb;
      return unsubToken;
    });
    mockElectronAPI.ai.onDone.mockImplementation(() => unsubDone);
    mockElectronAPI.ai.generate.mockImplementation(async (requestId: string) => {
      setTimeout(() => {
        tokenCallback?.(requestId, 'first');
        tokenCallback?.(requestId, 'second');
      }, 50); // R32 P3: 5→50ms
      // generate 자체는 영원히 await 상태 — 소비자 break 후에도 done 미수신 상태가 유지됨
      return new Promise(() => { /* never resolves */ });
    });

    const client = new AiClient(DEFAULT_SETTINGS);
    for await (const _token of client.summarize('text', 'full')) {
      break; // 첫 토큰에서 즉시 중단
    }

    expect(unsubToken).toHaveBeenCalledTimes(1);
    expect(unsubDone).toHaveBeenCalledTimes(1);
    // done=false 상태에서 break했으므로 서버 측 abort가 호출되어야 함
    expect(mockElectronAPI.ai.abort).toHaveBeenCalledWith('test-uuid');
  });

  // R28 회귀: generate가 동기적으로 throw해도 (예: electronAPI 손상) listener는 정리되어야 함.
  it('summarize() 도중 generate가 동기 throw 해도 listener가 정리된다', async () => {
    const unsubToken = vi.fn();
    const unsubDone = vi.fn();

    mockElectronAPI.ai.onToken.mockImplementation(() => unsubToken);
    mockElectronAPI.ai.onDone.mockImplementation(() => unsubDone);
    mockElectronAPI.ai.generate.mockImplementation(() => {
      throw new Error('synchronous IPC failure');
    });

    const client = new AiClient(DEFAULT_SETTINGS);
    await expect(async () => {
      for await (const _ of client.summarize('text', 'full')) {
        // consume
      }
    }).rejects.toThrow();

    expect(unsubToken).toHaveBeenCalledTimes(1);
    expect(unsubDone).toHaveBeenCalledTimes(1);
  });

  // R29 회귀 (v0.18.13): onDone 후에 도착하는 generate 거절이 누락되지 않아야 함.
  // 이전엔 onDone 으로 main loop 가 빠져나간 다음 generate 의 거절 마이크로태스크가
  // 도착하면, `if (error) throw` 가 동기 실행돼 거절을 못 보고 사용자가 빈/부분 요약을
  // "성공"으로 보는 경로가 있었음.
  it('summarize() generate 가 onDone 직후 reject 해도 에러가 throw 된다', async () => {
    let tokenCallback: ((id: string, token: string) => void) | null = null;
    let doneCallback: ((id: string) => void) | null = null;

    mockElectronAPI.ai.onToken.mockImplementation((cb) => {
      tokenCallback = cb;
      return vi.fn();
    });
    mockElectronAPI.ai.onDone.mockImplementation((cb) => {
      doneCallback = cb;
      return vi.fn();
    });
    // generate 는 onDone 직후에야 거절되도록 setup: 토큰 → done → 다음 tick 에 reject
    mockElectronAPI.ai.generate.mockImplementation((requestId: string) => {
      // 토큰 1개 + done 을 같은 macrotask 에 dispatch
      // R32 P3: 5/20ms → 50/100ms — CI 부하 마진.
      setTimeout(() => {
        tokenCallback?.(requestId, 'partial');
        doneCallback?.(requestId);
      }, 50);
      // 그 뒤 한 tick 후에 거절 — main loop 가 이미 빠져나간 시점에 마이크로태스크 dispatch
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('post-done failure')), 100);
      });
    });

    const client = new AiClient(DEFAULT_SETTINGS);
    await expect(async () => {
      for await (const _ of client.summarize('text', 'full')) {
        // consume tokens
      }
    }).rejects.toThrow();
  });
});
