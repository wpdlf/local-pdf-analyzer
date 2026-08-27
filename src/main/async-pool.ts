/**
 * main 스레드를 굶기지 않는 팬아웃 헬퍼.
 *
 * QA29(C-4): 전체 검색(`session:search`)과 의미검색(`runSemanticSearch`)은 저장된 **모든** 세션을
 * 하나의 `Promise.all` 로 동시에 읽고 `JSON.parse` 했다. 온디스크 상한이 200MB 인데 캡이 없으니
 * 파싱 스파이크가 그대로 main 에 쌓이고, 매칭 루프까지 동기라 그 사이 다음이 전부 멈춘다:
 *   - 창 닫기 flush handshake(`app:flush-done`, 2s 타임아웃) → 타임아웃으로 착지 = 델타 소실 위험
 *   - electron-updater 이벤트 / 전 IPC 핸들러
 * QA19 가 코사인 동기 루프에 쓴 처방(주기적 yield)을 팬아웃 축에도 적용한다.
 */

/** 동시에 읽는 세션 수. libuv fs 스레드풀 기본값과 같다 — 그 이상은 큐에서 대기할 뿐이다. */
export const SESSION_FANOUT_LIMIT = 4;

/** 이벤트 루프에 제어를 한 바퀴 넘긴다(대기 중인 IPC·타이머·소켓 콜백이 돌 기회). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => { setImmediate(resolve); });
}

/**
 * `items.map(fn)` 과 같은 결과(인덱스 정렬)를 내되 동시 실행을 `limit` 으로 제한하고,
 * 각 워커가 다음 항목을 집기 전에 이벤트 루프에 양보한다.
 *
 * `fn` 이 reject 하면 `Promise.all` 과 동일하게 전파된다 — 호출부는 종전처럼 per-item try/catch 로
 * 격리한다(한 문서의 일시 I/O 오류가 검색 전체를 비우면 안 된다는 기존 계약).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor;
      if (i >= items.length) return;
      cursor += 1;
      out[i] = await fn(items[i]!, i);
      // 남은 일이 있을 때만 양보한다 — 마지막 항목 뒤의 불필요한 tick 제거.
      if (cursor < items.length) await yieldToEventLoop();
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
