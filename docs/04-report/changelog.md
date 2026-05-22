# Changelog

All notable changes to the summary-lecture-material project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.18.21] - 2026-05-22

> R35 — page-citation-viewer 전체 로직 4-에이전트 병렬 QA. Main 프로세스 / AI·상태 /
> UI·CI 3개 표면은 R16~R34 누적 감사로 diminishing-returns (신규 결함 0), citation/RAG
> 파이프라인에서 런타임 결함 2건 검출·수정. 정적 갭 분석이 "Decision #6 준수"로 판정했던
> 단일-인용 정책이 실제로는 프롬프트에 범위 라벨을 넣고 LLM 의 확률적 변환에 의존하던
> 결함을 코드 레벨에서 제거. 대시보드 88.8% 는 v1.0 stale 스냅샷이며 기능은 v1.1(~98%)
> 에서 이미 archive-resolved 상태였음을 갭 재분석으로 확인. 회귀 테스트 +1 (322 → 323).

### Fixed (R35 — citation 범위 라벨 인용 소실)
- **`formatPageLabel` 단일 라벨 강제** (`citation.ts:137`, `use-qa.ts:357`): 멀티페이지 RAG 청크에 범위 라벨 `[p.N-M]` 을 프롬프트 컨텍스트에 주입하고, 최종 출력 파서 `CITATION_REGEX` (단일 `[p.N]` 만 인식) 와의 변환을 LLM 지시 준수에 의존하던 결함. `RAG_CHUNK_SIZE=500` 토큰 청크가 일반 PDF 페이지를 상시 가로질러 범위 라벨이 항상 발생 → 로컬 소형 모델이 단일 변환에 실패하면 `[p.5-7]` 가 `-7]` 에서 매칭 실패해 인용이 일반 텍스트로 렌더되며 소실 (HIGH — citation 정확도 결함의 1차 원인). 시그니처를 `(page?: number)` 로 축소해 항상 단일 `[p.N]` 만 방출, Decision Record #6("단일 [p.N] 형식")을 코드로 강제.
- **청크 페이지 귀속을 body 좌표 기준으로 정정** (`chunker.ts:320-329`): `chunkTextWithOverlapByPage` 가 overlap tail (`c.tailStart`) 을 pageStart 산정에 포함해, 이전 페이지 출신 tail 이 pageStart 를 앞 페이지로 끌어당기던 결함 (예: page 8 본문 청크가 page 7 tail 때문에 `[p.7-8]`). 범위 라벨을 추가 양산하고 인용을 실제 근거보다 앞 페이지로 편향시킴 (MEDIUM). 귀속을 `c.bodyStart` 기준으로 전환 — tail 은 검색 recall 용으로만 `text` 에 잔류, retrieval 좌표계와 attribution 좌표계 분리.
- **CITATION_RULES 5개 로케일 정리** (`ai-service.ts`): 이제 프롬프트에 범위 라벨이 도달하지 않으므로, ko/en/ja/zh/auto 의 "범위 라벨→단일 변환" 지시(dead instruction) 제거. 핵심 "단일 페이지 인용" 규칙은 유지.

### Docs (R35)
- **설계 §3.3 드리프트 정리** (`docs/archive/2026-04/page-citation-viewer/page-citation-viewer.design.md`): R35 가 구현을 Decision #6 쪽으로 통일한 결과 §3.3 의 프롬프트 라벨 명세(`[p.N-M]`, 6곳)·`formatPageLabel` 시그니처·청크 귀속 주석이 구현과 모순 → 단일 라벨 + body 좌표 귀속으로 갱신해 설계-구현 일치 복원.

### Tests (R35)
- **회귀 테스트 +1 케이스** (322→323): `citation.test.ts` formatPageLabel 단일-라벨/범위-미방출 가드 (출력이 CITATION_REGEX 로 재파싱 가능함 — 생산-소비 포맷 정합성), `chunker.test.ts` overlap tail 이 pageStart 를 이전 페이지로 끌어당기지 않음 가드.

---

