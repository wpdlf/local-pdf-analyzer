import { defineConfig } from 'vitest/config';

// R29 #1 (v0.18.11): 명시적 Vitest 설정 도입.
// 이전에는 별도 vitest.config 가 없어 모든 테스트가 기본값으로 실행되었고, DOM 이 필요한
// 케이스마다 각 파일에서 `vi.stubGlobal('window', { electronAPI: ... })` 식으로 반복했다.
// 이 파일은 그런 보일러플레이트를 점진적으로 모으기 위한 단일 진입점이다.
//
// R37 P4-1 (v0.18.23) — happy-dom 정책 확정:
//   기본 환경은 node 유지. DOM 이 실제로 필요한 파일은 **file pragma** 로 happy-dom 을 선언한다
//   (예: `src/renderer/components/__tests__/CitationButton.test.tsx` 상단 `// @vitest-environment happy-dom`).
//   이 분리는 의도된 최적 — happy-dom 을 전역으로 켜면 379 개 비-DOM 테스트의
//   `vi.stubGlobal('window', { electronAPI: ... })` 패턴이 실제 window 와 충돌하고, 끄면 컴포넌트
//   레벨 회귀(R31~R35 citation 등) 가드가 불가능하다. 둘의 장점만 취하는 file-pragma 패턴이
//   v0.18.22 Top5 #4 (CitationButton.test.tsx) 도입 이후 안정화됨.
//   happy-dom 은 devDependencies 에 정확 핀(20.9.0, `//testingPinPolicy` 참고) 유지 — 제거 금지.
//   향후 컴포넌트 테스트 추가 시 동일 file pragma 패턴 사용.

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
      //   3) 단위 테스트 없는 영역: src/preload/**, src/renderer/components/**
      //      — 0% coverage 가 분모를 비현실적으로 만들어 미래 임계 게이트를 방해하므로
      //      "아직 측정하지 않는" 영역으로 명시. 각 영역에 테스트가 도입되면 라인 제거.
      //   R38 P1: 기존 `src/main/**` 통째 제외를 해제하고, "실질적으로" 단위 테스트된 순수
      //      모듈(ipc-validators / ollama-pull-progress / ps-quote / settings-store /
      //      settings-keys)을 분모에 포함시킨다. config 주석의 "테스트 도입 시 라인 제거" 절차 실행.
      //      개별 제외로 남기는 것:
      //        - index.ts            : R38 P2 에서 electron 모킹으로 핸들러 행위는 검증됨
      //                                (ipc-handlers.test). 다만 createWindow / ai:generate /
      //                                vision(analyze-image·ocr) 등 UI·생성 경로가 통합 성격이라
      //                                전체 39% 수준 → 분모 포함 시 branch 마진이 -5pp 정책 미달.
      //                                % 게이트에서는 제외하되 회귀는 행위 테스트가 가드한다.
      //        - ollama-manager.ts   : R38 P3 에서 network/process 생명주기(listModels·healthCheck·
      //                                isInstalled·getStatus·pullModel·stop) 행위는 검증됨
      //                                (ollama-manager.test). 다만 downloadFile·verifyInstallerSignature·
      //                                install* 가 통합/타이머 성격으로 미커버(전체 ~50%) → 분모 포함 시
      //                                line 마진이 -5pp 정책 미달. % 게이트 제외, 회귀는 행위 테스트가 가드.
      //        - ai-service.ts       : 테스트는 있으나 activeRequests 표면만(~10%) — 본체(HTTP 스트리밍/
      //                                provider 어댑터)는 통합 성격이라 후속 라운드까지 분모 제외.
      //                                포함 시 1491줄 대부분 미커버로 게이트가 비현실적이 됨.
      exclude: [
        'node_modules/**', 'out/**', 'dist/**', 'test/**', 'scripts/**',
        '**/*.config.*', '**/*.d.ts', '**/__tests__/**',
        'src/main/index.ts', 'src/main/ollama-manager.ts', 'src/main/ai-service.ts',
        'src/preload/**', 'src/renderer/components/**',
      ],
      // R37 P4-2 (v0.18.23): 후퇴 방지 게이트 도입.
      // 각 지표에서 -5pp 마진을 빼고 게이트 — 우발적 회귀(테스트 누락, 함수 추가 시 미커버)는
      // 잡되 자연적 변동(use-summarize/use-qa 등 부분 측정 함수의 chunk 출입)은 흡수.
      // R37 P5-2 (v0.18.23): CI 통합 완료 — test.yml 의 `coverage` 잡이 `npm run test:coverage`
      // 로 본 thresholds 를 매 PR/push 에서 강제한다 (이전엔 수동 실행 시에만 적용).
      // R37 P6 (v0.18.23): QA M3~M6 테스트 보강으로 베이스라인 상승 → 게이트 동시 상향.
      //   측정: Stmts 49.85 / Branch 45.56 / Funcs 49.81 / Lines 51.63 (-5pp 마진 적용).
      // R38 P1: ipc-validators 추출 + 행위 테스트 + src/main 순수 모듈 분모 포함으로 베이스라인 상승.
      //   측정: Stmts 52.55 / Branch 50.18 / Funcs 52.48 / Lines 54.28 (-5pp 마진 적용).
      // R38 P1-2: api-keys-store 추출(safeStorage 주입) + 행위 테스트(prototype pollution/원자적
      //   쓰기/keychain throw) 로 베이스라인 추가 상승.
      //   측정: Stmts 53.67 / Branch 50.63 / Funcs 53.79 / Lines 55.43 (-5pp 마진 적용).
      //   추가 보강(P2 electron-mock 핸들러 / P3 ollama-manager 통합) 시 본 임계 재상향 권장.
      thresholds: {
        statements: 48,
        branches: 45,
        functions: 48,
        lines: 50,
      },
    },
  },
});
