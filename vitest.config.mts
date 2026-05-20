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
    // 명시적 exclude — out/ 의 빌드 산출물에 source map 잔여물이 있어도 잡히지 않도록.
    exclude: ['node_modules/**', 'out/**', 'dist/**'],
    // 회귀 안정성을 위해 alphanumeric 순서로 고정 — 테스트 파일 추가 순서에 의존하는
    // 우발적 통과를 줄인다.
    sequence: { shuffle: false },
    // v0.18.19 patch R32 P3: pool 명시적 pinning. 다수의 테스트 파일이 모듈 init 시점에
    // `vi.stubGlobal('window', { electronAPI: ... })` 를 호출하는데, default worker pool 의
    // 다중 fork 가 happy-dom 미도입 환경에서 같은 global 을 동시 stub 할 때 race 위험이 있다.
    // `pool: 'forks'` 고정 + 파일 격리 보장으로 향후 환경 변경 시 stub 충돌 차단 (Surface 4 P4).
    // Vitest 4 에서 poolOptions 가 top-level 옵션으로 변경되어 별도 forks 옵션은 두지 않음
    // (default 가 file-level 격리 + 병렬).
    pool: 'forks',
    // R30 P2 (v0.18.18): coverage 설정 도입.
    // 현재는 임계치를 강제하지 않고 (사용자가 `npm run test:coverage` 직접 호출 시에만 동작),
    // 향후 CI 통합 + 임계 게이트 도입 대비 베이스라인. 비측정 영역을 명시적으로 exclude 해
    // 의미 있는 비율이 나오도록 한다.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // R31 (v0.18.18 patch): exclude 정책 명확화.
      //   1) 표준 인프라/빌드 산출물: node_modules, out, dist, test, scripts, *.config, *.d.ts
      //   2) 테스트 파일 자체: **/__tests__/** — coverage 의 분모에서 테스트 코드를 제외
      //      (테스트 파일은 측정 대상이 아니라 측정 수단)
      //   3) 단위 테스트 없는 영역: src/main/**, src/preload/**, src/renderer/components/**
      //      — 0% coverage 가 분모를 비현실적으로 만들어 미래 임계 게이트를 방해하므로
      //      "아직 측정하지 않는" 영역으로 명시. 각 영역에 테스트가 도입되면 라인 제거.
      exclude: [
        'node_modules/**', 'out/**', 'dist/**', 'test/**', 'scripts/**',
        '**/*.config.*', '**/*.d.ts', '**/__tests__/**',
        'src/main/**', 'src/preload/**', 'src/renderer/components/**',
      ],
    },
  },
});
