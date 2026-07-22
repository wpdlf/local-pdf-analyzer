/**
 * 창 종료 flush 정책 — 순수 결정 로직.
 *
 * QA16→QA17→QA18 세 사이클 연속으로 같은 핸들러(index.ts 의 `win.on('close')` /
 * `flushRenderersBeforeQuit`)에서 실데이터 손실이 나왔다. Electron 의 app/BrowserWindow 에
 * 얽혀 있어 단위 테스트가 0건이었던 것이 재발의 직접 원인이다. 부작용(preventDefault·destroy·
 * IPC send)은 index.ts 에 남기고, **무엇을 할지 결정하는 부분만** 여기로 분리해 회귀 넷을 건다.
 *
 * 불변식:
 *  1. flush 가 진행 중인 창은 네이티브 파괴로부터 보호한다(파괴가 flush 를 끊으면 마지막
 *     델타 = 요약·Q&A·인덱스가 소실).
 *  2. 그러나 종료 경로는 진행 중인 flush 를 **건너뛰지 않고 기다린다**. 건너뛰면 곧바로
 *     app.quit() 이 창을 닫으러 오고, 불변식 1 의 preventDefault 가 종료 자체를 취소한다.
 *     darwin 은 window-all-closed 가 app.quit() 을 재시도하지 않으므로 창 없는 좀비가 되고,
 *     isQuitting 이 true 로 고착돼 이후 창의 X 닫기가 flush 를 통째로 우회한다(QA18 B-MED).
 *  3. 한 창당 flush 는 1회만(창닫기 인터셉트와 before-quit 경로의 이중 flush 방지, QA16).
 */

/** `win.on('close')` 에서 취할 동작. */
export type CloseAction =
  /** 이미 파괴된 창 — 아무것도 하지 않는다. */
  | 'noop'
  /** flush 진행 중 — close 를 가로채 무시한다. 완주 후 소유자가 파괴한다. */
  | 'intercept-wait'
  /** flush 를 새로 시작하고, 완주 후 파괴한다. */
  | 'intercept-flush'
  /** 그대로 닫히게 둔다(종료 경로가 이미 flush 를 소유했거나 완료됨). */
  | 'allow';

export interface CloseState {
  isDestroyed: boolean;
  /** flush 가 지금 진행 중인가(flushingWindows). */
  isFlushing: boolean;
  /** flush 가 개시된 적 있는가(flushedWindows — 완료·파괴 후에도 유지). */
  hasFlushed: boolean;
  /** before-quit 이 종료 시퀀스를 시작했는가. */
  isQuitting: boolean;
}

export function decideCloseAction(s: CloseState): CloseAction {
  if (s.isDestroyed) return 'noop';
  // 불변식 1 — isQuitting 여부와 무관하게 진행 중인 flush 를 보호한다. 종료 경로가 이
  // flush 를 await 하므로(selectFlushTargets) 종료가 영구 취소되지 않는다.
  if (s.isFlushing) return 'intercept-wait';
  if (s.isQuitting || s.hasFlushed) return 'allow';
  return 'intercept-flush';
}

export interface FlushCandidate {
  isDestroyed: boolean;
  isFlushing: boolean;
  hasFlushed: boolean;
}

/** `flushRenderersBeforeQuit` 에서 창별로 취할 동작. */
export type FlushTarget =
  /** 대상 아님(파괴됨 / 이미 flush 완료). */
  | 'skip'
  /** 진행 중인 flush 의 promise 를 기다린다 — 불변식 2. */
  | 'await-inflight'
  /** 새로 flush 를 시작한다. */
  | 'start';

export function selectFlushTargets(wins: readonly FlushCandidate[]): FlushTarget[] {
  return wins.map((w) => {
    if (w.isDestroyed) return 'skip';
    // 진행 중인 flush 를 'skip' 으로 처리하면 QA18 B-MED(종료 취소 → darwin 좀비) 가 재발한다.
    if (w.isFlushing) return 'await-inflight';
    if (w.hasFlushed) return 'skip';
    return 'start';
  });
}
