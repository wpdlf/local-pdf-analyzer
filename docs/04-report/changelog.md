# Changelog

All notable changes to the summary-lecture-material project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.18.19 patch] - 2026-05-20

> v0.18.19 릴리즈 자산 덮어쓰기. 버전 번호 미상승 — 이미 배포된 v0.18.19 가
> R32 P1+P2 누적 적용된 빌드로 교체된다. (과거 v0.18.18 patch 와 동일 패턴)

### Fixed (Medium — R32 P2: 4-에이전트 병렬 QA P3 8건)
- **Vision partial-failure stale enrichment 해소** (`use-summarize.ts:529`): 이미지 분석이 켜진 채로 모든 이미지가 실패해 `enrichedPagesRef` 가 null 인 경우, 이전 run 에서 세팅된 `enrichedPageTexts` 가 store 에 남아 RAG 가 stale enriched 데이터로 검색하던 결함. 명시적 null 세팅으로 raw `pageTexts` 재빌드를 강제 (Surface 1 P3).
- **테마 라이브 preview localStorage drift 차단** (`theme.ts:applyTheme`, `SettingsPanel.tsx:97-99`): `applyTheme` 가 매 호출마다 `localStorage.setItem('theme', ...)` 를 동기 호출하여 SettingsPanel 라디오만 만져보고 X(창 닫기) 로 종료한 경우 dirty preview 값이 영구 저장되어 settings.json 과 drift 가 발생. `applyTheme(theme, { persist?: boolean })` 시그니처로 persist 분리, SettingsPanel 은 `persist:false` 로 호출. 본 저장 경로(App.tsx 의 settings 구독 effect) 만 localStorage 갱신 (Surface 3 P3).
- **MarkdownErrorBoundary children 변경 시 reset** (`safe-markdown.tsx:9-22`): 스트리밍 중 일시적 마크다운 파싱 오류(예: 미완 `[bracket`) 한 번으로 `hasError=true` 가 latch 되어 후속 토큰으로 완성된 답변까지 raw-text fallback 모드가 유지되던 결함. `componentDidUpdate` 에서 `prevProps.children !== this.props.children` 면 `hasError` 를 reset 하여 자연스러운 재시도 가능 (Surface 3 P3).
- **OCR 클라우드 피크 메모리 캡** (`pdf-parser.ts:251`): 클라우드 `BATCH_SIZE=8` + 3000×3000 캔버스(~36MB RGBA each) 가 50–100 페이지 PDF (`scale=1.5`) 에서 피크 ~250–300MB 일시 점유로 저사양 노트북(4GB RAM) OOM 위험. 50–100p 구간만 BATCH_SIZE=4 로 축소 (Surface 2 P3).
- **`streamRequest` MAX_LINE_SIZE silent skip 차단** (`ai-service.ts:434`): 1MB 초과 라인을 `continue` 로 건너뛰면 손상된 응답이 빈 답변으로 "성공" 보고되어 사용자가 빈 화면만 보던 결함. `safeReject` 로 명시 중단하여 ai-client 가 `streamInterrupted` 로 변환해 사용자에게 표시 (Surface 2 P3).
- **lockfile drift gate `packages[""]` 까지 검사** (`.github/workflows/test.yml`, `release.yml`): lockfileVersion 3 은 root `version` 과 `packages[""].version` 두 곳에 버전이 박혀 있는데, 게이트는 root 만 검사하여 hand-edit 으로 둘이 어긋나면 `npm ci` 가 cache 키 무효화 + 경고를 발생시키는 채로 CI 그린이었음. 두 곳 모두 검증 (Surface 4 P3).
- **`audit` JSON 3× 재파싱 통합** (`.github/workflows/test.yml:64`): 동일 audit JSON 을 3개 node 호출로 재파싱했고 `set +e` 와 결합돼 한 호출이 빈 문자열 반환 시 `[ "" -gt 0 ]` 가 silent 산식 오류를 일으키던 fragility. `read HIGH MODERATE LOW <<<` 로 단일 spawn 으로 묶음 (Surface 4 P3).
- **PowerShell quote escape 헬퍼 추출 + 단위 테스트** (`main/ps-quote.ts` 신설, `ollama-manager.ts` 두 호출처 정합): R15 H1 / R28 P2 가 발생했던 영역인데도 escape 로직에 unit test 0건이었음. `ollama-manager.ts` 는 electron 을 import 하여 vitest 에서 직접 import 불가능 → 헬퍼만 native 의존성 없는 별도 모듈로 분리하여 9 케이스 회귀 테스트 (Surface 4 P3).

