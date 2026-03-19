import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiClient } from '../ai-client';
import { DEFAULT_SETTINGS } from '../../types';

// window.electronAPI 모킹
const mockElectronAPI = {
  ai: {
    generate: vi.fn(),
    abort: vi.fn(),
    checkAvailable: vi.fn(),
    onToken: vi.fn(() => vi.fn()),
    onDone: vi.fn(() => vi.fn()),
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

    mockElectronAPI.ai.onToken.mockImplementation((cb: (id: string, token: string) => void) => {
      tokenCallback = cb;
      return vi.fn();
    });
    mockElectronAPI.ai.onDone.mockImplementation((cb: (id: string) => void) => {
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
    mockElectronAPI.ai.onDone.mockImplementation((cb: (id: string) => void) => {
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
});