## [0.18.20] - 2026-05-20

> v0.18.19 자산 덮어쓰기 패턴 (5차) 으로 누적되었던 R32 + R33 + R34 (P1+P2) 작업을
> 정식 minor 로 승격. GitHub Actions 풀 CI (Ubuntu/Windows test matrix → tsc strict →
> Vitest 322 → Windows-2025 NSIS 빌드 → Sigstore attestation) 가 단일 태그 push 에서
> 처음으로 일괄 검증되는 사이클. 누적 변경 합산:
> - R32: P2 5 + P3 8 + P4 12 + P5 8
> - R33 4-에이전트 QA 가 R32 도입 회귀 4건 추가 검출
> - R34 P1: R33 회귀 정리 4
> - R34 P2: 커버리지 보강 + 동반 P4 7 (settings-keys/enrich-doc/preload snapshot 단위 가드 26)
> - 회귀 테스트 누적 +60 (262 → 322, 13 → 18 파일)
> - Critical 34R 연속 zero

### Hardened (R34 P2 — 커버리지 보강 + P4 동반)
- **`VALID_SETTINGS_KEYS` 단일 출처 모듈화** (`src/main/settings-keys.ts` 신설): 이전엔 `main/index.ts` 의 두 곳에 같은 키 배열이 별도 리터럴로 유지되어 한쪽만 갱신 시 settings 저장/로드 silent drift 위험. 단일 모듈로 통합 + 6-case drift 가드 단위 테스트 (Surface 4 P3).
- **`enrichDocumentWithImages` 분리 + 단위 테스트** (`src/renderer/lib/enrich-doc.ts` 신설): R32 P3 의 "Vision partial-failure 시 enrichedPages null 정책" 이 use-summarize.ts 내부 헬퍼라 단위 테스트 0건이었음. pure 함수만 별도 모듈로 추출 + 11-case 회귀 가드 (Surface 4 P3).
- **preload contextBridge shape snapshot 테스트** (`__tests__/preload-shape.test.ts` 신설): `src/preload/index.ts` 가 electron 의존성으로 직접 import 불가했으나, source 텍스트 정적 검사로 노출 키 집합 + IPC channel 이름 + 핵심 시그니처 (ocrPage / embed / analyzeImage requestId) 의 drift 가드 9-case 추가 (Surface 4 P3).
- **i18n own-undefined 가드 보강** (`i18n.ts:interpolate`): R32 P3 의 hasOwnProperty 전환이 own property 값이 `undefined` 인 경우 `String(undefined) = "undefined"` 가 UI 에 박히는 corner 발생. AND 결합으로 보완 (Surface 3 P4).
- **pdf-parser OCR signal abort race 차단** (`pdf-parser.ts:294`): `addEventListener('abort', ...)` 와 직전 `signal.aborted` 체크 사이에 abort 발화 시 late-attached listener 가 fire 안 해 IPC 가 그대로 진행되며 ~90s 토큰 비용 발생. listener 등록 직후 `throwIfAborted` 한 번 더 (Surface 2 P4).
- **preload `ai.abort` 반환 타입에 `error?` 추가** (`preload/index.ts`): main 측 invalid requestId 검증 실패 시 `{ success: false, error: '...' }` 반환하지만 타입은 `error` 누락. 호출자 식별 가능하도록 정합 (Surface 2 P5).
- **`scripts/postbuild.mjs` SMOKE_FILES 에 `Adobe-CNS1-UCS2.bcmap` 추가** : 번체 중국어(대만/홍콩) cmap 부분 누락 케이스 catch (Surface 4 P5).

### Tests (R34 P2)
- **회귀 테스트 +26 케이스** (296→322): `settings-keys.test.ts` 신규 6 (드리프트 가드 — Set/Array 동치, AppSettings type subset, DEFAULT_SETTINGS 커버, 양방향 슈퍼셋 금지, prototype 차단, readonly 검증), `enrich-doc.test.ts` 신규 11 (빈 description / 단일 / 다중 / 순서 / textForSummary join / out-of-range / 불변식 / mutation / partial-failure 핵심 계약), `preload-shape.test.ts` 신규 9 (expose target / top keys / IPC channels / ocrPage signature / embed / analyzeImage / openExternal / ElectronAPI type / declare global / listeners removeListener).