### Tests (R32 P2)
- **회귀 테스트 +18 케이스** (273→291): `ollama-psquote.test.ts` 신규 9 (ASCII/공백/single-quote escape/연속 quote/CJK/wildcard 보존/빈 문자열/백슬래시/혼합), `theme.test.ts` 신규 7 (persist 기본/true/false/멱등/cleanup/dark add/light remove), `store.test.ts` enrichedPageTexts 멱등 2.

---

### Fixed (High — R32 P1: 4-에이전트 병렬 QA P2 5건)
- **Q&A cross-session 토큰 contamination 차단** (`store.ts:resetSummaryState`): 문서 전환 시 `setDocument()` → `resetSummaryState()` 가 store 플래그만 비우고 main 의 in-flight AiClient generator 는 토큰을 계속 yield 하여, 사용자가 새 문서로 빠르게 질문하면 stale 세션 토큰이 새 세션의 `qaStream`/`appendQaStream` 에 인터리브되던 race. `resetSummaryState` 가 in-flight `qaRequestId`/`currentRequestId` 모두에 `ai.abort` 를 직접 전파하여 root cause 차단 (Surface 1 P2).
- **프롬프트 인젝션 — summary + assistant history 추가 방어** (`use-qa.ts:666, 139`): `sanitizePromptInput` 이 사용자 질문/refine 질문/RAG 청크에만 적용되고 `[요약 내용]` 의 summary text 와 `formatHistory` 의 assistant 분기는 sanitize 되지 않아, 악성 PDF 가 LLM 을 유도해 답변/요약에 `\n[질문]\n` / `\n---\n` 마커를 포함시키면 후속 턴 프롬프트 구조가 오염되던 indirect prompt injection. 양쪽 모두 sanitize 통과 (Surface 1 P2).
- **PDF parse 오류 banner 경로 누출 차단** (`store.ts:setError`, `error-sanitize.ts` 신설): `AppErrorBoundary` 의 `sanitizeErrorPath` 는 render-time exception 채널만 커버해, App.tsx drop/Ctrl+O, PdfUploader 에서 `setError({ message: err.message })` 로 직접 banner 에 들어가는 경로는 pdfjs/main 의 절대경로를 그대로 노출했음. `setError` 자체에 `sanitizeErrorPath` 를 자동 적용하여 미래 호출자도 자동 커버. `sanitizeErrorPath` 는 `error-sanitize.ts` 로 추출하여 store 가 React 트리를 끌어들이지 않도록 분리 (Surface 3 P2).
- **OCR 클라우드 abort 미전파 복구** (`main/index.ts:ai:ocr-page`, `ai-service.ts:analyzeImageForOcr`, `preload/index.ts:ocrPage`, `pdf-parser.ts:ocrFallback`): R30 P2 가 `ai:analyze-image` 만 고치고 OCR 경로는 누락되어, 클라우드 OCR `BATCH_SIZE=8` 에서 사용자 Stop 클릭이 다음 배치만 차단하고 in-flight 8건 (~90s/call) 의 토큰 청구는 끝까지 진행되던 결함. preload `ocrPage(base64, requestId?)` 시그니처 확장, main `ai:ocr-page` 핸들러를 `ai:analyze-image` 동일 패턴(`vision:` prefix namespacing, registerEmbedRequest) 으로 정합, `analyzeImageForOcr` 가 `AbortSignal` 수용하도록 시그니처 확장, pdf-parser 가 per-page requestId 발급 + `signal.addEventListener('abort', ...)` 로 abort 시 즉시 `ai.abort` 전파 (Surface 2 P2).
- **CI audit step 가시성 — red CI 에서도 노출** (`.github/workflows/test.yml:53`): 이전엔 `npm test` 실패 시 후속 audit step 이 통째로 skip 되어 supply-chain 신호가 `GITHUB_STEP_SUMMARY` 에서 사라졌음. red CI 상황에서 advisory 가 가장 봐야 하는데 가려지던 결함. `if: always()` 추가하여 test 실패와 독립적으로 항상 출력. step 자체는 여전히 `continue-on-error: true` 로 non-blocking (Surface 4 P2).

