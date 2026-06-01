import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// R38 P5 (test coverage): ai-service.ts 네트워크 경로 — checkAvailability, generateEmbeddings
// (embedOllama/embedOpenAi 검증), analyzeImage/OCR(callVision→httpPost 에러 sanitization 포함),
// generate→streamRequest(스트리밍 토큰/SSE/auth/HTTP 에러/abort). http/https 를 모킹한다.

const M = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpGet: vi.fn(),
  httpsRequest: vi.fn(),
  httpsGet: vi.fn(),
}));

vi.mock('http', () => ({ default: { request: (...a: unknown[]) => M.httpRequest(...a), get: (...a: unknown[]) => M.httpGet(...a) } }));
vi.mock('https', () => ({ default: { request: (...a: unknown[]) => M.httpsRequest(...a), get: (...a: unknown[]) => M.httpsGet(...a) } }));
vi.mock('electron', () => ({ BrowserWindow: class { static getAllWindows(): unknown[] { return []; } } }));

import {
  checkAvailability,
  generateEmbeddings,
  analyzeImage,
  generate,
  abortGenerate,
  cleanupAiService,
  __activeRequestCount,
} from '../ai-service';

function makeReq() {
  const req = new EventEmitter() as EventEmitter & {
    destroyed: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>; setTimeout: ReturnType<typeof vi.fn>; __timeoutCb?: () => void;
  };
  req.destroyed = false;
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = vi.fn(() => { req.destroyed = true; });
  req.setTimeout = vi.fn((_ms: number, cb: () => void) => { req.__timeoutCb = cb; return req; });
  return req;
}

function makeRes(opts: { statusCode: number; headers?: Record<string, string>; complete?: boolean }) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number; headers: Record<string, string>; complete: boolean; destroyed: boolean;
    resume: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
  };
  res.statusCode = opts.statusCode;
  res.headers = opts.headers ?? {};
  res.complete = opts.complete ?? true;
  res.destroyed = false;
  res.resume = vi.fn();
  res.destroy = vi.fn(() => { res.destroyed = true; });
  return res;
}

/** request(opts, cb) 모킹 — 200/에러 응답 body 를 data+end 로 흘려보낸다. */
function respond(mock: ReturnType<typeof vi.fn>, statusCode: number, body: unknown, complete = true) {
  mock.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
    const req = makeReq();
    queueMicrotask(() => {
      const res = makeRes({ statusCode, complete });
      cb(res);
      queueMicrotask(() => {
        const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        res.emit('data', buf);
        res.emit('end');
      });
    });
    return req;
  });
}

function makeWin() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

beforeEach(() => {
  cleanupAiService(); // activeRequests 잔여 정리 (테스트 격리)
});

describe('checkAvailability', () => {
  it('ollama 200 → true', async () => {
    M.httpGet.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => cb(makeRes({ statusCode: 200 })));
      return req;
    });
    expect(await checkAvailability('ollama', 'http://localhost:11434', undefined)).toBe(true);
  });

  it('ollama 비-200 → false', async () => {
    M.httpGet.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => cb(makeRes({ statusCode: 503 })));
      return req;
    });
    expect(await checkAvailability('ollama', 'http://localhost:11434', undefined)).toBe(false);
  });

  it('ollama 비-localhost URL → false (SSRF 가드, get 미호출)', async () => {
    expect(await checkAvailability('ollama', 'http://evil.com', undefined)).toBe(false);
    expect(M.httpGet).not.toHaveBeenCalled();
  });

  it('claude/openai → apiKey 유무로 판정', async () => {
    expect(await checkAvailability('claude', 'x', 'key')).toBe(true);
    expect(await checkAvailability('claude', 'x', undefined)).toBe(false);
    expect(await checkAvailability('openai', 'x', 'key')).toBe(true);
    expect(await checkAvailability('openai', 'x', undefined)).toBe(false);
  });
});

describe('generateEmbeddings', () => {
  it('ollama 정상', async () => {
    respond(M.httpRequest, 200, { embeddings: [[0.1, 0.2], [0.3, 0.4]] });
    const r = await generateEmbeddings(['a', 'b'], 'ollama', 'http://localhost:11434', undefined);
    expect(r).toEqual({ embeddings: [[0.1, 0.2], [0.3, 0.4]], model: 'nomic-embed-text', provider: 'ollama' });
  });

  it('ollama 개수 불일치 → throw', async () => {
    respond(M.httpRequest, 200, { embeddings: [[0.1]] });
    await expect(generateEmbeddings(['a', 'b'], 'ollama', 'http://localhost:11434', undefined)).rejects.toThrow(/개수 불일치/);
  });

  it('ollama 형식 오류 → throw', async () => {
    respond(M.httpRequest, 200, { notEmbeddings: true });
    await expect(generateEmbeddings(['a'], 'ollama', 'http://localhost:11434', undefined)).rejects.toThrow(/형식 오류/);
  });

  it('claude → ollama fallback 성공 시 ollama 결과', async () => {
    respond(M.httpRequest, 200, { embeddings: [[0.5]] });
    const r = await generateEmbeddings(['a'], 'claude', 'http://localhost:11434', 'key');
    expect(r?.provider).toBe('ollama');
  });

  it('claude → ollama fallback 실패 시 null (keyword fallback)', async () => {
    respond(M.httpRequest, 500, 'err');
    expect(await generateEmbeddings(['a'], 'claude', 'http://localhost:11434', 'key')).toBeNull();
  });

  it('openai apiKey 없음 → null', async () => {
    expect(await generateEmbeddings(['a'], 'openai', 'x', undefined)).toBeNull();
  });

  it('openai 정상 — index 순 정렬', async () => {
    respond(M.httpsRequest, 200, { data: [{ index: 1, embedding: [0.3] }, { index: 0, embedding: [0.1] }] });
    const r = await generateEmbeddings(['a', 'b'], 'openai', 'x', 'key');
    expect(r?.embeddings).toEqual([[0.1], [0.3]]); // index 0,1 순
    expect(r?.model).toBe('text-embedding-3-small');
  });

  it('openai 변조된 index → throw (데이터 무결성)', async () => {
    respond(M.httpsRequest, 200, { data: [{ index: 5, embedding: [0.1] }, { index: 0, embedding: [0.2] }] });
    await expect(generateEmbeddings(['a', 'b'], 'openai', 'x', 'key')).rejects.toThrow(/index 값이 유효하지 않습니다/);
  });
});

