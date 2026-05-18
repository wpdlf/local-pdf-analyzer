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
      setTimeout(() => {
        tokenCallback?.(requestId, 'Hello');
        tokenCallback?.(requestId, ' World');
        doneCallback?.(requestId);
      }, 10);
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
      setTimeout(() => doneCallback?.('test-uuid'), 10);
      return { success: false, error: 'API 키가 없습니다', code: 'API_KEY_MISSING' };
    });

    const client = new AiClient(DEFAULT_SETTINGS);
    await expect(async () => {
      for await (const _ of client.summarize('test', 'full')) {
        // consume
      }
    }).rejects.toThrow('API 키가 없습니다');
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
      }, 5);
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
});