### Tests
- **회귀 테스트 +11 케이스** (262→273): `store.test.ts` resetSummaryState abort propagation 6 (qa/sum 각각, 양쪽, 둘다 null, reset 후 store 비움, IPC reject silent catch) + setError sanitize 5 (Win 홈/Linux 홈/Win 일반 드라이브/null/일반 메시지 보존). `qa-verify.test.ts` formatHistory assistant 분기 sanitize 2 (`[질문]` 마커, `---` 구분자).

### QA Process
- 32라운드 병렬 4-agent QA (AI/RAG core / main+PDF / UI / Build·CI·Tests) 결과 P2 5건 식별 — Critical 32R 연속 zero 유지. P3 8건, P4 12건, P5 10건은 다음 minor 라운드로 분리.
- 273/273 pass.

---

## [0.18.3] - 2026-04-21

### Fixed (High)
- **refine 경로의 question sanitize 누락 복구** (`use-qa.ts:635`): v0.18.0 도입된 2-pass Q&A 중 draft 분기는 `sanitizePromptInput(trimmed)` 을 거치지만 refine 분기는 raw question 을 `buildRefinePrompt` 에 전달해, `---` / `[질문]` / `[이전 대화]` 마커가 포함된 질문이 프롬프트 구조를 오염시킬 수 있었다. 두 분기 모두 동일한 sanitize 파이프라인 통과하도록 정합.

### Fixed (Medium)
- **`needsRefine` 임계 완화** (`use-qa.ts:389`): 기존 `weakCount >= 1` 규칙이 boilerplate 한 문장만으로도 두 번째 LLM 호출을 강제해 대부분의 답변에 지연+비용 증가를 유발. 새 규칙 `weakCount >= 2 || weakRatio > 0.2 || avgScore < VERIFY_AVG_SCORE` 로 단일 약문장은 허용하되 실제 hallucination 시그널(복수 약문장/20% 초과/평균 하락)에서만 refine 트리거.
- **verified-draft 경로 dead code 제거** (`use-qa.ts:644`): React 가 동기 setState 를 batch 하므로 직후 `clearQaStream()` 에 의해 절대 렌더되지 않던 `appendQaStream(draft)` 를 삭제. 최종 답변은 공통 경로의 `addQaMessage(normalized)` 로 일원화.
- **Ollama 다운로드 타임아웃 시 WriteStream 미해제** (`ollama-manager.ts:389-392`): `req.setTimeout` 핸들러에서 200 분기 내부 지역변수 `file` 에 접근 불가 → `response.on('close')` 전파에만 의존하던 FD 해제 경로를 `currentFile` outer-scope 참조로 명시적 `file.destroy()` 호출. 10분 타임아웃 히트 시 FD leak 가능성 차단.

### Tests
- **qa-verify.test.ts +7 케이스** (124→131): buildRefinePrompt sanitize regression 1 + `sanitizePromptInput` 단위 4 + `verifyAnswerSentences` 임계 regression 2. v0.18 주요 회귀 포인트를 정적으로 방어.

### QA Process
- 22라운드 병렬 4-agent QA (AI/RAG core / main+PDF / UI layer / Security) 기반으로 High 1 + Medium 3 + 테스트 공백 선별 수정. UI/Security 레이어는 findings zero 로 maintenance mode 재확인.
- 전체 131/131 pass, 보안 점수 97/100 유지.

---

## [0.18.2] - 2026-04-21

### Security (P3 Low — 2건)
- **`ai:generate` requestId 길이 캡 추가** (`main/index.ts:519`): 형제 IPC 핸들러(`ai:abort` 256자, `ai:embed` 128자)와 drift 되어있던 제한을 ≤256 으로 정합. 렌더러 손상 시 과대한 requestId 가 activeRequests Map 키로 저장되며 매 토큰마다 echo 되던 자기-DoS 벡터 차단.
- **`sanitizePromptInput` whitespace padding 우회 강화** (`use-qa.ts:33-41`): `^---$` 등 regex 를 `^\s*---\s*$` 로 확장. `" ---"` / `"[질문] "` 같은 앞뒤 공백 padding 으로 이스케이프를 우회하던 엣지 케이스 차단.

