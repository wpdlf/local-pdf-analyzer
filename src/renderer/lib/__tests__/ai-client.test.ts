import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaProvider } from '../ai-provider';
import { AiClient } from '../ai-client';
import type { AppSettings } from '../../types';
import { DEFAULT_SETTINGS } from '../../types';

// fetch 모킹
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('OllamaProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('isAvailable()이 서버 실행 중이면 true를 반환한다', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const provider = new OllamaProvider('http://localhost:11434');
    const result = await provider.isAvailable();
    expect(result).toBe(true);
  });

  it('isAvailable()이 서버 미실행이면 false를 반환한다', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const provider = new OllamaProvider('http://localhost:11434');
    const result = await provider.isAvailable();
    expect(result).toBe(false);
  });

  it('listModels()가 모델 목록을 반환한다', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        models: [{ name: 'llama3.2' }, { name: 'phi3' }],
      }),
    });
    const provider = new OllamaProvider();
    const models = await provider.listModels();
    expect(models).toEqual(['llama3.2', 'phi3']);
  });

  it('listModels()가 서버 에러 시 빈 배열을 반환한다', async () => {
    mockFetch.mockRejectedValueOnce(new Error('fail'));
    const provider = new OllamaProvider();
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });
});

describe('AiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('올바른 Provider로 초기화된다', () => {
    const client = new AiClient(DEFAULT_SETTINGS);
    expect(client).toBeDefined();
  });

  it('isAvailable()을 Provider에 위임한다', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const client = new AiClient(DEFAULT_SETTINGS);
    const result = await client.isAvailable();
    expect(result).toBe(true);
  });

  it('listModels()를 Provider에 위임한다', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ models: [{ name: 'llama3.2' }] }),
    });
    const client = new AiClient(DEFAULT_SETTINGS);
    const models = await client.listModels();
    expect(models).toEqual(['llama3.2']);
  });
});