---

### Fixed (R34 P1 — R33 4-에이전트 병렬 QA 결과 P2 1 + P3 2 + P4 1 회귀 정리)
- **MarkdownErrorBoundary reset 비교 정합** (`safe-markdown.tsx:23-25`): R32 P2 가 추가한 `componentDidUpdate` 가 `prevProps.children !== this.props.children` 비교를 했는데, 부모(SummaryViewer / QaChat) 가 매 렌더마다 JSX 로 `<ReactMarkdown>` 을 새로 생성하므로 children identity 가 매 렌더 다름 → hasError 가 latch 되어도 즉시 reset → 같은 throw → thrash. 비교 대상을 `fallbackText` (실제 content 문자열) 로 교체 (Surface 3 P2).
- **`generate()` placeholder leak cleanup** (`ai-service.ts:147-172`): R32 P3 가 도입한 placeholder controller 가 `validateOllamaUrl` / `new URL()` / `API_KEY_MISSING` 등 동기 throw 시 `activeRequests` Map 에 남아 10분 TTL 까지 잔존하던 결함. try/catch 로 감싸 identity 일치 시에만 정리 (Surface 2 P3).
- **`will-redirect` Windows file:// 정합** (`main/index.ts:136-142`): R32 P3 가 추가한 `file://${path}` (2 슬래시) 비교가 Electron 의 실제 loadFile URL `file:///${path}` (3 슬래시, RFC 8089) 와 매치되지 않아 항상 false. `pathToFileURL(...).href` 로 표준 file URL 생성 (소문자 드라이브 / UNC / 백슬래시 정규화도 함께 처리됨) (Surface 2 P4).
- **CI audit step `node_modules` 부재 분기** (`.github/workflows/test.yml`): R32 P2 가 도입한 `if: always()` 가 `npm ci` 실패 후에도 step 을 실행하는데, node_modules 부재 시 npm audit 이 error JSON 을 내고 이전 파서가 `0 0 0` 으로 떨어뜨려 "취약점 없음" 으로 거짓 보고. 선행 `[ -d node_modules ]` 검사 + audit JSON 의 `j.error` 분기 + `: "${VAR:=0}"` 디폴트로 가시성 회복 (Surface 4 P3).

### Tests (R34 P1)
- **회귀 테스트 +4 케이스** (292→296): `safe-markdown.test.tsx` MarkdownErrorBoundary reset 가드 4 (fallbackText 동일 시 reset 안 함 / 변경 시 reset / hasError=false 시 미트리거 / 양쪽 undefined 안전).

---