### Tests
- **qa-core.test.ts 신규** (31 케이스): sanitizePromptInput 11 + extractKeywords 10 + selectRelevantChunks 10. 3 함수 export 추가. **124/124 pass** (기존 93 + 신규 31).

### QA Process
- 3라운드 병렬 4-agent QA (code-analyzer R20 / security-architect R21 / gap-detector / qa-test-planner) 후 새 P3 Low 2건 식별·수정.
- 20회 연속 Critical/High/Medium zero 유지, 97/100.

---

## [0.18.1] - 2026-04-20

### Fixed (Critical)
- **enableAnswerVerification 설정 영구 저장**: `src/main/index.ts` 의 defaultSettings + VALID_SETTINGS_KEYS_SET + VALID_SETTINGS_KEYS + switch validator 네 군데에 신규 키 누락 → 토글 OFF 후 재시작 시 TRUE 로 복원되던 문제. v0.18.0 대표 기능의 persistence 파기를 복구.

### Fixed (High)
- **verifyAnswerSentences abort signal 미연결**: `use-qa.ts` 의 2-pass verify 경로가 AbortController signal 을 전달하지 않아 사용자가 "멈춤" 을 눌러도 OpenAI 배치 임베딩이 최대 120s 진행되며 과금되던 회귀(v0.17.12 abort 인프라와 미연결). `verifyAbortRef` 를 도입해 handleQaAbort 에서 즉시 파괴.

### Tests
- **qa-verify.test.ts 신규** (11 케이스): splitIntoSentences / buildRefinePrompt / verifyAnswerSentences (RAG empty / embed fail / weak / strong / pre-aborted signal). 93/93 pass.

### Docs
- changelog v0.11~v0.18 backfill, page-citation-viewer Analysis 재평가(88.8% → ~98%) + `docs/archive/2026-04/` 이관.

---

## [0.11.0 – 0.18.0] - 2026-04-01 ~ 2026-04-20 (Consolidated Backfill)

> v0.10.1 이후 changelog 갱신이 누락되어 2026-04-20 에 커밋 이력 기반으로 backfill. 세부 QA 라운드 내역은 `git log` 참조. 핵심 릴리즈만 발췌.

### [0.18.0] - 2026-04-20 — Q&A 답변 자동 검증
- **Hallucination 감지 + silent refine**: Q&A 답변을 문장 단위로 쪼개 RAG 인덱스와 cosine 유사도 대조. weak 문장 ≥1 또는 평균 점수 < 0.65 이면 refine 프롬프트로 한 번 더 호출해 사용자에게는 최종 답변만 표시.
- **2-pass Orchestration**: Draft 수집(스트림 숨김, `qaVerifying=true` 스피너) → verify → flush 또는 refine 스트리밍.
- **Fail-safe**: RAG 비활성/임베딩 실패/빈 draft 시 needsRefine=false 로 기존 단일-pass 경로로 수렴.

### [0.17.0 – 0.17.12] — page-citation-viewer + QA Hardening
- **v0.17.0 page-citation-viewer**: 요약/답변의 `[p.N]` 인용 → 클릭 시 우측 PDF 뷰어 해당 페이지 이동. `citation.ts` 신규 + `chunkTextWithOverlapByPage` + pdfjs 직접 사용.
- **v0.17.1~0.17.2**: DR-01 가로 리사이즈 핸들(`ResizeHandle.tsx` + `citationPanelWidth` localStorage), citation 품질 개선.
- **v0.17.3~0.17.6**: 병렬 QA (M1~M4) + DR-04 설계 sync + cachedDoc 누수 해소.
- **v0.17.7 Security**: Ollama 인스톨러 Authenticode 검증 + Electron 보안 하드닝.
- **v0.17.8**: Mac (.dmg) 빌드 CI 추가, artifactName 플랫폼별 분리.
- **v0.17.9~0.17.12 QA Rounds**: 병렬 QA P1 3건 → R2 H1/H2/M1 → R3 RAG enrichment + length assertion → R4 embed abort (registerEmbedRequest) + Vision 토글 일관성.

