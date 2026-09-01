import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripJsComments } from '../../shared/__tests__/helpers/source-scan';

/**
 * QA30(A-F1): activeRequests TTL 의 **진전 기반 판정** 회귀 넷.
 *
 * 이전 구현은 `startedAt`(수명) 기준이라 토큰이 활발히 흐르는 정상 스트림도 10분에
 * `entry.abort()` 로 죽었고, 그 abort 가 사용자 취소와 같은 `code:'ABORTED'` 로 나가
 * 렌더러의 `rawCode !== 'ABORTED'` 게이트에서 **에러 배너와 부분 복구 제안을 모두**
 * 건너뛰었다(스피너만 사라지고 설명 없음).
 *
 * 별도 파일인 이유: TTL 스위퍼는 **모듈 로드 시점에** setInterval 로 만들어지므로,
 * `vi.useFakeTimers()` 를 켠 **뒤에** 모듈을 새로 평가해야(`vi.resetModules()` + 동적
 * import) 그 인터벌이 fake timer 위에 올라간다. 정적 import 를 공유하는 기존 net 스위트에
 * 섞으면 스위퍼가 real timer 로 남아 이 테스트가 통째로 공허해진다.
 */

const M = vi.hoisted(() => ({
  httpRequest: vi.fn(),
  httpGet: vi.fn(),
  httpsRequest: vi.fn(),
  httpsGet: vi.fn(),
}));

vi.mock('http', () => ({ default: { request: (...a: unknown[]) => M.httpRequest(...a), get: (...a: unknown[]) => M.httpGet(...a) } }));
vi.mock('https', () => ({ default: { request: (...a: unknown[]) => M.httpsRequest(...a), get: (...a: unknown[]) => M.httpsGet(...a) } }));
vi.mock('electron', () => ({ BrowserWindow: class { static getAllWindows(): unknown[] { return []; } } }));

function makeReq() {
  const req = new EventEmitter() as EventEmitter & {
    destroyed: boolean; write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>; setTimeout: ReturnType<typeof vi.fn>;
  };
  req.destroyed = false;
  req.write = vi.fn();
  req.end = vi.fn();
  req.destroy = vi.fn(() => { req.destroyed = true; });
  req.setTimeout = vi.fn(() => req);
  return req;
}

function makeRes(statusCode = 200) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number; headers: Record<string, string>; complete: boolean; destroyed: boolean;
    resume: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>;
  };
  res.statusCode = statusCode;
  res.headers = {};
  res.complete = true;
  res.destroyed = false;
  res.resume = vi.fn();
  res.destroy = vi.fn(() => { res.destroyed = true; });
  return res;
}

function makeWin() {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } };
}

const REQ = {
  text: '본문', type: 'full' as const, provider: 'ollama' as const,
  model: 'llama3', ollamaBaseUrl: 'http://localhost:11434',
};

/** fake timer 위에서 ai-service 를 새로 평가한다 (TTL 인터벌도 fake 위에 올라가도록). */
async function loadServiceOnFakeTimers() {
  vi.useFakeTimers();
  vi.resetModules();
  return import('../ai-service');
}

/** 30초마다 토큰 한 개를 흘리는 Ollama 스트림 목. 반환값으로 스트림을 수동 종료할 수 있다. */
function mockDripStream(intervalMs = 30000) {
  const control: { end: () => void } = { end: () => {} };
  M.httpRequest.mockImplementation((_o: unknown, cb: (r: unknown) => void) => {
    const req = makeReq();
    queueMicrotask(() => {
      const res = makeRes(200);
      cb(res);
      let n = 0;
      const iv = setInterval(() => {
        n++;
        res.emit('data', Buffer.from(`{"response":"t${n}"}\n`));
      }, intervalMs);
      control.end = () => { clearInterval(iv); res.emit('end'); };
    });
    return req;
  });
  return control;
}

/** promise 의 settle 상태를 폴링 없이 관찰 — unhandled rejection 없이 "아직 안 끝났음" 을 단언. */
function watch<T>(p: Promise<T>): { get: () => unknown } {
  let state: unknown = 'pending';
  p.then((v) => { state = { resolved: v }; }, (e) => { state = e; });
  return { get: () => state };
}

