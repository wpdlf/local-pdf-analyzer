// R29 #1 (v0.18.11): vitest 전역 setup 파일.
// 현재는 모든 테스트가 자체 `vi.stubGlobal('window', ...)` 셋업을 가지므로 여기서는
// 공통 안전망만 깐다. happy-dom/jsdom 환경 전환(R30) 시 본 파일에서 `window.electronAPI`
// 기본 mock 을 제공하도록 확장 예정.
//
// 의도적으로 거의 비어 있다: 기존 테스트 동작에 영향 주지 않으면서 후속 라운드에서
// 한 곳에서 stub 을 중앙화할 수 있는 진입점만 마련.

import { afterEach, vi } from 'vitest';

// R29 (v0.18.13): `restoreAllMocks` → `clearAllMocks` 로 교체.
// restoreAllMocks 는 vi.spyOn 으로 만든 spy 의 원본 구현까지 되돌려 file 레벨 module
// mock 과 collision 을 일으킬 수 있다 (특히 vi.stubGlobal 이 모듈 hoist 와 상호작용
// 하는 경우 후속 test 가 stale 한 상태로 시작). clearAllMocks 는 call state 만
// 비우고 구현/return value 는 보존 → 기존 테스트 동작 보존 + 누적 state 격리.
afterEach(() => {
  vi.clearAllMocks();
});