### [0.15.0 – 0.16.2] — 안정성 · UX · 다국어
- **v0.15.0**: 안정성 + UX + 다국어 일관성 대규모 개선.
- **v0.16.0**: 11라운드 병렬 QA 40건 수정.
- **v0.16.1**: 12~15차 QA 14건 + file:open-pdf dialog try/catch + AppErrorBoundary + i18n store error.
- **v0.16.2**: 3라운드 병렬 QA (Critical 2 + High 16 + Medium 22 + 회귀 10).

### [0.11.0 – 0.14.x] — i18n + pdf-qa
- UI 다국어(한국어/English), 셋업 위자드 임베딩 모델 구분, pdf-qa feature (9 QA 사이클), ASCII/Mermaid 다이어그램 왕복.

---

## [0.10.1] - 2026-03-31

### Security (Critical)
- **QaChat XSS Vulnerability Fix**: Extracted safe Markdown rendering to shared `safe-markdown.tsx` module. Applied to both SummaryViewer and QaChat components to eliminate XSS risk.
- **macOS Zip Path Traversal Fix**: Added `unzip -l` validation before extraction to prevent directory traversal attacks.
- **Process Cleanup on healthCheck Failure**: Added `process.stop()` in ollama-manager.ts healthCheck failure path to prevent orphaned processes.

### Fixed (QA Hardening - 18 Total Issues)
- **use-qa.ts Abort Race Condition**: Added `abortedRef` guard to prevent duplicate `addQaMessage` calls on abort.
- **ai-service.ts Event Loop Blocking**: Added `unref()` to TTL interval to prevent timer from keeping event loop alive.
- **window-all-closed Cleanup**: Added `cleanupAiService()` safety net in main process.
- **pdf-parser.ts Image Race Condition**: Added batch-level `skipImages` flag for thread-safe image handling.
- **ArrayBuffer Copy Optimization**: Added zero-offset check to eliminate redundant memcpy operations.
- **store.ts HMR Ghost Token**: Added `import.meta.hot.dispose()` handler to clear auth token on hot reload.
- **use-qa.ts useCallback Deps**: Added explanatory comment documenting intentional empty dependency array.
- **SummaryViewer.tsx Debounce Cleanup**: Separated unmount cleanup into independent useEffect.
- **use-summarize.ts Return Type**: Fixed return type annotation `string → string | null`.
- **use-qa.ts Finally Order**: Reordered finally block to flush QA stream before clearing.
- **store.ts Error Code**: Corrected error code `EXPORT_FAIL → SETTINGS_SAVE_FAIL`.
- **SettingsPanel.tsx IPC Error Handling**: Added try/catch to init IPC calls and handleRestartOllama.
- **ollama-manager.ts Promise Double-Resolve**: Implemented `settled/safeResolve` pattern to prevent race conditions.
- **SettingsPanel.tsx API Key Operations**: Added try/catch with user feedback for API key save/delete operations.
- **Removed Dead Code**: Removed unused `signal` parameter from `ai-service.ts` httpPost function.

### Performance
- **IPC Progress Reporting**: Optimized TTL interval cleanup with unref() to reduce idle wake-ups.
- **Stream Buffer**: Confirmed array-based buffer (O(n)) prevents string concatenation O(n²) regression.
- **Zustand Selectors**: Verified 16 selector calls use single-value accessors for re-render optimization.

### QA Process
- **4-Round Verification**: 3 rounds of fixes (Round 1: 9 fixes, Round 2: 6 fixes, Round 3: 3 fixes) + 1 verification round (0 new issues found).
- **Match Rate Improvement**: Design Match Rate 94.1% → 96.2% (+2.1pp).
- **Quality Score Improvement**: 82/100 → 94/100 (+12 points).
- **Build Status**: ✅ PASS (npm run build)
- **Test Status**: ✅ 19/19 PASS (vitest)

### Architecture
- **New Module**: `src/renderer/lib/safe-markdown.tsx` — shared XSS-safe Markdown rendering component
- **Updated Files**: 16 files modified across main, preload, and renderer layers
- **No Breaking Changes**: All v0.10.0 features maintained at 100% compatibility