describe('analyzeImage (callVision → httpPost)', () => {
  it('ollama vision — 응답 sanitize (URL 제거)', async () => {
    respond(M.httpRequest, 200, { response: '차트 분석 https://x.com 결과' });
    const r = await analyzeImage('iVBORimg', 'ollama', 'llava', 'http://localhost:11434', undefined);
    expect(r).toBe('차트 분석 [URL 제거됨] 결과');
  });

  it('claude vision — content[0].text 추출', async () => {
    respond(M.httpsRequest, 200, { content: [{ text: '이미지 설명' }] });
    expect(await analyzeImage('img', 'claude', 'm', 'x', 'key')).toBe('이미지 설명');
  });

  // QA3: 코드가 처리하는 redaction 벡터를 폭넓게 검증 (이전엔 sk-ant 1개만).
  it.each([
    ['sk-ant (JSON error.message)', { error: { message: 'invalid sk-ant-api03-SECRETSECRETSECRET99999' } }, 'SECRETSECRETSECRET99999'],
    ['소문자 bearer (비-JSON body)', 'unauthorized: bearer SUPERSECRETTOKENVALUE1234567', 'SUPERSECRETTOKENVALUE1234567'],
    ['sk-proj (JSON)', { error: { message: 'bad sk-proj-SUPERSECRETPROJKEY1234567890' } }, 'SUPERSECRETPROJKEY1234567890'],
  ])('에러 응답 로그에서 키 redaction: %s', async (_l, body, rawSecret) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(M.httpsRequest, 401, body);
    await expect(analyzeImage('img', 'claude', 'm', 'x', 'key')).rejects.toThrow(/HTTP 401/);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(rawSecret); // 원본 키 미노출
    expect(logged).toContain('REDACTED');
    errSpy.mockRestore();
  });

  it('claude vision — apiKey 없으면 throw', async () => {
    await expect(analyzeImage('img', 'claude', 'm', 'x', undefined)).rejects.toThrow(/Claude API 키가 필요/);
  });
});

describe('generate → streamRequest (스트리밍)', () => {
  it('ollama 스트리밍 — 토큰 순차 전송 + ai:done', async () => {
    M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from('{"response":"안녕"}\n{"response":"하세요"}\n'));
          res.emit('end');
        });
      });
      return req;
    });
    const win = makeWin();
    await generate('req1', { text: '본문', type: 'full', provider: 'ollama', model: 'llama3', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
    // 순서까지 단언 (QA2: 독립 toHaveBeenCalledWith 는 순서 미검증)
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'ai:token', 'req1', '안녕');
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'ai:token', 'req1', '하세요');
    expect(win.webContents.send).toHaveBeenNthCalledWith(3, 'ai:done', 'req1');
    // 정상 종료 후 activeRequests 누수 없음 (safeDeleteRequest)
    expect(__activeRequestCount()).toBe(0);
  });

  it('claude SSE 401 → API_KEY_INVALID', async () => {
    M.httpsRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => { const res = makeRes({ statusCode: 401 }); cb(res); });
      return req;
    });
    await expect(
      generate('r2', { text: 'x', type: 'qa', provider: 'claude', model: 'claude-x', ollamaBaseUrl: 'http://localhost:11434' }, 'key', makeWin() as never),
    ).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
  });

  it('HTTP 500 → API 요청 실패', async () => {
    M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => { const res = makeRes({ statusCode: 500 }); cb(res); });
      return req;
    });
    await expect(
      generate('r3', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never),
    ).rejects.toThrow(/API 요청 실패: HTTP 500/);
  });

  it('claude provider + apiKey 없음 → API_KEY_MISSING', async () => {
    await expect(
      generate('r4', { text: 'x', type: 'qa', provider: 'claude', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never),
    ).rejects.toMatchObject({ code: 'API_KEY_MISSING' });
  });

  it('abortGenerate → ABORTED 로 reject', async () => {
    // 응답을 보내지 않아 요청이 in-flight 상태로 유지 → abort 로만 종료
    M.httpRequest.mockImplementation(() => makeReq());
    const p = generate('rabort', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never);
    expect(__activeRequestCount()).toBe(1); // in-flight 등록됨
    abortGenerate('rabort'); // streamRequest 가 동기로 등록한 entry 를 취소
    await expect(p).rejects.toMatchObject({ code: 'ABORTED' });
    // R34 P1: abort 후 entry 즉시 제거 — 10분 TTL leak 없음
    expect(__activeRequestCount()).toBe(0);
  });
});
