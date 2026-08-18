// @vitest-environment happy-dom

/**
 * QA25(B-LOW): prefetchMarkdownRenderer 가 **실제로 청크를 당겨오는지** 관측한다.
 *
 * safe-markdown-lazy.test 의 기존 단언은 `expect(prefetchMarkdownRenderer()).toBeUndefined()`
 * 였는데, 이 함수는 아무 것도 반환하지 않으므로 **본문을 통째로 비워도 통과**한다. 프리페치가
 * 죽으면 재오픈 첫 화면에 Suspense 폴백(원문 plain text)이 한 프레임 노출되는 회귀가 조용히
 * 되살아난다 — 이 함수가 존재하는 유일한 이유가 그것이다.
 *
 * 모듈 로드를 관측하려면 대상 모듈을 스파이해야 하는데, 그 mock 은 파일 전역에 걸리므로
 * (같은 파일의 다른 테스트가 실제 렌더러를 쓰는 것을 방해한다) 별도 파일로 분리한다.
 */

import { describe, it, expect, vi } from 'vitest';

const loaded = vi.hoisted(() => ({ count: 0 }));

vi.mock('../markdown-renderer', async (importOriginal) => {
  loaded.count += 1;
  return await importOriginal<typeof import('../markdown-renderer')>();
});

import { prefetchMarkdownRenderer } from '../safe-markdown';

describe('prefetchMarkdownRenderer (QA25)', () => {
  // ⚠️ 두 성질을 **한 테스트 안에서** 검증한다. ESM 모듈은 한 번만 평가되므로 "로드가
  // 일어났다" 는 최초 1회만 관측 가능하고, 이를 별도 테스트로 쪼개면 실행 순서에 의존하게
  // 된다(셔플 실행에서 실제로 빨개졌다 — 이 저장소가 야간 셔플 잡을 두는 이유가 이것이다).
  it('청크를 실제로 로드하며, 중복 호출해도 한 번만 평가된다', async () => {
    expect(loaded.count).toBe(0); // 아직 아무도 import 하지 않았다

    prefetchMarkdownRenderer();
    // 동적 import 는 마이크로태스크 이후 해소된다.
    await vi.waitFor(() => expect(loaded.count).toBe(1), { timeout: 5000 });

    // import 캐시 — 몇 번을 더 불러도 모듈 평가는 늘지 않는다.
    prefetchMarkdownRenderer();
    prefetchMarkdownRenderer();
    await new Promise((r) => setTimeout(r, 20));
    expect(loaded.count).toBe(1);
  });
});
