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

// store.ts module init 이 localStorage 를 읽고 종료 handshake(onFlushBeforeQuit) 리스너를
// 모듈-init 시점에 등록한다. 정적 import 는 호이스팅돼 vi.stubGlobal 보다 먼저 실행되므로,
// init 시점 등록이 stub 을 보려면 import 이전에 실행되는 vi.hoisted 로 전역을 세팅해야 한다.
// QA10(C-MED): onFlushBeforeQuit 콜백을 holder.cb 로 붙잡아, flush 요청 시 persist 착지 후
// flushBeforeQuitDone 으로 ack 하는지 검증한다.
const H = vi.hoisted(() => {
  const lsStore: Record<string, string> = {};
  const flushBeforeQuitDone = vi.fn();
  const holder: { cb: (() => void) | null } = { cb: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).localStorage = {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = String(v); },
    removeItem: (k: string) => { delete lsStore[k]; },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    electronAPI: {
      settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
      onFlushBeforeQuit: (cb: () => void) => { holder.cb = cb; return () => { holder.cb = null; }; },
      flushBeforeQuitDone,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return { flushBeforeQuitDone, holder };
});

import { flushPendingWrites, useAppStore } from '../store';
import { persistCurrentSession } from '../use-session';

const flushBeforeQuitDone = H.flushBeforeQuitDone;

describe('flushPendingWrites → 세션 flush (QA8 MED)', () => {
  beforeEach(() => {
    vi.mocked(persistCurrentSession).mockClear();
  });

  it('flush 시 persistCurrentSession 을 flush=true 로 발화한다 (QA12 B-MED: committed-only 저장)', () => {
    flushPendingWrites();
    expect(persistCurrentSession).toHaveBeenCalledTimes(1);
    expect(persistCurrentSession).toHaveBeenCalledWith(true);
  });

  it('persistCurrentSession 이 throw 해도 flush 는 전파하지 않는다(best-effort)', () => {
    vi.mocked(persistCurrentSession).mockImplementationOnce(() => { throw new Error('boom'); });
    expect(() => flushPendingWrites()).not.toThrow();
  });

  it('flushPendingWrites 는 persist 완료 promise 를 반환한다(종료 handshake await 용, QA10 C-MED)', async () => {
    await expect(flushPendingWrites()).resolves.toBeUndefined();
  });

  it('종료 handshake: onFlushBeforeQuit → persist 발화 후 flushBeforeQuitDone 으로 ack (QA10 C-MED)', async () => {
    expect(H.holder.cb).toBeTypeOf('function');
    flushBeforeQuitDone.mockClear();
    vi.mocked(persistCurrentSession).mockClear();
    H.holder.cb!();
    expect(persistCurrentSession).toHaveBeenCalledTimes(1);
    expect(persistCurrentSession).toHaveBeenCalledWith(true); // QA12: 종료 handshake 도 flush 경로
    // persist promise 착지 후 정확히 1회 ack
    await new Promise((r) => setTimeout(r));
    expect(flushBeforeQuitDone).toHaveBeenCalledTimes(1);
  });

  // QA27(D-Important): QA24(I5)가 "세션과 설정 **둘 다** 착지한 뒤 ack" 로 고쳤는데, 이 파일은
  // settingsFlushed 를 한 번도 언급하지 않아 그 항이 늘 미리 resolve 된 상태였다 —
  // `return persisted` 로 되돌려도 전 스위트가 초록이었다. 실제 손실은 "설정 화면에서 커스텀
  // 템플릿을 저장하고 곧바로 종료" 할 때의 300ms 디바운스분이다.
  it('종료 handshake: 대기 중인 설정 IPC 가 착지할 때까지 ack 하지 않는다 (QA24 I5)', async () => {
    flushBeforeQuitDone.mockClear();
    vi.mocked(persistCurrentSession).mockClear();

    // 설정 변경 → 300ms 디바운스 대기 상태(pendingSettingsPayload + 타이머)를 만든다.
    let releaseSettings!: () => void;
    const settingsSet = vi.mocked(window.electronAPI.settings.set);
    settingsSet.mockImplementationOnce(() => new Promise((r) => { releaseSettings = () => r(undefined as never); }) as ReturnType<typeof settingsSet>);
    useAppStore.getState().updateSettings({
      ...useAppStore.getState().settings,
      customSummaryTemplates: [{ id: 't1', name: '새 템플릿', prompt: '요약해줘' }],
    });

    H.holder.cb!();
    await new Promise((r) => setTimeout(r));
    expect(settingsSet, 'flush 가 디바운스 대기분을 즉시 발화해야 한다').toHaveBeenCalled();
    expect(flushBeforeQuitDone, '설정이 디스크에 닿기 전에 ack 하면 그 변경이 종료에 잘린다').not.toHaveBeenCalled();

    releaseSettings();
    await new Promise((r) => setTimeout(r));
    expect(flushBeforeQuitDone).toHaveBeenCalledTimes(1);
  });

  it('종료 handshake: 설정 IPC 가 reject 해도 ack 는 발화한다 (quit 무한보류 방지)', async () => {
    flushBeforeQuitDone.mockClear();
    vi.mocked(window.electronAPI.settings.set).mockRejectedValueOnce(new Error('EBUSY'));
    useAppStore.getState().updateSettings({ ...useAppStore.getState().settings, theme: 'dark' });

    H.holder.cb!();
    await new Promise((r) => setTimeout(r));

    expect(flushBeforeQuitDone).toHaveBeenCalledTimes(1);
  });

  it('종료 handshake: persist 가 reject 해도 ack 는 발화(quit 무한보류 방지, QA10 C-MED)', async () => {
    flushBeforeQuitDone.mockClear();
    vi.mocked(persistCurrentSession).mockImplementationOnce(() => Promise.reject(new Error('disk full')));
    H.holder.cb!();
    await new Promise((r) => setTimeout(r));
    expect(flushBeforeQuitDone).toHaveBeenCalledTimes(1);
  });
});