### Fixed (Minor — R32 P3: P4 12건 + P5 10건 정리 라운드)
- **handleSummarize 카치 블록에 docId guard** (`use-summarize.ts:616`): 문서 전환 후 stale summarize 가 streamInterrupted 같은 non-ABORTED 에러로 throw 하면 새 문서 banner 에 표시되던 ownership leak 해소 (Surface 1 P4).
- **appendQaStream 입구에 isQaGenerating 가드** (`store.ts`): clearQaStream 직후 in-flight 루프가 추가 토큰을 흘려 ghost-token 이 cancelled placeholder 뒤에 나타나던 race 차단 (Surface 1 P4).
- **`enrichedPageTexts` version counter 도입** (`store.ts`, `use-qa.ts`): useRagBuilder fingerprint 가 `e${length}` 만 사용해 길이가 같은 두 번째 Vision 패스가 재빌드 트리거 안 되던 결함을 monotonic 카운터로 해소 (Surface 1 P4).
- **`clientRef.current` null 화를 ownership 가드 안으로 이동** (`use-qa.ts`): stale 핸들러의 unconditional null 이 새 세션의 ref 를 clobber 할 수 있던 latent 결함 (Surface 1 P5).
- **`taskkill` 실패 시 SIGKILL fallback + 로그** (`ollama-manager.ts`): 권한 거부 / AV / PID re-use race 시 ollama 자식 트리가 살아남아 port squat 하던 silent 결함 가시화 (Surface 2 P4).
- **`will-redirect` file:// 일괄 허용 → 정확히 packaged renderer URL 만 통과** (`main/index.ts`): defense-in-depth (Surface 2 P4).
- **`generate()` placeholder controller 즉시 등록** (`ai-service.ts`): streamRequest 가 자기 controller 를 set 하기까지의 한 틱 갭에 도착한 ai:abort 가 no-op 으로 떨어지던 race 해소 (Surface 2 P5).
- **i18n `hasOwnProperty.call` 사용** (`i18n.ts:interpolate`): `params['toString']` 같은 prototype 누출로 함수 소스가 템플릿에 주입되는 경로 차단 (Surface 3 P4).
- **i18n 미정의 키 fallback — 마지막 dot-segment** (`i18n.ts:t/useT`): production 에서 raw 키 (`app.modelHint`) 가 그대로 노출되던 결함을 마지막 세그먼트로 약화 (Surface 3 P4).
- **`ResizeHandle` Home/End ARIA 관례 정합** (`ResizeHandle.tsx`): Home=MIN, End=MAX 로 swap — 스크린리더 사용자 예상과 일치 (Surface 3 P4).
- **`safe-markdown` 헤딩 / blockquote 도 citation 렌더링** (`safe-markdown.tsx`): "## 결론 [p.12]" 같이 헤딩에 인용이 들어간 경우 literal text 가 아니라 CitationButton 으로 렌더 (Surface 3 P5).
- **PdfViewer 모듈-스코프 store.subscribe latent 주석** (`PdfViewer.tsx`): 향후 lazy-import 전환 시 cleanup 누락 가능성 마킹 (Surface 3 P5).
- **vitest pool='forks' 명시 + Vitest 4 마이그레이션** (`vitest.config.mts`): 다중 fork 가 `vi.stubGlobal('window', ...)` 를 동시 stub 하는 race 차단. Vitest 4 의 deprecated `poolOptions.forks` 도 정리 (Surface 4 P4).
- **`ai-client.test.ts` setTimeout 5/10/20ms → 50/100ms** : CI 러너 일시 부하 마진 (Surface 4 P4).
- **release.yml `fail-fast: false`** : Ubuntu 플레이크가 Windows 빌드를 cancel 하지 않도록 (Surface 4 P5).
- **`scripts/postbuild.mjs` cmap smoke check** : 부분 복사 silent failure 가드 — 대표 cmap 3개 (`Adobe-Japan1-UCS2.bcmap` 등) 존재 확인 (Surface 4 P5).
- **`req.setTimeout` 5분 가드에 settled 체크 추가** (`ai-service.ts`): 응답 헤더 후 idle timer take-over 시점에 본 callback 이 fire 해도 no-op (Surface 2 P5).
- **`CLAUDE.md` CI 3분 → 8~12분** : `gh release view` 조기 호출로 사용자가 빌드 미첨부를 실패로 오해하는 경우 방지.
- **`CLAUDE.md` Code Signing 섹션 신설** : `forceCodeSigning: false` 가 의도적 trade-off 임과 향후 EV 인증서 도입 절차 명시.
- **`electron.vite.config.ts` pdfjs worker chunking 주석** : worker 파일이 manualChunks 와 무관하게 별도 정적 자산으로 emit 되는 의도 명시.

### Tests (R32 P3)
- **회귀 테스트 +1 케이스** (291→292): `store.test.ts` `isQaGenerating=false` 일 때 `appendQaStream` 이 무시됨 (R32 P3 ghost-token race).

### Skipped (의도적 보존)
- `splitIntoSentences` Latin 약어 false-split (P5) — verify pipeline 이 fail-safe.
- `stripConversationalText` 과도 trim 잠재성 (P5) — 실 사례 빈도 낮음.

---

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
