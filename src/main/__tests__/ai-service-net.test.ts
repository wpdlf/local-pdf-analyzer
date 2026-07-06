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
  retryOn429,
  parseRetryAfterMs,
  mapCloudHttpError,
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

  it('claude/openai/gemini → apiKey 유무로 판정', async () => {
    expect(await checkAvailability('claude', 'x', 'key')).toBe(true);
    expect(await checkAvailability('claude', 'x', undefined)).toBe(false);
    expect(await checkAvailability('openai', 'x', 'key')).toBe(true);
    expect(await checkAvailability('openai', 'x', undefined)).toBe(false);
    expect(await checkAvailability('gemini', 'x', 'key')).toBe(true);
    expect(await checkAvailability('gemini', 'x', undefined)).toBe(false);
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

  // R43 H-4: gemini 임베딩 경로 (batchEmbedContents)
  it('gemini 정상 — values 추출 + 모델/provider', async () => {
    respond(M.httpsRequest, 200, { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] });
    const r = await generateEmbeddings(['a', 'b'], 'gemini', 'x', 'gkey');
    expect(r).toEqual({ embeddings: [[0.1, 0.2], [0.3, 0.4]], model: 'gemini-embedding-2', provider: 'gemini' });
  });

  it('gemini apiKey 없음 → null', async () => {
    expect(await generateEmbeddings(['a'], 'gemini', 'x', undefined)).toBeNull();
  });

  it('gemini 개수 불일치 → throw', async () => {
    respond(M.httpsRequest, 200, { embeddings: [{ values: [0.1] }] });
    await expect(generateEmbeddings(['a', 'b'], 'gemini', 'x', 'gkey')).rejects.toThrow(/개수 불일치/);
  });

  it('gemini values 형식 오류 → throw', async () => {
    respond(M.httpsRequest, 200, { embeddings: [{ notValues: true }] });
    await expect(generateEmbeddings(['a'], 'gemini', 'x', 'gkey')).rejects.toThrow(/형식 오류/);
  });

  it('gemini 101개 입력 → 100건 상한으로 2회 분할 호출 (R43)', async () => {
    const texts = Array.from({ length: 101 }, (_, i) => `t${i}`);
    const batchRes = (n: number) => ({ embeddings: Array.from({ length: n }, () => ({ values: [0.1] })) });
    M.httpsRequest
      .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
        const req = makeReq();
        queueMicrotask(() => {
          const res = makeRes({ statusCode: 200 });
          cb(res);
          queueMicrotask(() => { res.emit('data', Buffer.from(JSON.stringify(batchRes(100)))); res.emit('end'); });
        });
        return req;
      })
      .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
        const req = makeReq();
        queueMicrotask(() => {
          const res = makeRes({ statusCode: 200 });
          cb(res);
          queueMicrotask(() => { res.emit('data', Buffer.from(JSON.stringify(batchRes(1)))); res.emit('end'); });
        });
        return req;
      });
    const r = await generateEmbeddings(texts, 'gemini', 'x', 'gkey');
    expect(r?.embeddings).toHaveLength(101);
    expect(M.httpsRequest).toHaveBeenCalledTimes(2);
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

  // R43 H-4: gemini vision 경로
  it('gemini vision — parts join 추출 + x-goog-api-key 헤더 (키는 URL 미포함)', async () => {
    let captured: { hostname?: string; path?: string; headers?: Record<string, string> } = {};
    M.httpsRequest.mockImplementation((opts: unknown, cb: (r: unknown) => void) => {
      captured = opts as typeof captured;
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: '그림 ' }, { text: '설명' }] } }] })));
          res.emit('end');
        });
      });
      return req;
    });
    expect(await analyzeImage('img', 'gemini', 'gemini-3.5-flash', 'x', 'AIzaTESTKEY')).toBe('그림 설명');
    expect(captured.hostname).toBe('generativelanguage.googleapis.com');
    expect(captured.path).toContain(':generateContent');
    expect(captured.path).not.toContain('AIzaTESTKEY'); // 키 URL 유출 방지
    expect(captured.headers?.['x-goog-api-key']).toBe('AIzaTESTKEY');
  });

  it('gemini vision — apiKey 없으면 throw', async () => {
    await expect(analyzeImage('img', 'gemini', 'm', 'x', undefined)).rejects.toThrow(/Gemini API 키가 필요/);
  });

  // R44(R43 후속 M5): 무료 티어 429 → 백오프 재시도 후 성공 (이미지 설명 무음 누락 방지)
  it('gemini vision 429 1회 → 백오프 재시도로 성공', async () => {
    vi.useFakeTimers();
    try {
      M.httpsRequest
        .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
          const req = makeReq();
          queueMicrotask(() => {
            const res = makeRes({ statusCode: 429 });
            cb(res);
            queueMicrotask(() => { res.emit('data', Buffer.from('{"error":{"message":"quota"}}')); res.emit('end'); });
          });
          return req;
        })
        .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
          const req = makeReq();
          queueMicrotask(() => {
            const res = makeRes({ statusCode: 200 });
            cb(res);
            queueMicrotask(() => {
              res.emit('data', Buffer.from(JSON.stringify({ candidates: [{ content: { parts: [{ text: '재시도 성공' }] } }] })));
              res.emit('end');
            });
          });
          return req;
        });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const p = analyzeImage('img', 'gemini', 'm', 'x', 'gkey');
      // R45: 1차 백오프 2s + jitter(최대 +25% = 2.5s) 커버 — 부족하면 본 테스트가 타임아웃되고
      // fake timer 미복원으로 후속 retry 테스트까지 연쇄 hang 하므로 여유를 둔다
      await vi.advanceTimersByTimeAsync(2600);
      expect(await p).toBe('재시도 성공');
      expect(M.httpsRequest).toHaveBeenCalledTimes(2);
      errSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  // QA8(B-MED): cloud vision 429 재시도 back-port — 이전엔 Gemini 만 재시도해 Claude/OpenAI 는
  // rate limit 시 이미지 설명이 무음 드롭됐다. Claude/OpenAI 도 429 → 백오프 재시도 후 성공하는지.
  it.each([
    ['claude', (t: string) => JSON.stringify({ content: [{ text: t }] })],
    ['openai', (t: string) => JSON.stringify({ choices: [{ message: { content: t } }] })],
  ] as const)('%s vision 429 1회 → 백오프 재시도로 성공', async (provider, okBody) => {
    vi.useFakeTimers();
    try {
      M.httpsRequest
        .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
          const req = makeReq();
          queueMicrotask(() => {
            const res = makeRes({ statusCode: 429 });
            cb(res);
            queueMicrotask(() => { res.emit('data', Buffer.from('{"error":{"message":"rate"}}')); res.emit('end'); });
          });
          return req;
        })
        .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
          const req = makeReq();
          queueMicrotask(() => {
            const res = makeRes({ statusCode: 200 });
            cb(res);
            queueMicrotask(() => { res.emit('data', Buffer.from(okBody('재시도 설명'))); res.emit('end'); });
          });
          return req;
        });
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const p = analyzeImage('img', provider, 'm', 'x', 'key');
      await vi.advanceTimersByTimeAsync(2600);
      expect(await p).toBe('재시도 설명');
      expect(M.httpsRequest).toHaveBeenCalledTimes(2);
      errSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

