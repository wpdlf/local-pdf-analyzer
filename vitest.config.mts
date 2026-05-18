import { defineConfig } from 'vitest/config';

// R29 #1 (v0.18.11): 명시적 Vitest 설정 도입.
// 이전에는 별도 vitest.config 가 없어 모든 테스트가 기본값으로 실행되었고, DOM 이 필요한
// 케이스마다 각 파일에서 `vi.stubGlobal('window', { electronAPI: ... })` 식으로 반복했다.
// 이 파일은 그런 보일러플레이트를 점진적으로 모으기 위한 단일 진입점이다.
//
// 현재는 환경(`environment`)을 변경하지 않고 setupFiles 만 활성화한다 — 기존 246 개
// 테스트가 `vi.stubGlobal('window', ...)` 패턴으로 자체 셋업을 가지므로 happy-dom 같은
// 실제 DOM 환경으로 전환하면 stub 충돌 위험이 있다. happy-dom/jsdom 이동은 R30 후보.
//
// happy-dom 으로 전환하려면:
//   1) `npm install --save-dev happy-dom`
//   2) 아래 environment 옵션 활성화
//   3) `vi.stubGlobal('window', ...)` 패턴을 `Object.assign(window, ...)` 또는
//      `vi.stubGlobal('electronAPI', ...)` (`window.electronAPI` 직접 접근) 로 마이그레이션

export default defineConfig({
  test: {
    // environment: 'happy-dom',  // ← R30 에서 활성화 예정 (위 마이그레이션 노트 참고)
    setupFiles: ['./test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // 회귀 안정성을 위해 alphanumeric 순서로 고정 — 테스트 파일 추가 순서에 의존하는
    // 우발적 통과를 줄인다.
    sequence: { shuffle: false },
  },
});
