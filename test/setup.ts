// R29 #1 (v0.18.11): vitest 전역 setup 파일.
// 현재는 모든 테스트가 자체 `vi.stubGlobal('window', ...)` 셋업을 가지므로 여기서는
// 공통 안전망만 깐다. happy-dom/jsdom 환경 전환(R30) 시 본 파일에서 `window.electronAPI`
// 기본 mock 을 제공하도록 확장 예정.
//
// 의도적으로 거의 비어 있다: 기존 테스트 동작에 영향 주지 않으면서 후속 라운드에서
// 한 곳에서 stub 을 중앙화할 수 있는 진입점만 마련.

import { afterEach, vi } from 'vitest';

// pdfjs-dist 6.x main 빌드(`build/pdf.mjs`)는 모듈 로드 시점에 `new DOMMatrix()` 를
// 모듈 스코프 상수로 평가한다(브라우저 전역 가정). 앱 런타임은 Chromium 렌더러라 항상
// 존재하지만, vitest 의 기본 node 환경에는 DOMMatrix 가 없어 pdf-parser 를 (전이적으로라도)
// import 하는 테스트가 import 단계에서 ReferenceError 로 죽는다. 파서 로직 테스트는 pdfjs 를
// 전량 mock 하므로 실제 행렬 연산엔 도달하지 않는다 → 모듈 로드를 통과시킬 최소 스텁이면 충분.
// (legacy 빌드로 전환하면 프로덕션 번들이 불필요하게 구형/대형이 되므로 테스트 환경만 보강.)
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === 'undefined') {
  class DOMMatrixStub {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    constructor(_init?: unknown) { /* no-op */ }
    multiply() { return this; }
    multiplySelf() { return this; }
    translate() { return this; }
    scale() { return this; }
    transformPoint(p?: unknown) { return p; }
  }
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix = DOMMatrixStub;
}

// R29 (v0.18.13): `restoreAllMocks` → `clearAllMocks` 로 교체.
// restoreAllMocks 는 vi.spyOn 으로 만든 spy 의 원본 구현까지 되돌려 file 레벨 module
// mock 과 collision 을 일으킬 수 있다 (특히 vi.stubGlobal 이 모듈 hoist 와 상호작용
// 하는 경우 후속 test 가 stale 한 상태로 시작). clearAllMocks 는 call state 만
// 비우고 구현/return value 는 보존 → 기존 테스트 동작 보존 + 누적 state 격리.
afterEach(() => {
  vi.clearAllMocks();
});
