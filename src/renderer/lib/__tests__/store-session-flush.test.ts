import { describe, it, expect, vi, beforeEach } from 'vitest';

// QA8(A+C 수렴 MED): pagehide/종료 flush 가 세션 자동저장(요약·Q&A·RAG 인덱스)까지 발화하는지
// 회귀 가드. 이전엔 flushPendingWrites 가 설정·패널폭만 flush 하고 세션 1500ms 디바운스는
// 빠뜨려, 답변/요약 완료 직후 Cmd+Q·Ctrl+R 하면 마지막 턴이 소실됐다.
//
// store.ts 는 use-session 에서 persistCurrentSession 만 가져오므로 모듈을 통째로 stub 해도
// store 로드에 지장이 없다(다른 export 는 이 테스트 그래프에서 미사용).
vi.mock('../use-session', () => ({
  persistCurrentSession: vi.fn(() => Promise.resolve()),
}));

// store.ts module init 이 localStorage 를 읽고 pagehide 리스너를 등록하므로 import 전에 stub.
const lsStore: Record<string, string> = {};
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = String(v); },
  removeItem: (k: string) => { delete lsStore[k]; },
});
vi.stubGlobal('window', {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
  },
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

import { flushPendingWrites } from '../store';
import { persistCurrentSession } from '../use-session';

describe('flushPendingWrites → 세션 flush (QA8 MED)', () => {
  beforeEach(() => {
    vi.mocked(persistCurrentSession).mockClear();
  });

  it('flush 시 persistCurrentSession 을 best-effort 로 발화한다', () => {
    flushPendingWrites();
    expect(persistCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('persistCurrentSession 이 throw 해도 flush 는 전파하지 않는다(best-effort)', () => {
    vi.mocked(persistCurrentSession).mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => flushPendingWrites()).not.toThrow();
  });
});