### Verified
- **Design Match Rate**: 94.1% → 96.2% ✅
- **Security Issues**: 0 Critical (was 4) ✅
- **Stability Issues**: 0 Important (was 14) ✅
- **Test Coverage**: 19/19 PASS ✅
- **Build**: electron-vite build success ✅

---

## [0.10.0] - 2026-03-20

### Added
- **PDF Q&A Chat Feature**: Interactive question-answering on uploaded PDFs with streaming responses
- **Streaming Response Support**: Real-time token streaming from Ollama/Claude/OpenAI via IPC
- **Korean Language Detection**: Auto-detect Korean PDFs and switch to Korean-optimized models
- **Vision Image Analysis**: Extract and analyze images from PDFs using Claude Vision API
- **Safe Markdown Rendering**: react-markdown with sanitization support for Q&A responses
- **Chat History UI**: Conversational interface with user questions and AI responses displayed in markdown

### Fixed
- **PDF Q&A Chat Integration**: Full integration of question submission, streaming response, and state management
- **Image Extraction**: PDF.js CMap configuration for proper Korean font handling
- **Streaming Context**: Maintain conversation context across multiple Q&A exchanges

### Verified
- **Match Rate**: 94.1% (maintained from v0.9.2)
- **Test Status**: All tests passing
- **Build**: electron-vite build success

---

## [0.5.0] - 2026-03-20

### Security (Critical)
- **SSRF 방어**: `ollamaBaseUrl` 호스트를 localhost/127.0.0.1/::1로 제한 (`validateOllamaUrl()`)
- **macOS Command Injection 수정**: `exec` → `execFile`로 교체, unzip/open 명령 분리
- **요약 중 닫기 시 AI 요청 중단**: `currentRequestId` + `ai:abort` IPC로 백그라운드 실행 방지
- **요약 중 설정 변경 차단**: 설정 버튼 `disabled` 처리 (`isGenerating || isParsing`)

### Fixed
- **`win.isDestroyed()` 체크**: 스트리밍 종료 시 윈도우 닫힌 상태에서 크래시 방지
- **`activeRequests` 정리**: HTTP 4xx 에러 시 Map에서 즉시 삭제
- **에러 닫기 버튼**: 에러 메시지 영역에 X 버튼 추가 (`setError(null)`)
- **"다른 파일" 상태 초기화**: document + summaryStream + summary + progress 모두 초기화
- **설정값 타입 검증**: provider, theme, maxChunkSize 등 값 타입/범위 서버 측 검증

### Changed
- **Ollama Setup 탈출 경로**: 설치 실패 시 "다른 AI Provider 사용" 버튼 추가 → 설정 패널 이동
- **Dead code 삭제**: `ai-provider.ts` (미사용) 제거

### Verified
- **Match Rate**: 100% (12/12)
- **테스트**: 23/23 통과
- **빌드**: electron-vite build 성공

---

## [0.4.1] - 2026-03-19

### Added
- **PDF 파싱 로딩 화면**: 파일 업로드/드롭 후 스피너 + "PDF를 읽고 있습니다..." 메시지 표시
- **요약 생성 로딩 화면**: 첫 토큰 도착 전 스피너 + "AI가 강의자료를 분석하고 있습니다..." 메시지 표시
- **`isParsing` 상태**: store에 PDF 파싱 진행 상태 추가

### Changed
- **SummaryViewer**: 생성 중 "PDF를 업로드하고 요약을 시작하세요." 안내 문구 제거, 로딩 화면으로 대체
- **PdfUploader**: 파싱 중 클릭/드롭 이벤트 비활성화 (중복 파싱 방지)

### Verified
- **Design Match Rate**: 96.5% (loading-ux)
- **테스트**: 23/23 통과
- **빌드**: electron-vite build 성공

---

## [0.4.0] - 2026-03-19

### Security (Critical)
- **AI API를 Main 프로세스로 이전**: Claude/OpenAI API 호출이 Renderer에서 Main으로 이동하여 API 키가 DevTools에 노출되지 않음
- **`apikey:get` → `apikey:has`**: Renderer에 복호화된 API 키 대신 boolean만 반환
- **AppSettings에서 API 키 필드 제거**: `claudeApiKey`/`openaiApiKey`가 Zustand store와 settings.json에 저장되지 않음
- **`anthropic-dangerous-direct-browser-access` 헤더 제거**: Main 프로세스에서 표준 헤더만 사용

