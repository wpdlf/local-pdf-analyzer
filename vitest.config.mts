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
//   happy-dom 은 devDependencies 에 정확 핀(`//testingPinPolicy` 참고, 현재 20.10.6) 유지 — 제거 금지.
//   향후 컴포넌트 테스트 추가 시 동일 file pragma 패턴 사용.

export default defineConfig({
  test: {
    // 전역 environment 는 node 유지(기본값). DOM 필요 파일만 file pragma 로 happy-dom 선언 — 위 R37 P4-1 정책 참고.
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
      //   3) 단위 테스트 없는 영역: src/preload/**
      //      — 0% coverage 가 분모를 비현실적으로 만들어 미래 임계 게이트를 방해하므로
      //      "아직 측정하지 않는" 영역으로 명시. 각 영역에 테스트가 도입되면 라인 제거.
      //      (src/renderer/components/** 는 16종 전수 행위 테스트 도입으로 분모 편입 — 아래 측정 주석 참고)
      //   R38 P1: 기존 `src/main/**` 통째 제외를 해제하고, "실질적으로" 단위 테스트된 순수
      //      모듈(ipc-validators / ollama-pull-progress / ps-quote / settings-store /
      //      settings-keys)을 분모에 포함시킨다. config 주석의 "테스트 도입 시 라인 제거" 절차 실행.
      //      개별 제외로 남기는 것:
      //        - index.ts            : R38 P2 에서 electron 모킹으로 핸들러 행위는 검증됨
      //                                (ipc-handlers.test). 다만 createWindow / ai:generate /
      //                                vision(analyze-image·ocr) 등 UI·생성 경로가 통합 성격이라
      //                                전체 39% 수준 → 분모 포함 시 branch 마진이 -5pp 정책 미달.
      //                                % 게이트에서는 제외하되 회귀는 행위 테스트가 가드한다.
      //   R38 P4: ollama-manager.ts 도 분모에 포함. P3(생명주기) + P4(downloadFile·
      //      verifyInstallerSignature·start health-retry) 로 큰 부분이 커버되어 전체 ~55% →
      //      포함 시 오히려 베이스라인이 상승(드래그 아님). install* 오케스트레이션·computeFileHash·
      //      getOllamaPath(win32) 만 미커버로 남는다. → exclude 라인 제거(절차대로).
      //   R38 P5: ai-service.ts 도 분모에 포함. 순수 헬퍼(buildPrompt/splitPrompt/detectMimeType/
      //      sanitize*) export + checkAvailability/generateEmbeddings/analyzeImage/generate(streamRequest)
      //      를 http 모킹으로 검증 → ~68% 커버. 포함 시 베이스라인 상승(드래그 아님). 잔여 미커버는
      //      일부 프롬프트 템플릿 조합·streamRequest 의 idle/size-cap 분기 정도.
      //      이제 src/main 에서 % 게이트 제외로 남는 것은 index.ts(P2 행위검증, UI/생성 경로 ~39%) 뿐.
      //   C5-I1(QA cycle5): Vitest 4 는 coverage.include 미설정 시 "테스트가 import 한 파일만"
      //      분모에 포함한다(≤3 의 `coverage.all` 전-파일 의미론 제거). 그 결과 테스트 없는 신규
      //      소스 파일이 분모에서 조용히 사라져 임계 게이트가 영구히 감지 못 했다(실측: App.tsx
      //      594줄이 lcov 에 부재). include 를 명시해 "제외는 아래 exclude 목록으로만, 명시적으로"
      //      라는 본 파일의 정책을 Vitest 4 의미론에서 복원한다.
      include: ['src/**'],
      exclude: [
        'node_modules/**', 'out/**', 'dist/**', 'test/**', 'scripts/**',
        '**/*.config.*', '**/*.d.ts', '**/__tests__/**',
        // C5-I1: 커버리지 산출물 자체 — include 도입 검증 중 src/ 하위에 우발 생성된 과거
        // lcov-report(js 125줄, 0%)가 분모를 8pp 끌어내리는 것을 실측. 재발 방어로 명시 제외.
        '**/coverage/**',
        'src/main/index.ts',
        // C5-I1: 렌더러 엔트리(마운트 1줄 성격) — 측정 무의미, 명시 제외.
        'src/renderer/main.tsx',
        // C5-I1: App.tsx 는 앱 셸(레이아웃 오케스트레이션 + 전역 이벤트 배선) 통합 성격으로
        // src/main/index.ts 와 동일 사유의 % 게이트 제외. E2E 스모크(app-launch/upload-errors)가
        // 기동·배선 회귀를 가드한다. 단위 행위 테스트 도입 시 본 라인 제거(절차대로).
        'src/renderer/App.tsx',
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
      // R38 P4: ollama-manager.ts(downloadFile·verifyInstallerSignature·start retry) 분모 포함으로
      //   베이스라인 상승.
      //   측정: Stmts 55.2 / Branch 50.39 / Funcs 55.85 / Lines 56.67 (-5pp 마진 적용).
      // R38 P5: ai-service.ts 본체(순수 헬퍼 + 네트워크 경로) 분모 편입으로 베이스라인 상승.
      //   측정: Stmts 57.49 / Branch 51.24 / Funcs 57.53 / Lines 59.32 (-5pp 마진 적용).
      //   잔여 미답(index.ts UI/생성 경로 / install* 오케스트레이션 / E2E) 도입 시 본 임계 재상향 권장.
      // R43: Gemini 네트워크 경로(SSE/safety block/400 매핑/임베딩 분할/Vision) + 로캘 감지 +
      //   위자드 에러·재시도 테스트 추가로 베이스라인 상승.
      //   측정: Stmts 60.91 / Branch 54.88 / Funcs 61.32 / Lines 63.17 (-5pp 마진 적용).
      // R44: useRagBuilder 훅 회귀 가드 + SettingsPanel 취소 흐름 + pullCancelled +
      //   i18n 정적 스캔 drift 가드 추가로 베이스라인 상승.
      //   측정: Stmts 62.54 / Branch 56.2 / Funcs 63.65 / Lines 64.79 (-5pp 마진 적용).
      // 컴포넌트 전수 테스트: 무테스트였던 렌더러 컴포넌트 8종(TabBar/SummaryTypeSelector/
      //   StatusBar/ProgressBar/RecentDocuments/SummaryViewer/QaChat/PdfUploader) + ResizeHandle/
      //   SettingsPanel 본체/PdfViewer 까지 도입해 src/renderer/components/** 분모 편입.
      //   components 폴더 자체가 79/74/81/83% 로 전체 평균을 상회 → 편입이 베이스라인을 끌어올림(드래그 아님).
      //   측정: Stmts 72.1 / Branch 66.11 / Funcs 73.53 / Lines 74.84 (-5pp 마진 적용).
      //   잔여 미커버: PdfViewer 의 canvas 렌더 경로(happy-dom 한계, E2E 영역) / SettingsPanel 일부 분기.
      // use-summarize 오케스트레이션: 5.91% 에 머물던 요약 훅(useSummarize/summarizeFull/
      //   summarizeByChapter/analyzeDocumentImages)을 renderHook 으로 구동해 가드/가용성/전체·챕터·
      //   다청크 통합·PDF_NO_TEXT·후처리·이미지 preflight·abort 경로 커버 → use-summarize.ts 82% 라인.
      //   측정: Stmts 76.78 / Branch 69.83 / Funcs 76.94 / Lines 79.77 (-5pp 마진 적용).
      //   잔여 미커버: use-summarize 의 timeout/중간 취소 race 분기, pdf-parser·safe-markdown·
      //   use-session 등 renderer/lib 일부, ollama-manager install 오케스트레이션.
      // app-error-boundary(0%→100%) + safe-markdown 렌더 경로(41%→100%): AppErrorBoundary 폴백/
      //   reset/reload/메시지 절단 + MarkdownErrorBoundary.render + renderWithCitations(p/li/em/strong/
      //   h*/td/th/blockquote) 인용 주입을 실제 렌더로 가드.
      //   측정: Stmts 77.74 / Branch 70.74 / Funcs 79.29 / Lines 80.88 (-5pp 마진 적용).
      //   잔여 미커버: pdf-parser(pdfjs 의존)·use-session 일부, ollama-manager install 오케스트레이션, E2E.
      // use-session: useSessionPersistence 훅(디바운스 자동저장 게이트, 미테스트)과 restore 미커버
      //   분기(load catch / checkEmbedModel 불가·throw / blob-without-embedModel)를 renderHook+fake timer
      //   로 보강 → use-session.ts 43%→98%(라인 100%).
      //   측정: Stmts 78.37 / Branch 71.3 / Funcs 80.68 / Lines 81.3 (-5pp 마진 적용).
      //   잔여 미커버: pdf-parser(pdfjs 의존), ollama-manager install 오케스트레이션, src/preload, E2E.
      // pdf-parser: handlePdfData 오케스트레이션(가드/성공/에러 매핑) + parsePdf pageCount 가드 +
      //   OCR fallback(OCR_FAIL) + cancelPdfParse 를 pdfjs/worker/use-session 목으로 보강
      //   → pdf-parser.ts 43%→70%(라인 74%). 잔여는 renderPageToImage/imageDataToBase64 의 실제
      //   canvas 변환 경로(happy-dom 한계, E2E 영역).
      //   측정: Stmts 80.33 / Branch 72.86 / Funcs 81.53 / Lines 83.54 (-5pp 마진 적용).
      // ollama-manager install 오케스트레이션: installWindows/installMac/_installInternal/computeFileHash
      //   행위 테스트(execFile 콜백 시뮬레이션 + Start-Process RunAs 인자 단언 + macOS path traversal
      //   보안 분기 가드) → ollama-manager.ts ~55%→88/69/88/90.
      //   측정: Stmts 82.71 / Branch 74.46 / Funcs 83.99 / Lines 86.12 (-5pp 마진 적용).
      // src/preload 분모 편입: preload/index.ts 의 contextBridge 노출 래퍼를 electron 모킹으로 실제
      //   구동(invoke 채널/인자 전달, openExternal https 가드, getPathForFile webUtils/throw fallback,
      //   on* 리스너 포워딩+구독해제) → preload/index.ts 100%(59/59·6/6·46/46·52/52). 정적 surface
      //   drift 가드(preload-shape.test)는 상보적으로 유지. exclude 에서 src/preload/** 제거(절차대로).
      //   100% 영역이라 분모 편입이 베이스라인을 끌어올림(드래그 아님).
      //   측정: Stmts 82.92 / Branch 74.51 / Funcs 84.74 / Lines 86.29 (-5pp 마진 적용).
      // C5-I1/L(QA cycle5): 임계 재정렬 — QA 사이클 3~5 테스트 보강으로 베이스라인이 상승했는데
      //   게이트가 6~8pp 뒤처져(-5pp 정책 위반) 약 3pp 어치 회귀가 무감지 통과 가능했다.
      //   측정(include 명시 + 사이클5 테스트 반영): Stmts 85.46 / Branch 77.58 / Funcs 85.95 /
      //   Lines 88.69 (-5pp 마진 적용).
      // QA13(D-MED): 사이클 6~13 테스트 보강(session-store·api-keys·use-session flush·SettingsPanel
      //   템플릿·pdf-parser 암호화/BOM·Gemini 403·analyzeImage 등)으로 베이스라인이 재상승했는데
      //   게이트가 cycle5(80/72/80/83)에 고정돼 다시 6~7pp 뒤처져(-5pp 정책 위반) 약 2pp 회귀가
      //   무감지 통과 가능했다. 정책대로 재정렬.
      //   측정: Stmts 86.41 / Branch 78.52 / Funcs 86.53 / Lines 89.86 (-5pp 마진 적용 → 아래).
      thresholds: {
        statements: 81,
        branches: 73,
        functions: 81,
        lines: 84,
      },
    },
  },
});
