// R29 #1 (v0.18.11): vitest 전역 setup 파일.
// 현재는 모든 테스트가 자체 `vi.stubGlobal('window', ...)` 셋업을 가지므로 여기서는
// 공통 안전망만 깐다. happy-dom/jsdom 환경 전환(R30) 시 본 파일에서 `window.electronAPI`
// 기본 mock 을 제공하도록 확장 예정.
//
// 의도적으로 거의 비어 있다: 기존 테스트 동작에 영향 주지 않으면서 후속 라운드에서
// 한 곳에서 stub 을 중앙화할 수 있는 진입점만 마련.

import { afterEach, vi } from 'vitest';

// 각 테스트 사이에 stub/mock 상태가 누적되지 않도록 자동 정리.
// 개별 테스트가 `vi.clearAllMocks()` 를 호출하더라도 멱등하므로 안전.
afterEach(() => {
  vi.restoreAllMocks();
});