### Fixed (Bugs / Memory Leaks)
- **IPC 리스너 cleanup**: `onFileDropped`, `onSetupProgress`의 useEffect에서 unsubscribe 반환
- **setTimeout cleanup**: SettingsPanel/OllamaSetupWizard의 모든 타이머를 useEffect 기반으로 전환
- **요약 중단 지원**: `ai:abort` IPC 추가로 진행 중인 AI 요청 중단 가능
- **file:// URL 파싱**: 수동 replace → `fileURLToPath()` Node.js 표준 API

### Performance
- **appendStream O(n²) → O(1)**: 배열 복사+join 대신 문자열 직접 연결, `_streamBuffer` 제거
- **ReactMarkdown debounce**: 스트리밍 중 150ms 간격 업데이트, 완료 시 즉시 반영
- **PDF 배치 병렬 처리**: BATCH_SIZE=10으로 `Promise.all` 적용 (수백 페이지 속도 향상)
- **Claude isAvailable() 최적화**: 실제 API 호출 대신 키 존재 여부만 확인 (과금 방지)

### Accessibility
- **ProgressBar**: `role="progressbar"`, `aria-valuenow/min/max`, `aria-label` 추가
- **SummaryViewer**: 내보내기/복사 버튼에 `aria-label` 추가

### Added
- **`src/main/ai-service.ts`**: Main 프로세스 AI 서비스 (공통 스트리밍 유틸리티, 프롬프트 빌더)
- **IPC 채널**: `ai:generate`, `ai:abort`, `ai:check-available`, `ai:token`, `ai:done`

### Changed
- **ai-client.ts**: Provider 직접 호출 → IPC AsyncGenerator 기반으로 전면 재작성
- **ai-provider.ts**: Claude/OpenAI Provider 클래스 제거 (Main으로 이전), 인터페이스만 유지
- **preload/index.ts**: `ai.*` 브릿지 추가, `apiKey.get` → `apiKey.has` 변경

### Verified
- **QA Match Rate**: 72/100 → 93.75% (15/16 이슈 수정, 1건 Accepted Risk)
- **테스트**: 23/23 통과 (ai-client.test.ts IPC 모킹 기반 재작성)
- **빌드**: electron-vite build 성공 (main/preload/renderer)

---

## [0.2] - 2026-03-17

### Added
- **Vitest** unit testing framework (^4.1.0)
- **prompts.test.ts**: 4 unit tests for prompt generation (full, chapter, keyword summaries)
- **chunker.test.ts**: 6 unit tests for text chunking logic (heading, page, token-based)
- **ProgressBar.tsx**: Separate component for progress visualization
- **Error Code Usage**: All 10 error codes now actively used in error handling
  - `OLLAMA_NOT_FOUND`, `OLLAMA_INSTALL_FAIL`, `MODEL_NOT_FOUND`, `MODEL_PULL_FAIL` in OllamaSetupWizard
  - `EXPORT_FAIL` in SummaryViewer
  - `GENERATE_TIMEOUT` in App
- **Provider Selection UI**: Dropdown in SettingsPanel for switching between providers (ollama/claude/openai)
- **Duration Metrics**: Summary.durationMs calculation based on Date.now()
- **AppError Type**: Explicit error code type system (AppErrorCode union type)
- **IPC_CHANNELS**: Constant object for Electron IPC channel names
- **DEFAULT_SETTINGS**: Default application settings constant
- **OllamaManager.getStatus()**: Unified status retrieval method
- **OllamaManager.getVersion()**: Version query method
- **AiClient.isAvailable()**: Provider availability check
- **AiClient.listModels()**: Model list retrieval

### Changed
- **ProgressBar**: Extracted from SummaryViewer into standalone component
- **SettingsPanel**: Added Provider selector dropdown (ollama/claude/openai)
- **AiProvider type**: Renamed to `AiProviderType` to avoid naming conflict with interface
- **install() method**: Signature adjusted (onProgress callback removed, return type changed)
- **pullModel() method**: Signature adjusted (onProgress callback removed, return type changed)