// R44(R43 후속 M5): 429 한정 지수 백오프 재시도 헬퍼
describe('retryOn429', () => {
  const err429 = () => Object.assign(new Error('HTTP 429'), { status: 429 });

  it('429 두 번 후 성공 → 결과 반환 (3회 호출)', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw err429();
      return 'ok';
    });
    expect(await retryOn429(fn, undefined, 2, 1)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('429 아닌 에러는 즉시 전파 (재시도 없음)', async () => {
    const fn = vi.fn(async () => { throw Object.assign(new Error('HTTP 500'), { status: 500 }); });
    await expect(retryOn429(fn, undefined, 2, 1)).rejects.toThrow('HTTP 500');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('재시도 소진 시 마지막 429 전파', async () => {
    const fn = vi.fn(async () => { throw err429(); });
    await expect(retryOn429(fn, undefined, 2, 1)).rejects.toThrow('HTTP 429');
    expect(fn).toHaveBeenCalledTimes(3); // 최초 1 + 재시도 2
  });

  it('백오프 대기 중 abort → 즉시 중단', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => { throw err429(); });
    const p = retryOn429(fn, controller.signal, 2, 60000); // 60s 대기 — abort 가 끊어야 함
    await new Promise((r) => setTimeout(r, 5)); // 첫 호출 실패 → 대기 진입
    controller.abort();
    await expect(p).rejects.toThrow('Aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // R45(R44 후속): 서버 지정 Retry-After 우선 존중
  it('err.retryAfterMs 가 있으면 지수 백오프 대신 그 값으로 대기한다', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('HTTP 429'), { status: 429, retryAfterMs: 1 });
      return 'ok';
    });
    // baseDelayMs 60s — retryAfterMs(1ms) 를 무시했다면 테스트 타임아웃으로 실패한다
    expect(await retryOn429(fn, undefined, 2, 60000)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('parseRetryAfterMs (R45)', () => {
  it.each([
    ['초 단위 숫자', '30', 30000],
    ['0초 — 즉시 재시도 허용', '0', 0],
    ['60초 캡 초과', '3600', 60000],
    ['배열 헤더는 첫 값', ['5', '10'] as string[], 5000],
  ])('%s: %j → %d', (_l, h, expected) => {
    expect(parseRetryAfterMs(h)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['HTTP-date 형식 (미지원)', 'Wed, 21 Oct 2026 07:28:00 GMT'],
    ['음수', '-5'],
  ])('파싱 불가: %s → undefined', (_l, h) => {
    expect(parseRetryAfterMs(h as never)).toBeUndefined();
  });
});

// E1: Claude/OpenAI 4xx/5xx 바디 기반 에러 매핑 (429 rate limit / 쿼터, 529·503 과부하)
describe('mapCloudHttpError (E1)', () => {
  it('429 일반 → rate limit 안내(provider 명 포함)', () => {
    const e = mapCloudHttpError('Claude', 429, 'Rate limited');
    expect(e?.message).toContain('Claude');
    expect(e?.message).toContain('rate limit');
  });

  it('429 + insufficient_quota → 쿼터 안내', () => {
    const e = mapCloudHttpError('OpenAI', 429, 'You exceeded your current quota (insufficient_quota)');
    expect(e?.message).toContain('OpenAI');
    expect(e?.message).toContain('쿼터');
  });

  it('529/503 → 과부하 안내', () => {
    expect(mapCloudHttpError('Claude', 529, 'overloaded_error')?.message).toContain('과부하');
    expect(mapCloudHttpError('OpenAI', 503, 'Service Unavailable')?.message).toContain('과부하');
  });

  it('그 외 상태(400/500 등)는 null → 기존 generic 에러 유지', () => {
    expect(mapCloudHttpError('Claude', 400, 'bad request')).toBeNull();
    expect(mapCloudHttpError('OpenAI', 500, 'server error')).toBeNull();
  });

  // QA7: errorKey/errorParams 를 실어 렌더러가 UI 언어로 번역하도록(영어 UI 한국어 노출 해소).
  it('errorKey/errorParams 부착 — cloudRateLimit/cloudQuota/cloudOverloaded + provider', () => {
    const rate = mapCloudHttpError('Claude', 429, 'Rate limited') as Error & { errorKey?: string; errorParams?: Record<string, string> };
    expect(rate.errorKey).toBe('cloudRateLimit');
    expect(rate.errorParams).toEqual({ provider: 'Claude' });
    const quota = mapCloudHttpError('OpenAI', 429, 'insufficient_quota') as Error & { errorKey?: string; errorParams?: Record<string, string> };
    expect(quota.errorKey).toBe('cloudQuota');
    expect(quota.errorParams).toEqual({ provider: 'OpenAI' });
    const over = mapCloudHttpError('Gemini', 503, 'UNAVAILABLE') as Error & { errorKey?: string; errorParams?: Record<string, string> };
    expect(over.errorKey).toBe('cloudOverloaded');
    expect(over.errorParams).toEqual({ provider: 'Gemini' });
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

  // R43 H-4: gemini SSE 스트리밍 경로
  it('gemini SSE — 토큰 순차 전송 + ai:done + ?alt=sse URL/헤더', async () => {
    let captured: { path?: string; headers?: Record<string, string> } = {};
    M.httpsRequest.mockImplementation((opts: unknown, cb: (r: unknown) => void) => {
      captured = opts as typeof captured;
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from(
            'data: {"candidates":[{"content":{"parts":[{"text":"안녕"}]}}]}\n'
            + 'data: {"candidates":[{"content":{"parts":[{"text":"하세요"}]},"finishReason":"STOP"}]}\n',
          ));
          res.emit('end');
        });
      });
      return req;
    });
    const win = makeWin();
    await generate('g1', { text: '본문', type: 'full', provider: 'gemini', model: 'gemini-3.5-flash', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', win as never);
    expect(win.webContents.send).toHaveBeenNthCalledWith(1, 'ai:token', 'g1', '안녕');
    expect(win.webContents.send).toHaveBeenNthCalledWith(2, 'ai:token', 'g1', '하세요');
    expect(win.webContents.send).toHaveBeenNthCalledWith(3, 'ai:done', 'g1');
    expect(captured.path).toContain(':streamGenerateContent?alt=sse');
    expect(captured.headers?.['x-goog-api-key']).toBe('gkey');
    expect(__activeRequestCount()).toBe(0);
  });

  // R43 H-1: safety block 이 빈 성공으로 끝나지 않고 명시 실패 처리되는지
  it('gemini safety block (promptFeedback, 토큰 0) → BLOCKED reject + ai:done 미전송', async () => {
    M.httpsRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from('data: {"promptFeedback":{"blockReason":"SAFETY"}}\n'));
          res.emit('end');
        });
      });
      return req;
    });
    const win = makeWin();
    await expect(
      generate('g2', { text: 'x', type: 'full', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', win as never),
    ).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'g2');
    expect(__activeRequestCount()).toBe(0);
  });

  // QA8(B-MED): blockReason 없이 0토큰으로 정상 종료(HTTP 200)한 non-Gemini 스트림도 성공이 아니다 —
  // 이전엔 Gemini blockReason 이 있을 때만 거부해 Claude/OpenAI 가 content_filter/빈 delta 로
  // 무음 no-op(스피너만 사라짐)이 됐다. generic emptyResponse 로 명시 거부되는지.
  it('openai 스트림 0토큰(빈 delta) 종료 → EMPTY_RESPONSE reject + ai:done 미전송', async () => {
    M.httpsRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => {
          // finish_reason 만 있고 delta.content 없음 → extractToken null → 0토큰
          res.emit('data', Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n'));
          res.emit('data', Buffer.from('data: [DONE]\n'));
          res.emit('end');
        });
      });
      return req;
    });
    const win = makeWin();
    await expect(
      generate('e1', { text: 'x', type: 'full', provider: 'openai', model: 'gpt-4o', ollamaBaseUrl: 'http://localhost:11434' }, 'okey', win as never),
    ).rejects.toMatchObject({ code: 'EMPTY_RESPONSE', errorKey: 'emptyResponse' });
    expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'e1');
    expect(__activeRequestCount()).toBe(0);
  });

  it('gemini finishReason MAX_TOKENS 라도 토큰을 방출했으면 정상 완료 (과차단 방지)', async () => {
    M.httpsRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from(
            'data: {"candidates":[{"content":{"parts":[{"text":"부분 응답"}]}}]}\n'
            + 'data: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\n',
          ));
          res.emit('end');
        });
      });
      return req;
    });
    const win = makeWin();
    await generate('g3', { text: 'x', type: 'full', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', win as never);
    expect(win.webContents.send).toHaveBeenCalledWith('ai:done', 'g3');
  });

  // R43 I-1: 400 키 오류가 바디 기반으로 API_KEY_INVALID 매핑 + 키 redaction
  it('gemini 400 "API key not valid" → API_KEY_INVALID', async () => {
    respond(M.httpsRequest, 400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
    await expect(
      generate('g4', { text: 'x', type: 'qa', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'badkey', makeWin() as never),
    ).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
  });

  it('gemini 429 → rate limit 안내 메시지', async () => {
    respond(M.httpsRequest, 429, { error: { message: 'Resource has been exhausted' } });
    await expect(
      generate('g5', { text: 'x', type: 'qa', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', makeWin() as never),
    ).rejects.toThrow(/요청 한도를 초과/);
  });

  it('gemini 400 일반 오류(키 무관) → generic HTTP 에러 (오분류 방지)', async () => {
    respond(M.httpsRequest, 400, { error: { message: 'Request payload size exceeds the limit', status: 'INVALID_ARGUMENT' } });
    await expect(
      generate('g6', { text: 'x', type: 'full', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', makeWin() as never),
    ).rejects.toThrow(/API 요청 실패: HTTP 400/);
  });

  it('gemini provider + apiKey 없음 → API_KEY_MISSING', async () => {
    await expect(
      generate('g7', { text: 'x', type: 'qa', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never),
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