describe('QA30 A-F1: activeRequests TTL 은 수명이 아니라 진전을 본다', () => {
  it('30초마다 토큰이 흐르는 스트림은 660초에도 살아 있다 (핵심 회귀)', async () => {
    const svc = await loadServiceOnFakeTimers();
    try {
      const stream = mockDripStream();
      const win = makeWin();
      const p = svc.generate('ttl-alive', REQ, undefined, win as never);
      const w = watch(p);

      // 저장소 최초의 600초 초과 전진. 구현이 startedAt 기준이면 660초 sweep 에서 abort 된다.
      await vi.advanceTimersByTimeAsync(660000);

      expect(w.get()).toBe('pending');
      expect(win.webContents.send).toHaveBeenCalledWith('ai:token', 'ttl-alive', 't21');
      expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'ttl-alive');
      expect(svc.__activeRequestCount()).toBe(1);

      // 그 뒤 정상 종료도 그대로 성립한다 (살려 두기만 하고 끝을 못 내면 의미 없음).
      stream.end();
      await vi.advanceTimersByTimeAsync(0);
      expect(w.get()).toEqual({ resolved: undefined });
      expect(win.webContents.send).toHaveBeenCalledWith('ai:done', 'ttl-alive');
      expect(svc.__activeRequestCount()).toBe(0);
    } finally {
      svc.cleanupAiService();
      vi.useRealTimers();
    }
  });

  it('진전이 없는 고아 entry 는 여전히 600초 TTL 로 회수된다 (가드가 공허해지지 않았다)', async () => {
    const svc = await loadServiceOnFakeTimers();
    try {
      const controller = new AbortController();
      svc.registerEmbedRequest('orphan', controller);
      expect(svc.__activeRequestCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(660000);

      expect(svc.__activeRequestCount()).toBe(0);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      svc.cleanupAiService();
      vi.useRealTimers();
    }
  });

  it('절대 백스톱(3시간)에 걸린 요청은 ABORTED 가 아니라 STALLED/errorKey 로 나간다', async () => {
    const svc = await loadServiceOnFakeTimers();
    try {
      mockDripStream(); // 30초마다 진전 → idle(60s)·무진전 TTL(600s) 은 계속 리셋
      const win = makeWin();
      const w = watch(svc.generate('ttl-max', REQ, undefined, win as never));

      await vi.advanceTimersByTimeAsync(svc.MAX_AI_REQUEST_DURATION_MS + 120000);

      // 사용자 취소와 **다른 코드** 여야 렌더러가 배너·부분복구를 태운다.
      expect(w.get()).toMatchObject({ code: 'STALLED', errorKey: 'streamMaxDuration' });
      expect(win.webContents.send).not.toHaveBeenCalledWith('ai:done', 'ttl-max');
      expect(svc.__activeRequestCount()).toBe(0);
    } finally {
      svc.cleanupAiService();
      vi.useRealTimers();
    }
  });

  it('shouldReclaimRequest — 무진전은 stalled, 진전 중 초장수는 maxAge, 그 외 null', async () => {
    const svc = await loadServiceOnFakeTimers();
    try {
      const MAX = svc.MAX_AI_REQUEST_DURATION_MS;
      // 11분째 무진전 → stalled
      expect(svc.shouldReclaimRequest(660000, { startedAt: 0, lastProgressAt: 0 })).toBe('stalled');
      // 9분째 무진전 → 아직 아님
      expect(svc.shouldReclaimRequest(540000, { startedAt: 0, lastProgressAt: 0 })).toBeNull();
      // 3시간 넘게 살아 있지만 방금 진전 → maxAge (수명 상한만 남는다)
      expect(svc.shouldReclaimRequest(MAX + 1000, { startedAt: 0, lastProgressAt: MAX })).toBe('maxAge');
      // 3시간 직전 + 진전 중 → 살려 둔다
      expect(svc.shouldReclaimRequest(MAX - 1000, { startedAt: 0, lastProgressAt: MAX - 2000 })).toBeNull();
    } finally {
      svc.cleanupAiService();
      vi.useRealTimers();
    }
  });
});

/**
 * QA30(A-F1 → C-추가3): 절대 상한은 이제 `shared/constants.ts` 의 MAX_AI_REQUEST_DURATION_MS
 * **단일 출처**다. 종전엔 main 과 renderer 에 리터럴 3시간이 각각 있었고, main 쪽이 실제로는
 * 10분 TTL 로 더 짧게 동작해 renderer 가 명문화한 "토큰이 흐르는 한 완주" 계약을 뒤에서 깼다.
 *
 * 값 비교 가드는 단일 출처가 된 순간 의미를 잃는다(같은 상수를 자기 자신과 비교하게 된다).
 * 그래서 지키는 대상을 **배선**으로 바꾼다 — 두 파일이 리터럴을 재도입하지 않고 공유 상수를
 * 쓰고 있는가. semantic-search 의 RAG_MIN_SCORE 가드(QA30 B-7)와 같은 형태다.
 */
describe('QA30 A-F1: 절대 상한은 shared 상수 단일 출처를 쓴다', () => {
  it('ai-service 가 노출하는 값이 shared 상수와 같다', async () => {
    const svc = await import('../ai-service');
    const shared = await import('../../shared/constants');
    expect(svc.MAX_AI_REQUEST_DURATION_MS).toBe(shared.MAX_AI_REQUEST_DURATION_MS);
    expect(shared.MAX_AI_REQUEST_DURATION_MS).toBe(3 * 60 * 60 * 1000);
  });

  it('renderer 의 MAX_TOTAL_MS 가 리터럴이 아니라 shared 상수 배선이다', () => {
    // 경로는 반드시 path.join 으로 — 하드코딩한 구분자는 Ubuntu CI 에서만 깨진다.
    const file = join(import.meta.dirname, '..', '..', 'renderer', 'lib', 'use-summarize.ts');
    // 주석을 걷고 본다 — 설명 주석에 매칭돼 통과하는 QA29 D1-2 구멍 차단.
    const code = stripJsComments(readFileSync(file, 'utf-8'));
    expect(code).toMatch(/import\s*\{[^}]*MAX_AI_REQUEST_DURATION_MS[^}]*\}\s*from\s*'\.\.\/\.\.\/shared\/constants'/);
    expect(code).toMatch(/export const MAX_TOTAL_MS\s*=\s*MAX_AI_REQUEST_DURATION_MS\s*;/);
    expect(code, '절대 상한 리터럴이 renderer 에 재도입됐다 — shared/constants 단일 출처를 쓸 것')
      .not.toMatch(/MAX_TOTAL_MS\s*=\s*[0-9]/);
  });
});
