import { describe, it, expect } from 'vitest';
import { decideCloseAction, selectFlushTargets } from '../window-flush-policy';

// QA16→QA17→QA18 세 사이클 연속으로 창 종료 flush 결정 로직에서 실데이터 손실이 나왔고,
// 그때마다 원인은 "이 판단에 단위 테스트가 없다"는 것이었다. 부작용에서 분리된 결정 로직에
// 회귀 넷을 건다.

describe('decideCloseAction — win.on(close) 결정', () => {
  const base = { isDestroyed: false, isFlushing: false, hasFlushed: false, isQuitting: false };

  it('평시 창 X 닫기 → flush 를 가로채 시작', () => {
    expect(decideCloseAction(base)).toBe('intercept-flush');
  });

  it('이미 파괴된 창 → noop', () => {
    expect(decideCloseAction({ ...base, isDestroyed: true })).toBe('noop');
  });

  // QA17(A-MED): 창 X 빠른 이중 클릭 — 두 번째 close 가 진행 중 flush 를 끊으면 마지막 델타 소실.
  it('flush 진행 중 재진입(이중 클릭) → 가로채 무시', () => {
    expect(decideCloseAction({ ...base, isFlushing: true })).toBe('intercept-wait');
  });

  // QA18(B-MED, v0.31.28 회귀): 종료 중이라고 해서 진행 중인 flush 를 끊으면 안 된다. 대신
  // 종료 경로가 그 flush 를 await 한다(selectFlushTargets 의 await-inflight).
  it('종료 중(isQuitting)이어도 flush 진행 중이면 여전히 보호한다', () => {
    expect(decideCloseAction({ ...base, isFlushing: true, isQuitting: true })).toBe('intercept-wait');
    // hasFlushed 까지 겹쳐도 진행 중 보호가 우선한다.
    expect(decideCloseAction({ ...base, isFlushing: true, hasFlushed: true, isQuitting: true }))
      .toBe('intercept-wait');
  });

  it('종료 경로가 flush 를 이미 소유/완료 → 그대로 닫히게 둔다(이중 flush 방지)', () => {
    expect(decideCloseAction({ ...base, isQuitting: true })).toBe('allow');
    expect(decideCloseAction({ ...base, hasFlushed: true })).toBe('allow');
  });
});

describe('selectFlushTargets — flushRenderersBeforeQuit 대상 선정', () => {
  it('평범한 창 → 새 flush 시작', () => {
    expect(selectFlushTargets([{ isDestroyed: false, isFlushing: false, hasFlushed: false }]))
      .toEqual(['start']);
  });

  it('파괴된 창 / 이미 flush 완료된 창 → skip', () => {
    expect(selectFlushTargets([
      { isDestroyed: true, isFlushing: false, hasFlushed: false },
      { isDestroyed: false, isFlushing: false, hasFlushed: true },
    ])).toEqual(['skip', 'skip']);
  });

  // QA18(B-MED) 핵심 회귀: v0.31.28 은 진행 중인 flush 를 'skip'(필터링) 했다 → 종료 경로가
  // 즉시 resolve → app.quit() 이 창을 닫으러 옴 → close 의 intercept-wait 이 종료를 취소 →
  // darwin 은 window-all-closed 가 app.quit() 을 하지 않아 창 없는 좀비 + isQuitting 고착 →
  // 이후 새 창의 X 닫기가 flush 를 우회(QA16 이 고친 데이터손실 부활).
  it('진행 중인 flush 는 건너뛰지 않고 기다린다', () => {
    expect(selectFlushTargets([{ isDestroyed: false, isFlushing: true, hasFlushed: true }]))
      .toEqual(['await-inflight']);
  });

  it('혼재 상황에서 창별로 독립 판정', () => {
    expect(selectFlushTargets([
      { isDestroyed: false, isFlushing: true, hasFlushed: true },   // 창 X 인터셉트 진행 중
      { isDestroyed: false, isFlushing: false, hasFlushed: false }, // 아직 손 안 댄 창
      { isDestroyed: true, isFlushing: false, hasFlushed: false },  // 이미 파괴
    ])).toEqual(['await-inflight', 'start', 'skip']);
  });

  it('빈 목록 → 빈 결과', () => {
    expect(selectFlushTargets([])).toEqual([]);
  });
});
