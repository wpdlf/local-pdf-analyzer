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
  analyzeImageForOcr,
  generate,
  abortGenerate,
  cleanupAiService,
  __activeRequestCount,
  retryOn429,
  parseRetryAfterMs,
  mapCloudHttpError,
  mapOllamaHttpError,
  parseVisionResponse,
  finalizeVisionResult,
} from '../ai-service';
import {
  resolveNumCtx, estimateTokens, __resetStickyNumCtxForTest,
} from '../../shared/ollama-context';

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
  // QA32(A-1): num_ctx 스티키는 모듈 스코프 상태다 — 비우지 않으면 앞 테스트가 올려 둔 창이
  // 뒤 테스트로 새어 순서 의존을 만든다(QA22 가 실측한 그 클래스).
  __resetStickyNumCtxForTest();
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
    // QA10(D-LOW): AIza(Google API 키) 분기 — 이전엔 redaction 정규식이 실제 AIza 키로 검증되지
    // 않아, 패턴 오타 시 Gemini 4xx 바디에 에코된 키가 로그로 유출돼도 미탐지였다.
    ['AIza (Google 키, JSON)', { error: { message: 'API key not valid AIzaSyD1234567890ABCDEFGHIJKLMNOPQRSTUV' } }, 'SyD1234567890ABCDEFGHIJKLMNOPQRSTUV'],
  ])('에러 응답 로그에서 키 redaction: %s', async (_l, body, rawSecret) => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(M.httpsRequest, 401, body);
    await expect(analyzeImage('img', 'claude', 'm', 'x', 'key')).rejects.toThrow(/HTTP 401/);
    const logged = errSpy.mock.calls.flat().join(' ');
    expect(logged).not.toContain(rawSecret); // 원본 키 미노출
    expect(logged).toContain('REDACTED');
    errSpy.mockRestore();
  });

  // QA30 후속(A-F2 형제 누락, 실기기 스모크에서 발견): Vision/OCR 은 httpPost 를 쓰는데
  // A-F2 의 매퍼가 generateOllama 에만 붙어, 모델 미설치가 `HTTP 404` 로 뭉개졌다. 그러면
  // pdf-parser 의 per-page catch 가 '' 로 삼켜 최종 안내가 "PDF 품질을 확인해주세요" 가 된다 —
  // 실제 해결책은 `ollama pull llava` 인데 사용자를 PDF 쪽으로 보낸다.
  it('ollama vision 404(model not found) → OLLAMA_MODEL_NOT_FOUND + 모델명', async () => {
    respond(M.httpRequest, 404, { error: "model 'llava' not found" });
    await expect(analyzeImage('img', 'ollama', 'llava', 'http://localhost:11434', undefined))
      .rejects.toMatchObject({ code: 'OLLAMA_MODEL_NOT_FOUND', errorKey: 'ollamaModelNotFound', errorParams: { model: 'llava' } });
  });

  // visionModel 미설정 시 코드가 'llava' 를 기본값으로 쓰므로, 매퍼에도 그 이름이 실려야 한다.
  it('ollama vision 404 — 모델명 미지정이면 기본값 llava 가 안내에 실린다', async () => {
    respond(M.httpRequest, 404, { error: "model 'llava' not found" });
    await expect(analyzeImage('img', 'ollama', '', 'http://localhost:11434', undefined))
      .rejects.toMatchObject({ errorParams: { model: 'llava' } });
  });

  it('ollama vision 500(메모리 부족) → OLLAMA_OOM', async () => {
    respond(M.httpRequest, 500, { error: 'model requires more system memory (9.2 GiB) than is available (5.1 GiB)' });
    await expect(analyzeImage('img', 'ollama', 'llava', 'http://localhost:11434', undefined))
      .rejects.toMatchObject({ code: 'OLLAMA_OOM', errorKey: 'ollamaOutOfMemory' });
  });

  // 매퍼가 못 알아보는 에러까지 삼키면 안 된다 — 종전 generic 으로 남아야 한다.
  it('ollama vision 400(매칭되지 않는 바디) → 종전 generic 유지', async () => {
    respond(M.httpRequest, 400, { error: 'something unexpected' });
    await expect(analyzeImage('img', 'ollama', 'llava', 'http://localhost:11434', undefined))
      .rejects.toThrow(/Vision API 요청 실패: HTTP 400/);
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

  /**
   * QA32 배선 가드. `resolveNumCtx` 의 순수 테스트가 전부 그린이어도 **호출부에 배선되지
   * 않으면** 아무것도 달라지지 않는다 — 수식 렌더링에서 "순수 함수 19건 그린인데 배선이 안
   * 먹던" 전례가 있어 요청 body 를 직접 본다.
   *
   * num_ctx 를 안 보내면 Ollama 기본값 4096 이 적용되고 초과분은 프롬프트 **앞부터** 조용히
   * 버려진다(done_reason='stop' 이라 detectTruncation 이 못 잡는다).
   */
  it('ollama 요청 body 에 num_ctx 가 실린다 — 큰 프롬프트는 기본값(4096)보다 크게', async () => {
    let sentReq: ReturnType<typeof makeReq> | null = null;
    M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      sentReq = req; // write 가 이미 vi.fn 이라 호출 기록을 그대로 읽는다
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => { res.emit('data', Buffer.from('{"response":"x"}\n')); res.emit('end'); });
      });
      return req;
    });
    // ⚠️ 크기와 **문자 구성**이 이 테스트의 성패를 가른다.
    //  - 초판은 12,000자였는데 그 크기는 system 을 세든 안 세든 같은 버킷(16384)이라
    //    `resolveNumCtx('', user)` 뮤테이션을 통과시켰다.
    //  - 두 번째 시도(6,300자)는 문장에 `CPU`·공백·마침표가 섞여 실효 토큰이 3,933 로 낮아져
    //    역시 양쪽 다 8192 였다. 추정식이 비-CJK 를 3.5자/토큰으로 보기 때문이다.
    // 순수 한글 6,000자여야 system 포함 16384 / 제외 8192 로 갈린다.
    const big = '운영체제는프로세스와스레드를관리하며스케줄링정책에따라실행순서를정한다'.repeat(200).slice(0, 6000);
    await generate('req-ctx', { text: big, type: 'full', provider: 'ollama', model: 'llama3', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never);

    const written = (sentReq as unknown as ReturnType<typeof makeReq>).write.mock.calls
      .map((c) => String(c[0])).join('');
    const parsed = JSON.parse(written) as {
      system?: string; prompt?: string; options?: { num_ctx?: number; temperature?: number };
    };
    expect(parsed.options?.num_ctx, 'num_ctx 가 요청에 실리지 않는다 — 서버 기본값 4096 으로 잘린다').toBeDefined();
    expect(parsed.options!.num_ctx!).toBeGreaterThan(4096);
    // 기존 옵션을 밀어내지 않았는지도 함께 본다.
    expect(parsed.options?.temperature).toBeDefined();

    // QA32(B·D-7): 초판은 "정의됨 + >4096" 만 봐서 **`num_ctx: 8192` 상수 고정**과
    // **`resolveNumCtx('', user)`(system 미계수)** 두 뮤테이션을 모두 통과시켰다. 값이
    // 실제로 보낸 프롬프트에서 나왔는지를 보려면 body 의 system·prompt 로 되짚어야 한다.
    expect(parsed.options!.num_ctx!, 'num_ctx 가 보낸 프롬프트와 무관한 값이다')
      .toBe(resolveNumCtx(parsed.system ?? '', parsed.prompt ?? ''));
    // system 이 실제로 무게를 갖는 크기여야 위 단언이 system 미계수를 잡는다(공허 방지).
    expect(estimateTokens(parsed.system ?? '')).toBeGreaterThan(300);
  });

  it('프롬프트가 커지면 num_ctx 도 올라간다 (상수 고정 검출)', async () => {
    const send = async (text: string) => {
      let req: ReturnType<typeof makeReq> | null = null;
      M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
        const r = makeReq();
        req = r;
        queueMicrotask(() => {
          const res = makeRes({ statusCode: 200 });
          cb(res);
          queueMicrotask(() => { res.emit('data', Buffer.from('{"response":"x"}\n')); res.emit('end'); });
        });
        return r;
      });
      await generate(`rq-${text.length}`, { text, type: 'full', provider: 'ollama', model: 'llama3', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never);
      const body = (req as unknown as ReturnType<typeof makeReq>).write.mock.calls.map((c) => String(c[0])).join('');
      return (JSON.parse(body) as { options: { num_ctx: number } }).options.num_ctx;
    };
    // 작은 것 먼저 — sticky 는 상승만 하므로 순서가 중요하다.
    const small = await send('짧은 문서');
    const large = await send('운영체제는 프로세스와 스레드를 관리한다. '.repeat(400));
    expect(large, `작은 요청 ${small} / 큰 요청 ${large} — 값이 프롬프트를 따라가지 않는다`)
      .toBeGreaterThan(small);
  });

  /**
   * QA32(A-2): 첫 토큰까지의 대기는 프롬프트 평가 시간이고 그것은 num_ctx 에 비례하는데,
   * idle 타이머는 **토큰 수신만** 진전 신호로 본다. 상한을 그대로 두면 창을 키운 만큼
   * 정상 스트림이 죽는다(QA20 A-High 와 같은 클래스). 큰 프롬프트에서 기준선 60초가 지나도
   * 살아 있어야 한다.
   */
  it('창이 커지면 idle 상한도 함께 늘어난다 (60초에 정상 스트림이 죽지 않는다)', async () => {
    vi.useFakeTimers();
    try {
      M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
        const req = makeReq();
        queueMicrotask(() => { cb(makeRes({ statusCode: 200 })); }); // 헤더만, 데이터 없음
        return req;
      });
      const win = makeWin();
      const big = '운영체제는 프로세스와 스레드를 관리한다. '.repeat(400);
      const p = generate('rq-idle', { text: big, type: 'full', provider: 'ollama', model: 'llama3', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
      const settled = p.then(() => 'ok').catch(() => 'failed');

      // 기준선(60초)을 넘겨도 아직 살아 있어야 한다 — 이 프롬프트는 창이 4배로 열린다.
      await vi.advanceTimersByTimeAsync(70_000);
      expect(await Promise.race([settled, Promise.resolve('pending')]),
        'idle 상한이 기준선 그대로다 — 정상 스트림을 감시견이 죽인다').toBe('pending');

      // 스케일된 상한을 넘기면 정상적으로 실패한다(폭주 방어는 유지되어야 한다).
      await vi.advanceTimersByTimeAsync(200_000);
      expect(await settled).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  // QA32(A-5): 상한을 넘는 프롬프트는 클램프될 뿐 **여전히 앞부분이 잘린다**. 설정에서
  // maxChunkSize 를 올리면 도달하는 구간이라, 조용히 두면 원래 결함이 그대로 부활한다.
  it('상한을 넘는 프롬프트는 ai:done 에 inputTruncated 를 싣는다', async () => {
    M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => { res.emit('data', Buffer.from('{"response":"x"}\n')); res.emit('end'); });
      });
      return req;
    });
    const win = makeWin();
    const huge = '운영체제는 프로세스와 스레드를 관리한다. '.repeat(2000); // 상한 밖
    await generate('rq-of', { text: huge, type: 'full', provider: 'ollama', model: 'llama3', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);

    const doneCall = win.webContents.send.mock.calls.find((c) => c[0] === 'ai:done');
    expect(doneCall, 'ai:done 이 오지 않았다').toBeDefined();
    expect(doneCall![2], '상한 초과인데 표식이 없다 — 사용자는 잘린 줄 모른다')
      .toMatchObject({ inputTruncated: true });
  });

  it('상한 안이면 inputTruncated 를 싣지 않는다 (짝 — 늘 켜지면 위 단언이 공허하다)', async () => {
    M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => { res.emit('data', Buffer.from('{"response":"x"}\n')); res.emit('end'); });
      });
      return req;
    });
    const win = makeWin();
    await generate('rq-ok', { text: '짧은 문서', type: 'full', provider: 'ollama', model: 'llama3', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
    const doneCall = win.webContents.send.mock.calls.find((c) => c[0] === 'ai:done');
    expect(doneCall![2]).toBeUndefined();
  });

  // QA32(A-1): 하강 전환은 이득 없이 2.8초 재로드만 만든다. 큰 요청 뒤의 작은 요청은
  // 창을 유지해야 한다 — 실측에서 한국어 40쪽 문서의 22청크가 전환 8회를 냈다.
  it('큰 요청 뒤의 작은 요청은 창을 내리지 않는다 (재로드 방지)', async () => {
    const send = async (text: string) => {
      let req: ReturnType<typeof makeReq> | null = null;
      M.httpRequest.mockImplementation((_opts: unknown, cb: (r: unknown) => void) => {
        const r = makeReq();
        req = r;
        queueMicrotask(() => {
          const res = makeRes({ statusCode: 200 });
          cb(res);
          queueMicrotask(() => { res.emit('data', Buffer.from('{"response":"x"}\n')); res.emit('end'); });
        });
        return r;
      });
      await generate(`rs-${text.length}`, { text, type: 'full', provider: 'ollama', model: 'sticky-model', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never);
      const body = (req as unknown as ReturnType<typeof makeReq>).write.mock.calls.map((c) => String(c[0])).join('');
      return (JSON.parse(body) as { options: { num_ctx: number } }).options.num_ctx;
    };
    const big = await send('운영체제는 프로세스와 스레드를 관리한다. '.repeat(400));
    const small = await send('짧은 문서');
    expect(small, '창이 내려갔다 — 청크마다 모델이 재로드된다').toBe(big);
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

  // QA30(A-F2): ollama 도 이제 mapHttpError 를 갖는다 → 4xx/5xx 바디를 읽고 매퍼가 null 이면
  // 종전 generic 으로 fallback. 바디를 흘려주도록 목을 갱신(이전엔 헤더만 보내 8초 errBodyTimer
  // 를 태웠다 — 매퍼 부재로 바디를 안 읽던 시절의 목이었음).
  it('HTTP 500 (매칭되지 않는 바디) → generic API 요청 실패', async () => {
    respond(M.httpRequest, 500, { error: 'something unexpected' });
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

  // QA10(D-MED): streamRequest 인터럽션/사이즈 한도 분기 회귀 가드. 이 분기들은 "무음실패→명시
  // reject" 로 전환된 R32/R43 수정의 핵심인데 전혀 구동되지 않아, silent continue/ai:done 로
  // 되돌아가도 실패하는 테스트가 없었다(빈 결과를 '완료'로 보고하는 버그가 무경보 통과).
  it('스트림 1MB 초과 라인 → 명시 reject + ai:done 미전송 (R32 P2)', async () => {
    M.httpRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from('x'.repeat(1024 * 1024 + 1) + '\n'));
          res.emit('end');
        });
      });
      return req;
    });
    const win = makeWin();
    await expect(
      generate('big1', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never),
    ).rejects.toThrow(/비정상적으로 큰 라인/);
    expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'big1');
    expect(__activeRequestCount()).toBe(0);
  });

  it('스트림 close 시 res.complete=false → streamDisconnected reject + ai:done 미전송', async () => {
    M.httpRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200, complete: false });
        cb(res);
        queueMicrotask(() => { res.emit('close'); });
      });
      return req;
    });
    const win = makeWin();
    await expect(
      generate('disc1', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never),
    ).rejects.toMatchObject({ errorKey: 'streamDisconnected' });
    expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'disc1');
    expect(__activeRequestCount()).toBe(0);
  });

  it('5분 요청 타임아웃 발화 → streamTimeout reject + ai:done 미전송', async () => {
    let capturedReq: ReturnType<typeof makeReq> | undefined;
    M.httpRequest.mockImplementation(() => { capturedReq = makeReq(); return capturedReq; });
    const win = makeWin();
    const p = generate('to1', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
    // streamRequest 가 req.setTimeout(300000, cb) 를 등록할 때까지 대기 후 콜백 직접 발화(결정적).
    await vi.waitFor(() => { if (typeof capturedReq?.__timeoutCb !== 'function') throw new Error('pending'); });
    capturedReq!.__timeoutCb!();
    await expect(p).rejects.toMatchObject({ errorKey: 'streamTimeout' });
    expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'to1');
    expect(__activeRequestCount()).toBe(0);
  });

  it('60초 무응답(idle) → streamNoResponse reject + ai:done 미전송', async () => {
    vi.useFakeTimers();
    try {
      M.httpRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
        const req = makeReq();
        // 응답 헤더만 도착하고 data/end 가 오지 않아 idle timer(60s) 가 발화하는 시나리오.
        queueMicrotask(() => { cb(makeRes({ statusCode: 200 })); });
        return req;
      });
      const win = makeWin();
      const p = generate('idle1', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
      // rejection 핸들러를 타이머 전진 전에 부착 — 60s 발화가 unhandled 로 뜨는 창 제거.
      const assertion = expect(p).rejects.toMatchObject({ errorKey: 'streamNoResponse' });
      await vi.advanceTimersByTimeAsync(60000);
      await assertion;
      expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'idle1');
      expect(__activeRequestCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // 4-way 파리티(딥다이브): 클라우드 생성 출력 토큰 상한(4096)이 세 프로바이더 모두 요청 바디에
  // 실리는지. 이전엔 Claude/Gemini 만 있고 OpenAI 는 누락돼 출력 길이·비용이 갈렸다.
  it.each([
    ['claude', '"max_tokens":4096', 'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n'],
    ['openai', '"max_tokens":4096', 'data: {"choices":[{"delta":{"content":"hi"}}]}\n'],
    ['gemini', '"maxOutputTokens":4096', 'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n'],
  ] as const)('%s generate 요청 바디에 출력 토큰 상한 포함', async (provider, needle, tokenLine) => {
    let capturedReq: ReturnType<typeof makeReq> | undefined;
    M.httpsRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      capturedReq = req;
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200 });
        cb(res);
        queueMicrotask(() => { res.emit('data', Buffer.from(tokenLine)); res.emit('end'); });
      });
      return req;
    });
    await generate('cap1', { text: 'x', type: 'full', provider, model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'key', makeWin() as never);
    const body = String(capturedReq!.write.mock.calls[0]![0]);
    expect(body).toContain(needle);
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
    // QA30(A-F5): 원 의도(토큰이 나왔으면 **정상 완료** — 과차단 방지)는 그대로 유지된다.
    // reject 하지 않고 ai:done 을 보낸다. 달라진 것은 잘림 **표식**이 페이로드로 붙는 것뿐.
    await generate('g3', { text: 'x', type: 'full', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', win as never);
    expect(win.webContents.send).toHaveBeenCalledWith('ai:done', 'g3', { truncated: true });
    expect(win.webContents.send).toHaveBeenCalledWith('ai:token', 'g3', '부분 응답');
  });

  // R43 I-1: 400 키 오류가 바디 기반으로 API_KEY_INVALID 매핑 + 키 redaction
  it('gemini 400 "API key not valid" → API_KEY_INVALID', async () => {
    respond(M.httpsRequest, 400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
    await expect(
      generate('g4', { text: 'x', type: 'qa', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'badkey', makeWin() as never),
    ).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
  });

  it('gemini 429 → rate limit 안내 메시지 (재시도 1회 소진 후)', async () => {
    // QA30(A-F10): 스트리밍 429 도 1회 재시도한다 — 재시도까지 실패하면 종전 안내로 거부.
    // 백오프(2s+jitter)를 fake timer 로 전진시켜 실시간 대기를 없앤다.
    vi.useFakeTimers();
    try {
      respond(M.httpsRequest, 429, { error: { message: 'Resource has been exhausted' } });
      const p = generate('g5', { text: 'x', type: 'qa', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', makeWin() as never);
      const assertion = expect(p).rejects.toThrow(/요청 한도를 초과/);
      await vi.advanceTimersByTimeAsync(2600);
      await assertion;
      expect(M.httpsRequest).toHaveBeenCalledTimes(2); // 최초 1 + 재시도 1
    } finally {
      vi.useRealTimers();
    }
  });

  it('gemini 400 일반 오류(키 무관) → generic HTTP 에러 (오분류 방지)', async () => {
    respond(M.httpsRequest, 400, { error: { message: 'Request payload size exceeds the limit', status: 'INVALID_ARGUMENT' } });
    await expect(
      generate('g6', { text: 'x', type: 'full', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', makeWin() as never),
    ).rejects.toThrow(/API 요청 실패: HTTP 400/);
  });

  // QA13(B-LOW): Gemini 403 은 대개 PERMISSION_DENIED(API 미활성화·지역 차단)로 키는 멀쩡한데
  // "키 무효" 로 오진하던 것 제거 — 401 만 auth, 403 은 generic 으로 위임(Claude/OpenAI 정합).
  it('gemini 403(PERMISSION_DENIED) → generic HTTP 에러 (키 무효 오진 방지)', async () => {
    respond(M.httpsRequest, 403, { error: { message: 'Generative Language API has not been used in project', status: 'PERMISSION_DENIED' } });
    await expect(
      generate('g403', { text: 'x', type: 'qa', provider: 'gemini', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'gkey', makeWin() as never),
    ).rejects.toThrow(/API 요청 실패: HTTP 403/);
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
    // R34 P1: abort 후 entry 즉시 제거 — TTL leak 없음
    expect(__activeRequestCount()).toBe(0);
  });
});

// ─── QA30 A축 회귀 넷 ───

/** 200 스트림 목 — 주어진 본문을 한 번에 흘리고 종료. */
function stream(mock: ReturnType<typeof vi.fn>, body: string) {
  mock.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
    const req = makeReq();
    queueMicrotask(() => {
      const res = makeRes({ statusCode: 200 });
      cb(res);
      queueMicrotask(() => { res.emit('data', Buffer.from(body)); res.emit('end'); });
    });
    return req;
  });
}

// QA30(A-F2): 기본 프로바이더인 Ollama 만 mapHttpError 가 없어 4xx/5xx 바디를 **아예 읽지
// 않았다**. 실측 대조: `ollama 404 → "API 요청 실패: HTTP 404"` vs `claude 503 → cloudOverloaded`.
// 버려지던 사유는 모델 미설치와 로드 OOM — 둘 다 사용자가 바로 조치할 수 있는 정보다.
describe('QA30 A-F2: Ollama 에러 바디 판독', () => {
  it('404 + "not found, try pulling it first" → 모델 미설치 안내 (모델명 포함)', async () => {
    respond(M.httpRequest, 404, { error: 'model "qwen3.5:4b" not found, try pulling it first' });
    await expect(
      generate('o404', { text: 'x', type: 'full', provider: 'ollama', model: 'qwen3.5:4b', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never),
    ).rejects.toMatchObject({ code: 'OLLAMA_MODEL_NOT_FOUND', errorKey: 'ollamaModelNotFound', errorParams: { model: 'qwen3.5:4b' } });
  });

  it('500 + 메모리 부족 문구 → OOM 안내 (실제 용량 문구 보존)', async () => {
    respond(M.httpRequest, 500, { error: 'model requires more system memory (9.2 GiB) than is available (5.1 GiB)' });
    const err = await generate('ooom', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never)
      .then(() => null, (e: unknown) => e as Error & { code?: string; errorKey?: string; errorParams?: Record<string, string> });
    expect(err?.code).toBe('OLLAMA_OOM');
    expect(err?.errorKey).toBe('ollamaOutOfMemory');
    expect(err?.errorParams?.detail).toContain('9.2 GiB');
  });

  it('mapOllamaHttpError — OOM 은 상태코드와 무관하게 먼저 가른다 / 무관한 에러는 null', () => {
    expect(mapOllamaHttpError(500, 'model requires more system memory (9 GiB)', 'm')).toMatchObject({ errorKey: 'ollamaOutOfMemory' });
    expect(mapOllamaHttpError(404, 'model requires more system memory (9 GiB)', 'm')).toMatchObject({ errorKey: 'ollamaOutOfMemory' });
    expect(mapOllamaHttpError(400, 'invalid options', 'm')).toBeNull();
    expect(mapOllamaHttpError(503, 'server busy', 'm')).toBeNull();
  });
});

// QA30(A-F3): 비스트리밍 Vision/OCR 이 4프로바이더 전부 빈 응답·차단을 success 로 반환하던 것.
// 대조군인 생성 스트림은 0토큰이면 EMPTY_RESPONSE/BLOCKED 로 거부한다(streamRequest).
describe('QA30 A-F3: Vision/OCR 빈 응답·차단 감지', () => {
  it.each([
    ['ollama 빈 response', 'ollama', false, { response: '' }],
    ['claude content 없음', 'claude', true, { content: [] }],
    ['openai 빈 message.content', 'openai', true, { choices: [{ message: { content: '' } }] }],
    ['gemini parts 없음', 'gemini', true, { candidates: [{ content: { parts: [] } }] }],
  ] as const)('%s → EMPTY_RESPONSE throw (success 반환 금지)', async (_l, provider, https, body) => {
    respond(https ? M.httpsRequest : M.httpRequest, 200, body);
    await expect(analyzeImage('img', provider, 'm', 'http://localhost:11434', 'key'))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE', errorKey: 'emptyResponse' });
  });

  it('gemini SAFETY 차단 → BLOCKED + 사유 전달 (모델/키 오해 방지)', async () => {
    respond(M.httpsRequest, 200, { promptFeedback: { blockReason: 'SAFETY' } });
    await expect(analyzeImage('img', 'gemini', 'm', 'x', 'gkey'))
      .rejects.toMatchObject({ code: 'BLOCKED', errorKey: 'responseBlocked', errorParams: { reason: 'SAFETY' } });
  });

  it('OCR 경로도 동일 계약 — 공백만 남는 응답은 EMPTY_RESPONSE', async () => {
    respond(M.httpRequest, 200, { response: '   \n  ' });
    await expect(analyzeImageForOcr('img', 'ollama', 'llava', 'http://localhost:11434', undefined))
      .rejects.toMatchObject({ code: 'EMPTY_RESPONSE' });
  });

  it('본문이 있으면 종료 사유가 비정상(length)이어도 정상 반환 — 스트리밍의 과차단 방지와 대칭', async () => {
    respond(M.httpsRequest, 200, { choices: [{ message: { content: '차트 설명' }, finish_reason: 'length' }] });
    expect(await analyzeImage('img', 'openai', 'gpt-4o', 'x', 'key')).toBe('차트 설명');
  });

  it('parseVisionResponse — provider 별 본문/종료사유 추출 (정상 종료는 사유 없음)', () => {
    expect(parseVisionResponse('ollama', { response: 'a', done_reason: 'stop' })).toEqual({ text: 'a', blockReason: null });
    expect(parseVisionResponse('claude', { content: [{ text: 'b' }], stop_reason: 'end_turn' })).toEqual({ text: 'b', blockReason: null });
    expect(parseVisionResponse('claude', { content: [], stop_reason: 'refusal' })).toEqual({ text: '', blockReason: 'refusal' });
    expect(parseVisionResponse('openai', { choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] })).toEqual({ text: '', blockReason: 'content_filter' });
    expect(parseVisionResponse('gemini', { candidates: [{ content: { parts: [{ text: 'c' }] }, finishReason: 'STOP' }] })).toEqual({ text: 'c', blockReason: null });
    expect(parseVisionResponse('gemini', { promptFeedback: { blockReason: 'SAFETY' } })).toEqual({ text: '', blockReason: 'SAFETY' });
  });

  it('finalizeVisionResult — sanitize 결과가 공백뿐이면 거부 (sanitize 가 본문을 날린 경우 포함)', () => {
    expect(finalizeVisionResult({ text: '  ok  ', blockReason: null }, (x) => x)).toBe('  ok  ');
    // URL 만 있던 응답이 sanitize 로 비워지는 경우도 성공으로 새면 안 된다.
    expect(() => finalizeVisionResult({ text: 'https://x', blockReason: null }, () => '')).toThrow(/빈 응답/);
  });
});

// QA30(A-F4): Vision/OCR 경로의 401 이 code/errorKey 없이 나가 "OCR 실패" 로 둔갑하던 것.
describe('QA30 A-F4: Vision/OCR 401 은 auth 로 구분된다', () => {
  it('claude vision 401 → API_KEY_INVALID + apiKeyInvalid (generate 401 과 동일 계약)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(M.httpsRequest, 401, { error: { message: 'invalid x-api-key' } });
    await expect(analyzeImage('img', 'claude', 'm', 'x', 'stale-key'))
      .rejects.toMatchObject({ code: 'API_KEY_INVALID', errorKey: 'apiKeyInvalid', status: 401 });
    errSpy.mockRestore();
  });

  it('401 이 아닌 4xx 에는 auth 코드가 붙지 않는다 (오분류 방지)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    respond(M.httpsRequest, 400, { error: { message: 'bad image' } });
    const err = await analyzeImage('img', 'claude', 'm', 'x', 'key')
      .then(() => null, (e: unknown) => e as Error & { code?: string });
    expect(err?.code).toBeUndefined();
    errSpy.mockRestore();
  });
});

// QA30(A-F5): 출력 상한 도달로 잘린 응답이 4프로바이더 모두 "완료" 로 커밋되던 것.
// 거부가 아니라 **표식**이다 — 정상 완료는 유지하고 ai:done 페이로드로만 알린다.
describe('QA30 A-F5: 잘림 표식이 ai:done 에 실린다', () => {
  it.each([
    ['claude', true, 'data: {"type":"content_block_delta","delta":{"text":"부분"}}\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}\n'],
    ['openai', true, 'data: {"choices":[{"delta":{"content":"부분"}}]}\ndata: {"choices":[{"delta":{},"finish_reason":"length"}]}\n'],
    ['ollama', false, '{"response":"부분"}\n{"done":true,"done_reason":"length"}\n'],
  ] as const)('%s 잘림 → ai:done 에 { truncated: true }', async (provider, https, body) => {
    stream(https ? M.httpsRequest : M.httpRequest, body);
    const win = makeWin();
    await generate('tr1', { text: 'x', type: 'full', provider, model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'key', win as never);
    expect(win.webContents.send).toHaveBeenCalledWith('ai:done', 'tr1', { truncated: true });
  });

  it('정상 종료에는 메타를 붙이지 않는다 (기존 계약 보존)', async () => {
    stream(M.httpRequest, '{"response":"완결"}\n{"done":true,"done_reason":"stop"}\n');
    const win = makeWin();
    await generate('tr2', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
    expect(win.webContents.send).toHaveBeenCalledWith('ai:done', 'tr2');
    expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'tr2', { truncated: true });
  });
});

// QA30(A-F6): switch 에 exhaustive default 가 없어, 프로바이더 분기를 빠뜨리면 undefined 를
// 돌려주고 요약이 "성공" 으로 끝났다.
describe('QA30 A-F6: provider switch exhaustive 가드', () => {
  it('알 수 없는 provider → 명시 throw + activeRequests 누수 없음', async () => {
    await expect(
      generate('bad1', { text: 'x', type: 'full', provider: 'nope' as never, model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never),
    ).rejects.toThrow(/지원하지 않는 AI 프로바이더/);
    expect(__activeRequestCount()).toBe(0);
  });
});

// QA30(A-F7): Claude 임베딩 폴백의 catch 가 **사용자 취소까지** null 로 뭉개
// "프로바이더 미지원 → 키워드 모드" 로 보고하던 것.
describe('QA30 A-F7: Claude 임베딩 폴백은 취소를 삼키지 않는다', () => {
  it('이미 abort 된 signal → null 이 아니라 Aborted 로 reject (ollama 경로와 동형)', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(generateEmbeddings(['a'], 'claude', 'http://localhost:11434', 'key', undefined, controller.signal))
      .rejects.toThrow('Aborted');
  });

  it('취소가 아닌 실패는 종전대로 null (키워드 fallback 보존)', async () => {
    respond(M.httpRequest, 500, 'boom');
    expect(await generateEmbeddings(['a'], 'claude', 'http://localhost:11434', 'key')).toBeNull();
  });
});

// QA30(A-F8): 0토큰 판정이 truthy 기준이라 공백만 흘려도 ai:done 으로 "성공" 했다.
describe('QA30 A-F8: 공백만 방출한 스트림은 성공이 아니다', () => {
  it('ollama 가 공백 토큰만 흘리고 종료 → EMPTY_RESPONSE reject + ai:done 미전송', async () => {
    stream(M.httpRequest, '{"response":"   "}\n{"response":"\\n\\n"}\n');
    const win = makeWin();
    await expect(
      generate('ws1', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never),
    ).rejects.toMatchObject({ code: 'EMPTY_RESPONSE', errorKey: 'emptyResponse' });
    expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'ws1');
    expect(__activeRequestCount()).toBe(0);
  });

  it('공백 뒤에 실제 글자가 오면 정상 완료 (과차단 방지)', async () => {
    stream(M.httpRequest, '{"response":"  "}\n{"response":"본문"}\n');
    const win = makeWin();
    await generate('ws2', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
    expect(win.webContents.send).toHaveBeenCalledWith('ai:done', 'ws2');
  });
});

// QA30(A-F10): 스트리밍만 429 재시도도 Retry-After 도 없던 경로 간 비대칭.
describe('QA30 A-F10: 스트리밍 429 는 첫 토큰 전에 한해 재시도한다', () => {
  it('ollama 429 1회 → 백오프 재시도로 성공', async () => {
    vi.useFakeTimers();
    try {
      M.httpRequest
        .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
          const req = makeReq();
          queueMicrotask(() => {
            const res = makeRes({ statusCode: 429 });
            cb(res);
            queueMicrotask(() => { res.emit('data', Buffer.from('{"error":"rate"}')); res.emit('end'); });
          });
          return req;
        })
        .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
          const req = makeReq();
          queueMicrotask(() => {
            const res = makeRes({ statusCode: 200 });
            cb(res);
            queueMicrotask(() => { res.emit('data', Buffer.from('{"response":"재시도 성공"}\n')); res.emit('end'); });
          });
          return req;
        });
      const win = makeWin();
      const p = generate('rt1', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never);
      await vi.advanceTimersByTimeAsync(2600);
      await p;
      expect(M.httpRequest).toHaveBeenCalledTimes(2);
      expect(win.webContents.send).toHaveBeenCalledWith('ai:token', 'rt1', '재시도 성공');
      expect(__activeRequestCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Retry-After 헤더가 있으면 그 값을 존중한다 (지수 백오프보다 우선)', async () => {
    vi.useFakeTimers();
    try {
      M.httpsRequest
        .mockImplementationOnce((_o: unknown, cb: (r: unknown) => void) => {
          const req = makeReq();
          queueMicrotask(() => {
            const res = makeRes({ statusCode: 429, headers: { 'retry-after': '30' } });
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
            queueMicrotask(() => { res.emit('data', Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n')); res.emit('end'); });
          });
          return req;
        });
      const p = generate('rt2', { text: 'x', type: 'full', provider: 'openai', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, 'key', makeWin() as never);
      // 지수 백오프(2s)만 봤다면 여기서 이미 2회차가 떠 있어야 한다 — 아직 1회여야 정상.
      await vi.advanceTimersByTimeAsync(3000);
      expect(M.httpsRequest).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(28000);
      await p;
      expect(M.httpsRequest).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('토큰이 흐른 뒤의 실패는 재시도하지 않는다 (응답 중복 방지)', async () => {
    M.httpRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
      const req = makeReq();
      queueMicrotask(() => {
        const res = makeRes({ statusCode: 200, complete: false });
        cb(res);
        queueMicrotask(() => {
          res.emit('data', Buffer.from('{"response":"앞부분"}\n'));
          res.emit('close');
        });
      });
      return req;
    });
    const win = makeWin();
    await expect(
      generate('rt3', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, win as never),
    ).rejects.toMatchObject({ errorKey: 'streamDisconnected' });
    expect(M.httpRequest).toHaveBeenCalledTimes(1);
  });

  it('백오프 대기 중 ai:abort → 재시도하지 않고 ABORTED 로 끝난다 (취소가 닿는다)', async () => {
    vi.useFakeTimers();
    try {
      M.httpRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
        const req = makeReq();
        queueMicrotask(() => {
          const res = makeRes({ statusCode: 429 });
          cb(res);
          queueMicrotask(() => { res.emit('data', Buffer.from('{"error":"rate"}')); res.emit('end'); });
        });
        return req;
      });
      const p = generate('rt4', { text: 'x', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://localhost:11434' }, undefined, makeWin() as never);
      const assertion = expect(p).rejects.toMatchObject({ code: 'ABORTED' });
      await vi.advanceTimersByTimeAsync(100); // 1회 실패 → 백오프 대기 진입
      abortGenerate('rt4');
      await vi.advanceTimersByTimeAsync(3000);
      await assertion;
      expect(M.httpRequest).toHaveBeenCalledTimes(1); // 재시도 미발생
      expect(__activeRequestCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
