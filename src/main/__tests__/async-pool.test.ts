import { describe, it, expect } from 'vitest';
import { mapWithConcurrency, yieldToEventLoop, SESSION_FANOUT_LIMIT } from '../async-pool';

/**
 * QA29(C-4) 회귀 넷. 전체 검색·의미검색이 저장된 모든 세션을 한 덩어리 `Promise.all` 로 읽고
 * 파싱해 main 을 초 단위로 잡던 것을 캡 + 양보로 바꿨다. 여기서는 그 두 성질을 직접 단언한다:
 * (1) 동시 실행이 캡을 넘지 않는다, (2) 항목 사이에 이벤트 루프가 실제로 돈다.
 */

describe('mapWithConcurrency', () => {
  it('결과는 입력 순서에 정렬된다 (병렬이어도 인덱스 보존)', async () => {
    const items = [10, 20, 30, 40, 50, 60, 70];
    const out = await mapWithConcurrency(items, 3, async (n, i) => `${i}:${n}`);
    expect(out).toEqual(items.map((n, i) => `${i}:${n}`));
  });

  it('동시 실행이 limit 을 넘지 않는다', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    expect(peak, '캡이 없으면 20개가 한 번에 들어와 main 이 그만큼 잡힌다').toBeLessThanOrEqual(4);
    expect(peak, '캡이 1로 붕괴하면 검색이 순차가 된다').toBeGreaterThan(1);
  });

  it('항목 사이에 이벤트 루프가 돈다 (대기 중인 IPC 가 굶지 않는다)', async () => {
    // 팬아웃이 도는 동안 예약된 매크로태스크 — 양보가 없으면 전부 끝난 뒤에야 실행된다.
    let ipcRan = false;
    const started = new Promise<void>((resolve) => {
      setImmediate(() => { ipcRan = true; resolve(); });
    });
    let seenDuring = false;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
      if (n > 2 && ipcRan) seenDuring = true;
      return n;
    });
    await started;
    expect(seenDuring, '양보가 없으면 팬아웃 전체가 끝날 때까지 setImmediate 콜백이 못 돈다').toBe(true);
  });

  it('빈 입력은 즉시 빈 배열', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('limit 이 항목 수보다 크거나 0/음수여도 안전하다', async () => {
    expect(await mapWithConcurrency([1, 2], 99, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapWithConcurrency([1, 2], 0, async (n) => n * 2)).toEqual([2, 4]);
    expect(await mapWithConcurrency([1, 2], -3, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('reject 는 전파된다 (호출부의 per-item try/catch 계약 유지)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('EIO'); return n; }),
    ).rejects.toThrow('EIO');
  });

  it('yieldToEventLoop 는 대기 중인 매크로태스크 뒤에 재개한다', async () => {
    const order: string[] = [];
    setImmediate(() => order.push('other'));
    await yieldToEventLoop();
    order.push('resumed');
    expect(order).toEqual(['other', 'resumed']);
  });

  it('세션 팬아웃 캡은 libuv fs 풀 기본값과 같다', () => {
    expect(SESSION_FANOUT_LIMIT).toBe(4);
  });
});