### Fixed
- ProgressBar component separation improved reusability
- Error code coverage: 40% → 100% (10/10 codes now utilized)
- Test coverage initialization: 0% → 50% (10 tests added)

### Verified
- **Design Match Rate**: 81.7% (v0.1) → 92.3% (v0.2) ✅
  - Components: 87.5% → 100%
  - Error Codes: 40% → 100%
  - Tests: 0% → 50%
  - File Structure: 94.4% → 100%
  - Dependencies: 92.9% → 100%
- **Architecture Compliance**: 100% (Clean Architecture maintained)
- **Convention Compliance**: 95% (Naming, import order, file organization)
- **Build Status**: ✅ electron-vite build successful

### Known Issues / Remaining Work
- Integration tests not implemented (Ollama connectivity, file export)
- E2E tests not implemented (full workflow automation)
- OllamaManager.initialize() not refactored into single method
- install/pullModel progress reporting via IPC not implemented
- Final integration summary step for large PDFs not implemented
- safeStorage API key encryption pending (awaiting API support)
- Theme toggle button in header not implemented

---

## [0.1] - 2026-03-17

### Added
- **PDCA Planning Phase**: Feature planning document with 12 functional requirements (FR-01 ~ FR-12)
- **PDCA Design Phase**: Technical design document with architecture, components, data model
- **PDCA Do Phase**: Complete implementation of 22 files
  - Electron main process (OllamaManager, IPC bridge)
  - React renderer (8 UI components, 6 utilities, Zustand store)
  - Type definitions and configuration
- **PDCA Check Phase**: Gap analysis comparing design vs implementation (81.7% match rate)

### Core Features Implemented
- **PDF Upload**: Drag-and-drop and file selection
- **Text Extraction**: pdfjs-dist based PDF parsing
- **AI Summarization**: Ollama local LLM integration with streaming
- **Summary Types**: Full, chapter-based, keyword extraction
- **Markdown Rendering**: react-markdown with GFM support
- **File Export**: .md and .txt file saving
- **Settings Panel**: Model and URL configuration, theme selection
- **Ollama Management**: Auto-install, process start/stop, health check
- **Error Handling**: 10 error codes defined (partial usage in v0.1)
- **UI Components**: PdfUploader, SummaryViewer, SettingsPanel, OllamaSetupWizard, StatusBar, etc.

### Architecture Decisions
- **Framework**: Electron + electron-vite for desktop development
- **UI**: React 19 + TypeScript + Tailwind CSS
- **PDF Parsing**: pdfjs-dist for text extraction
- **AI Provider**: Ollama (local LLM) with abstraction for future API support
- **State Management**: Zustand for lightweight global state
- **Build Tool**: electron-vite for fast development and production builds

### Security Baseline
- Electron: contextIsolation enabled, nodeIntegration disabled
- IPC: Preload bridge for safe main/renderer communication
- Ollama: localhost-only communication

### Testing Infrastructure
- Vitest configured (added in v0.2)
- Test files structure prepared

### Initial Quality Metrics
- Match Rate: 81.7% (85/104 items matched)
- Architecture Compliance: 95%
- Convention Compliance: 90%
- Build Status: ✅ Success

---

## Project Information

| Item | Value |
|------|-------|
| **Project Name** | summary-lecture-material |
| **Feature** | pdf-lecture-summary (PDF 대학교 강의자료 요약) + PDF Q&A Chat |
| **Project Level** | Starter |
| **Start Date** | 2026-03-17 |
| **Current Version** | 0.10.1 |
| **Last PDCA Cycle** | #4 (v0.10.0→v0.10.1 QA Hardening) |
| **Status** | PDCA Cycle Completed ✅ |

---

## References

- **PDCA Documents**: `docs/01-plan/`, `docs/02-design/`, `docs/03-analysis/`, `docs/04-report/`
- **Implementation**: `src/main/`, `src/renderer/`, `src/preload/`
- **Tests**: `src/renderer/lib/__tests__/`
- **Configuration**: `package.json`, `electron.vite.config.ts`, `tsconfig.json`

---

**Last Updated**: 2026-03-31
**Maintainer**: jjw
**Latest PDCA Cycle**: #4 (v0.10.0→v0.10.1 QA Hardening)
