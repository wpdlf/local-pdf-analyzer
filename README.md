🌐 **한국어** | [English](README.en.md)

# 📄 로컬 AI PDF 분석기 (Local AI PDF Analyzer)

**개인 PC에서 직접 실행되는 로컬 AI 기반 PDF 요약 도구입니다.**

기존 AI 요약 서비스는 PDF를 외부 서버에 업로드해야 하지만, 이 앱은 **AI가 내 컴퓨터 안에서 실행**됩니다.

- **완전한 오프라인 동작** — Ollama 로컬 AI 엔진이 PC에서 직접 실행되어, PDF 파일이 외부 서버로 전송되지 않습니다
- **텍스트 + 이미지 통합 분석** — 논문, 보고서, 매뉴얼 등 어떤 PDF든 텍스트는 물론 차트, 다이어그램, 표 등 삽입 이미지까지 Vision AI로 분석합니다
- **스캔 PDF OCR 지원** — 이미지 기반 스캔 PDF도 Vision AI가 페이지별로 텍스트를 인식하여 분석합니다
- **RAG 기반 Q&A 채팅** — 임베딩 벡터 시맨틱 검색으로 PDF에서 질문과 가장 관련 높은 부분을 정확히 찾아 AI가 답변합니다
- **답변 자동 검증 (v0.18.0 신규)** — Q&A 답변의 각 문장을 PDF 임베딩에 대조하여 환각이 의심되는 문장이 일정 비율을 넘으면 LLM 이 한 번 더 다듬어서 출력 — 사용자 개입 없이 silent 로 동작합니다
- **페이지 인용 + 사이드 PDF 뷰어 (v0.17.0 신규)** — 요약/Q&A 답변에 자동으로 `[p.12]` 같은 출처 페이지 인용이 붙고, 클릭하면 우측 패널에 PDF 원문이 열려 해당 페이지로 즉시 이동 — AI 환각 여부를 1-click으로 검증
- **세션 자동 저장·복원 (v0.18.27 신규)** — 분석한 PDF를 다시 열면 요약·Q&A 대화·검색 인덱스가 그대로 복원됩니다. 같은 내용이면 재요약·재임베딩 없이 즉시 — 특히 클라우드 임베딩의 토큰 재과금이 사라집니다. 최근 문서 목록에서 바로 이어서 작업할 수 있고, 설정에서 끄거나 전체 비울 수 있습니다
- **개인 자료 걱정 없이 사용** — 시험자료, 사내 문서, 논문 초고 등 민감한 자료도 안심하고 요약할 수 있습니다
- **한국어/English UI** — 설정에서 앱 인터페이스 언어를 한국어 또는 영어로 전환할 수 있습니다
- **유료 AI 전환 가능** — 더 높은 품질이 필요하면 Claude, OpenAI API로 간편하게 전환할 수 있습니다

---

## 다운로드 및 설치

> **[최신 버전 다운로드](https://github.com/wpdlf/local-pdf-analyzer/releases/latest)**

| 플랫폼 | 파일 |
|---|---|
| **Windows** | `Local-PDF-Analyzer-Setup-x.x.x.exe` |
| **macOS** | _v0.18.9 부터 일시 제외_ (코드사인/공증 자격 추가 후 복원 예정) |

1. 위 링크에서 Windows 설치 파일을 다운로드합니다
2. 다운로드한 파일을 실행하여 설치합니다
3. 바탕화면 바로가기 또는 시작 메뉴에서 앱을 실행합니다
4. 첫 실행 시 AI 엔진(Ollama)과 한국어 특화 모델(gemma3, exaone3.5) + RAG 임베딩 모델(nomic-embed-text)이 자동 설치됩니다 — 안내를 따라 진행해주세요

<a id="smartscreen"></a>
> **Windows SmartScreen 안내**: EV 코드서명 인증서 미도입으로, 첫 설치 시 **"Windows의 PC 보호"** / **"알 수 없는 게시자"** SmartScreen 경고가 표시될 수 있습니다. 정상 동작이며, **추가 정보(More info) → 실행(Run anyway)** 으로 진행하세요. 인스톨러 진위는 아래 [무결성 검증](#인스톨러-무결성-검증-v0188-신규)의 SHA-256 해시 + Sigstore attestation 으로 확인할 수 있습니다. (EV 인증서 도입 시 본 경고는 제거됩니다.)

> **참고**: AI 모델 다운로드에 약 8GB의 디스크 공간과 수 분의 시간이 필요합니다.
> **macOS 사용자**: v0.18.9 부터 Apple 공증(Notarization) 자격 미구비로 인해 dmg 출시가 일시 중단되었습니다. Gatekeeper 가 차단하는 unsigned 인스톨러를 사용자에게 강요하지 않기 위한 결정이며, 자격 등록 후 빠르게 복원됩니다. 그동안은 소스 빌드(`npm run package`)로 직접 빌드해 사용하실 수 있습니다.

### 인스톨러 무결성 검증 (v0.18.8 신규)

각 릴리즈에는 인스톨러의 **SHA-256 해시**(`SHA256SUMS-windows.txt`)가 자산으로 첨부되며, 릴리즈 노트 본문에도 함께 게시됩니다. 또한 GitHub Actions 가 발급하는 **Sigstore build provenance attestation** 으로 빌드 출처를 검증할 수 있습니다.

```bash
# Windows (PowerShell)
Get-FileHash -Algorithm SHA256 .\Local-PDF-Analyzer-Setup-0.18.19.exe

# GitHub CLI 로 attestation 검증 (선택)
gh attestation verify ./Local-PDF-Analyzer-Setup-0.18.19.exe --repo wpdlf/local-pdf-analyzer
```

## 사용 방법

### 1. PDF 업로드
- 앱 화면에 PDF 파일을 **드래그앤드롭**하거나
- **파일 선택** 버튼을 클릭하거나
- **Ctrl+O** 단축키로 파일 다이얼로그를 열어 PDF를 선택합니다
- 이전에 분석한 PDF는 업로드 화면 하단 **최근 문서** 목록에서 바로 열 수 있고, 같은 PDF를 다시 열면 요약·Q&A·검색 인덱스가 **자동 복원**됩니다 (재요약·재임베딩 없이, v0.18.27)

### 2. 요약 유형 선택

| 유형 | 설명 |
|------|------|
| **전체 요약** | PDF 전체 내용을 하나의 요약으로 정리 |
| **챕터별 요약** | 장/절 단위로 나누어 각각 요약 |
| **키워드 추출** | 핵심 키워드와 설명을 표로 정리 |

### 3. 결과 확인 및 저장
- 요약이 실시간으로 화면에 표시됩니다
- **`.md` 내보내기** 버튼으로 파일 저장
- **복사** 버튼으로 클립보드에 복사

### 4. Q&A 채팅 (RAG 시맨틱 검색)
- PDF 로드 시 자동으로 **RAG 벡터 인덱스**가 생성됩니다 (헤더에 진행률 표시)
- 인덱싱 완료 후 헤더에 **RAG** 배지가 표시되면 시맨틱 검색이 활성화된 상태입니다
- 질문하면 임베딩 벡터 유사도로 PDF에서 가장 관련 높은 부분을 찾아 AI가 답변합니다
- 임베딩 모델이 없으면 키워드 기반 검색으로 자동 전환됩니다 (기능 동일, 정확도 차이)
- 최대 10턴까지 이전 대화 맥락을 이해하며 답변합니다
- **답변 자동 검증 (v0.18.0)** — 답변 초안을 문장 단위로 분할 후 각 문장의 코사인 유사도(top-1)를 PDF 임베딩에 대조해 평가합니다. 약한 문장(<0.5)이 2개 이상이거나 비율이 20% 를 넘거나 평균 점수가 임계 미만이면, 동일 답변을 LLM 이 한 번 더 다듬어서 근거 없는 주장을 제거합니다. 모든 과정은 silent — UI 변화 없이 더 정확한 답변만 표시됩니다. 설정에서 비활성화 가능
- `Enter`: 전송 / `Shift+Enter`: 줄바꿈

### 5. 페이지 인용 + PDF 뷰어 (v0.17.0 신규, v0.17.2 확장)
- 요약과 Q&A 답변의 **각 핵심 사실마다** 자동으로 **`[p.12]` 형태의 페이지 인용**이 붙습니다 (v0.17.1 에서 단락 단위 inline 라벨로 빈도 대폭 향상)
- 인용을 **클릭**하면 화면 우측에 **PDF 뷰어 패널**이 열려 해당 페이지로 바로 이동합니다
- 다른 인용을 연달아 클릭하면 같은 패널 안에서 페이지만 이동 — 패널이 계속 유지됩니다
- **가로 리사이즈 핸들 (v0.17.2 신규)** — 요약 영역과 PDF 뷰어 사이의 **중앙 세로 구분선**을 드래그해서 좌/우 비율을 20~80% 사이로 자유 조정. Tab 포커스 후 `←`/`→` 키로 미세 조정, `Home`/`End` 로 최대/최소. 비율은 `localStorage` 에 저장되어 재시작 시 복원됩니다
- **PDF 자동 재렌더** — 리사이즈 후 PDF 페이지가 새 너비에 맞춰 다시 그려집니다 (200ms debounce, ResizeObserver 기반)
- `ESC` 또는 ✕ 버튼으로 패널을 닫으면 원래 전체 화면으로 돌아갑니다
- 인용 범위 밖(예: PDF 총 페이지 수 초과) 은 회색 점선으로 구분 표시 + 클릭 비활성
- 괄호 감싸기 `([p.5])` 나 독립 라인 `- [p.44]` 같은 LLM 실수는 **후처리로 자동 정리** (v0.17.1 신규)
- 이 기능은 **AI 환각 검증**을 위한 것 — 요약 내용의 근거 페이지를 즉시 확인할 수 있어 학습·연구·검토 use case 에 특히 유용합니다

> **임베딩 모델**: 첫 실행 셋업 시 `nomic-embed-text`(274MB)가 자동 설치됩니다. OpenAI 사용 시 `text-embedding-3-small`이 자동으로 사용됩니다.

## AI Provider 선택

기본은 로컬 AI(Ollama)로 동작하며, 더 높은 품질의 요약이 필요하면 유료 AI를 사용할 수 있습니다.

| Provider | 특징 | 비용 |
|----------|------|------|
| **Ollama (기본)** | 오프라인 사용, 개인 자료 보안 | 무료 |
| **Claude API** | 높은 요약 품질, 긴 문서 처리에 강점 | 유료 (토큰당 과금) |
| **OpenAI API** | GPT-4o 기반, 범용적 요약 | 유료 (토큰당 과금) |

### Q&A 임베딩 모델 (RAG)

| Provider | 임베딩 모델 | 차원 | 비고 |
|----------|------------|------|------|
| **Ollama** | nomic-embed-text (274MB) | 768 | 로컬 실행, 첫 실행 셋업 시 자동 설치 |
| **OpenAI** | text-embedding-3-small | 1536 | API 키로 자동 사용, 추가 설치 불필요 |
| **Claude** | Ollama fallback | — | 자체 임베딩 API 없음, Ollama 모델 사용 시도 → 불가 시 키워드 검색 |

> 임베딩 모델이 없어도 Q&A는 키워드 기반 검색으로 동작합니다. RAG는 정확도를 높이는 선택적 기능입니다.

유료 AI를 사용하려면:
1. 설정(⚙️) → AI Provider에서 Claude 또는 OpenAI 선택
2. API 키 입력 후 **저장** (키는 암호화되어 로컬에 저장됩니다)
3. 모델 선택 후 **설정 저장**

## PDF 이미지 분석

PDF에 포함된 차트, 다이어그램, 표, 사진 등을 Vision AI가 자동으로 분석하여 요약에 포함합니다.

- PDF 페이지에서 이미지를 개별 추출하여 Vision 모델로 의미 분석
- 분석 결과가 해당 페이지 텍스트에 자연스럽게 통합되어 요약 품질 향상
- 이미지가 없는 PDF는 기존과 동일하게 텍스트만 요약
- 설정에서 이미지 분석 on/off 가능

| Provider | Vision 모델 | 비고 |
|----------|------------|------|
| **Ollama** | llava, llama3.2-vision | 로컬 실행, 미설치 시 자동 안내 |
| **Claude** | claude-sonnet-4 | API 비용 발생 |
| **OpenAI** | gpt-4o | API 비용 발생 |

> Ollama 사용 시 Vision 모델(llava 등)이 별도로 필요합니다. 설정 → 모델 관리에서 설치할 수 있습니다.

## 스캔 PDF OCR

텍스트를 추출할 수 없는 이미지 기반/스캔 PDF에서 Vision AI가 페이지별로 텍스트를 자동 인식합니다.

- 텍스트 추출 실패 시 자동으로 OCR fallback 진입 (설정에서 on/off 가능)
- 각 페이지를 이미지로 렌더링 → Vision 모델에 텍스트 추출 요청
- 3페이지씩 배치 병렬 처리, 진행률 프로그레스 바 표시
- OCR 처리 중 다른 파일 로드 시 자동 중단
- OCR로 처리된 문서에는 `OCR` 배지가 표시됩니다

| Provider | OCR 정확도 (한국어) | 비고 |
|----------|-------------------|------|
| **Claude** | 90~98% | 표/수식 구조 인식 포함, API 비용 발생 |
| **OpenAI (GPT-4o)** | 90~95% | 표/수식 구조 인식 포함, API 비용 발생 |
| **Ollama (llava)** | 60~75% | 무료, 간단한 영문 PDF에 적합 |

> 스캔 PDF의 페이지 수에 따라 처리 시간과 API 비용이 증가합니다. 50페이지 기준 Claude 약 $0.15~0.30, GPT-4o 약 $0.25~0.50입니다.

## 주요 특징

- **로컬 AI 기반** — Ollama 로컬 엔진으로 인터넷 없이 요약, PDF가 외부로 전송되지 않음
- **RAG 기반 Q&A 채팅** — 임베딩 벡터 시맨틱 검색으로 질문과 관련 높은 부분을 정확히 찾아 답변, 키워드 fallback 지원 (10턴 대화)
- **깔끔한 요약 결과** — AI가 생성하는 불필요한 인사말, 감상평, 대화형 멘트를 프롬프트 제약 + 후처리 필터로 이중 제거
- **이미지 분석** — PDF 내 차트/다이어그램/표를 Vision AI로 분석하여 요약에 통합
- **스캔 PDF OCR** — 이미지 기반 PDF도 Vision AI로 텍스트 인식 후 요약 (설정에서 on/off)
- **취소 가능한 모든 장시간 작업** — PDF 파싱, OCR 진행 중 취소 버튼, Ollama 설치 마법사 중도 취소 (다른 Provider 로 즉시 전환 가능)
- **한국어 최적화** — 한글 PDF 텍스트 추출 품질 개선, 한글 비율에 따른 청크 자동 조절
- **모델 자동 설치** — 첫 실행 시 gemma3, exaone3.5 한국어 특화 모델 + nomic-embed-text RAG 임베딩 모델 자동 다운로드
- **유료 AI 지원** — Claude API, OpenAI API로 고품질 요약 가능 (Ollama 없이 바로 사용 가능)
- **Provider-aware OCR 배치** — 클라우드 provider(Claude/OpenAI) 사용 시 8페이지씩 병렬 처리로 throughput 개선, 로컬 Ollama 는 3페이지
- **API 키 보안** — OS 키체인 암호화 + Main 프로세스에서만 복호화 (Renderer에 노출되지 않음) + 메모리 캐시로 hot path 성능 최적화
- **개인 자료 보안** — Ollama 사용 시 PDF가 외부 서버로 전송되지 않음
- **실시간 스트리밍** — 요약이 생성되는 즉시 화면에 표시 (leading-edge throttle), 자동 스크롤 (직접 스크롤하면 멈춤)
- **요약 중단 가능** — 진행 중인 요약을 언제든 중단 가능, 5분 타임아웃 자동 abort
- **접근성** — 스크린 리더 `aria-live` 스트리밍 알림, 키보드 네비게이션, 다크모드 FOUC 방지
- **다크모드 지원** — 설정에서 라이트/다크/시스템 테마 선택
- **다국어 UI** — 한국어/English 앱 인터페이스 언어 전환 (설정 → 언어)
- **대용량 PDF 지원** — 긴 문서도 자동으로 나누어 처리 후 통합 요약 (배치 병렬 처리, 최대 500페이지)
- **설정 저장** — 앱 재시작 후에도 설정 유지
- **파싱 중 파일 교체** — PDF 분석 도중 다른 파일을 드롭/`Ctrl+O`로 선택하면 이전 작업을 자동 취소하고 새 파일로 전환 (abort-replace)
- **페이지 단위 손상 복원력** — 깨진 페이지 한 장이 있어도 전체 파싱이 중단되지 않고 나머지 페이지를 계속 처리
- **렌더 에러 복구** — 예기치 못한 UI 오류 발생 시 "다시 시도" 버튼으로 새로고침 없이 복구 시도 (민감 경로 자동 마스킹)
- **언어 즉시 전환** — 설정에서 한국어/English 변경 시 전체 화면이 즉시 반영 (재시작 불필요)
- **매직바이트 기반 PDF 검증** — 파일 전체를 메모리에 로드하기 전에 `%PDF-` 시그니처를 선행 확인하여 잘못된 파일 즉시 거부
- **단위 테스트 커버리지** — 핵심 RAG/citation/Q&A·메인 프로세스 회귀 방지 테스트 **총 762건 / 39 파일** (renderer·shared 443 + main 319 — 렌더러 코어 경로 463건에서 출발, v0.17.x +13 / v0.18.x 누적 +227). v0.18.19 patch 의 R32 라운드에서 +30 (P1/P2/P3 누적), R33 4-에이전트 QA 가 발견한 회귀를 R34 가 정리하며 추가 +30 — P1 4 (safe-markdown MarkdownErrorBoundary reset 가드) + P2 26 (settings-keys drift 가드 6 / enrich-doc Vision partial-failure 계약 11 / preload contextBridge shape snapshot 9). v0.18.23 R37 P6 에서 +49 — use-summarize `stripConversationalText` 다국어 멘트 제거 27 / pdf-parser 이미지 캡 실검증(OPS·OffscreenCanvas mock 으로 공허 통과 수정) / `ollama-pull-progress.ts` pull 파싱 분리 15 / use-qa `buildRagIndex` 방어 분기 7. 커버리지 게이트를 38/33/41/39 → 44/40/44/46 으로 상향하고 CI `coverage` 잡에서 강제. v0.18.24 R38 에서 그동안 거의 미검증이던 **메인 프로세스에 행위 테스트 스위트 신설**(P1~P5, 11 파일 283건) — IPC 핸들러·검증기, OllamaManager network·process 생명주기, API 키 저장소, ai-service 본체를 electron 모킹 하니스로 커버. v0.18.25 에서 Q&A TF 키워드 카운트 워드바운더리 매칭(`ai` 가 `said`/`rain` 안에서 잡히던 부분문자열 오탐 제거)과 verify 임베딩 차원 불일치 fail-safe 가드 회귀 6건 추가. v0.18.26 R39/R40 에서 `ai:check-available` SSRF store-read 가드 + 폴백 회귀 5건. v0.18.27 **세션 영속화 +30** — session-store I/O·LRU 21 / VectorStore serialize 라운드트립 3 / 콘텐츠 해시 4 / 복원·자동저장 흐름 10 (in-memory fs 모킹 + electron 모킹) / file:open-path 보안 가드 + store 복원 필드. v0.19.0 R41 +5 — 세션 영속화 신규 코드 4-에이전트 QA 가 검출한 디스크 손상/레이스 회귀 가드(blob=null 갱신 시 stale index.bin unlink / meta 필드 정규화). v0.19.1 R42 +3 — manifest 개별 엔트리 정규화(손상된 비문자열 lastAccessed·비유한 byteSize 가 최근목록·통계 크래시나 LRU 캡 무력화를 유발하던 경로 차단).
- **빌드 무결성 (v0.18.8 ~ v0.18.19 patch 누적 강화)** — 릴리즈마다 인스톨러 SHA-256 해시 자동 게시 + Sigstore build provenance attestation. GitHub Actions 워크플로의 third-party action 들은 SHA pin + `npm ci` + lockfile 동기화로 빌드 재현성 확보. v0.18.9 에서 모든 job 에 `timeout-minutes` 추가, test job 에 Ubuntu/Windows OS matrix 적용, `tsc --noEmit` 게이트를 PR/release 양쪽에 강제하여 `noUncheckedIndexedAccess` 류 strict 옵션이 회귀 없이 유지되도록 함. v0.18.10 에서 `windows-latest → windows-2025` 선제 pin. v0.18.11 에서 `actions/checkout` · `actions/setup-node` 를 Node.js 24 호환 메이저(v6)로 이전하고, `npm audit --audit-level=high` advisory 단계와 `package.json` `engines` 필드(node ≥ 20.11, npm ≥ 10)를 추가. v0.18.13 에서 `asarUnpack: ["**/cmaps/**"]` 도입(packaged build 의 CJK CMap 안전 보장) + R29 P1 회귀 픽스 9건. v0.18.15 에서 Ollama `keep_alive: '30m'` + renderer `manualChunks` (main chunk 808→304 KB, -62%) + Vision provider-aware 동시성 (Ollama 3 / cloud 8) — 성능 트랙 1라운드. v0.18.16 에서 PdfViewer 페이지 가상화 (IntersectionObserver lazy render, 100p PDF 렌더 canvas 95% 감소) — 성능 트랙 2라운드. v0.18.17 에서 R30 풀-QA P1 6건 (Promise.race 타이머 leak / PdfViewer viewport race / lockfile drift / 빈 image name 가드 / targetPage 폴링 stuck / workflow node-version drift) 정리. v0.18.18 에서 R30 P2 + R29 QA P2 잔여 small-fix 6건 묶음 (Vision in-flight abort / setNotice 자동 dismiss / vitest coverage / LOCALHOST_HOSTS 통합 / Bearer regex `~` / shell:open-external 길이 캡). v0.18.19 patch 에서 R32 4-에이전트 병렬 QA 결과 P2 5건 + P3 8건 + P4 12건 + P5 8건 — 같은 v0.18.19 release 자산을 누적 빌드로 3차 덮어쓰기 (Q&A cross-session 토큰 contamination / 프롬프트 인젝션 summary+assistant / PDF parse 오류 banner 경로 누출 / OCR 클라우드 abort 미전파 / CI audit step `if: always()` + Vision stale enrichment / 테마 localStorage drift / MarkdownErrorBoundary reset / OCR 메모리 캡 / MAX_LINE_SIZE silent skip / lockfile `packages[""]` 검증 / audit JSON 단일 spawn 통합 / ollama PowerShell quote helper + 9 case 단위 테스트 + handleSummarize docId guard / appendQaStream isQaGenerating 가드 / enrichedPageTexts version counter / clientRef ownership / taskkill SIGKILL fallback / will-redirect 엄격화 / generate placeholder controller / req.setTimeout settled / i18n hasOwnProperty + 미정의 키 fallback / ResizeHandle Home/End ARIA 정합 / safe-markdown 헤딩·blockquote citation / vitest pool 'forks' + Vitest 4 마이그 / ai-client.test timer 마진 / release.yml fail-fast: false / postbuild cmap smoke check). 그 후 R33 4-에이전트 QA 가 R32 도입 코드에서 4건의 회귀를 검출 — R34 P1 으로 정리 (MarkdownErrorBoundary 비교 대상을 children identity 에서 fallbackText 문자열로 교체 / `generate()` placeholder leak try-catch cleanup / will-redirect 의 file:// 비교를 `pathToFileURL().href` 표준 URL 로 / CI audit step 이 `npm ci` 실패 후 fire 시 `[ -d node_modules ]` 가드 + `j.error` 분기), R34 P2 로 커버리지 보강 + 동반 P4 (`VALID_SETTINGS_KEYS` 단일 출처 모듈 분리 / `enrichDocumentWithImages` pure helper 분리 / preload contextBridge shape snapshot 정적 검사 / i18n `hasOwnProperty` + `=== undefined` AND / pdf-parser OCR per-page abort listener race 차단 / preload `ai.abort` 반환 타입 `error?` 정합 / postbuild SMOKE_FILES 에 `Adobe-CNS1-UCS2.bcmap` 추가). 동일 v0.18.19 release 자산을 누적 빌드로 **5차** 덮어쓰기, Critical 34R 연속 zero. 이후 v0.18.23 R37 에서 CI 커버리지 게이트를 `coverage` 잡으로 실제 강제(이전엔 `npm run test:coverage` 수동 실행 시에만 적용되어 회귀가 CI 를 silent 통과)하고, test/release 워크플로의 Node 를 20.11 → 22 로 정렬(20.11 EoL 2026-04). 4-에이전트 병렬 QA 에서 Critical/High 0건, Critical 37R 연속 zero. 이후 R38~R40 4-에이전트 병렬 QA 에서도 Critical/High 0건(40R 연속 zero) — v0.18.26 에서 `ai:check-available` 의 SSRF 포트-스캔 오라클을 차단(renderer 전달 URL 대신 설정 store 의 정규 URL 만 사용)하고, electron 을 41.6.1→41.7.1(Chromium 보안 롤업)로 올리며 `npm audit fix` 로 dev 의존성 취약점 6건을 해소(npm audit 0). v0.18.27 에서 세션 영속화 기능을 PDCA plan-plus→design→do(4 모듈)→check(Match Rate 100%) 사이클로 완결. 이후 v0.19.0 R41 4-에이전트 병렬 QA 가 세션 영속화 신규 코드에서 디스크 세션 손상 High 1 + Important 5 (summaryType↔content 불일치 / stale index.bin / persist load-merge-save 레이스 / restoredSession provider stale 스냅샷 / meta 무검증 / RecentDocuments mountedRef)를 검출·수정해 기능을 안정화 마일스톤으로 승격, v0.19.1 R42 에서 manifest 엔트리 견고성(손상 엔트리 정규화) + UI 에러 수렴(드래그-드롭 배너 / 최근목록 삭제 피드백) Important 1 + Minor 4 정리. v0.19.x 전 구간 Critical/High 연속 zero(R42 까지 42R) 유지.
- **세션 영속화 + RAG 인덱스 캐싱 (v0.18.27, v0.19.0 안정화)** — 문서 콘텐츠 해시(SHA-256) 기준으로 요약·Q&A·파싱 텍스트는 JSON, 임베딩 인덱스는 Float32 바이너리 블롭으로 분리해 `userData/sessions/` 에 영속화(원자적 tmp→rename). 같은 PDF 재오픈 시 해시 매칭으로 복원하고, 임베딩 모델·차원이 일치하면 인덱스를 역직렬화해 **재임베딩·재요약 호출 0**. 복원↔자동 빌드 경합은 `sessionRestorePending` 게이트 + `restoredSession` 마커로 차단. LRU(최대 30개/200MB) 자동 정리, 콘텐츠/모델/차원 변경 시 캐시 안전 무효화. 네이티브 의존성 0 유지(SQLite 미도입). `file:open-path` 는 `file:open-pdf` 와 동일 보안 가드(.pdf 확장자·심볼릭링크 거부·100MB 캡)로 최근목록 재오픈 시 임의 파일 읽기를 차단. v0.19.0~v0.19.1 에서 손상 내성을 강화 — blob 없는 재저장 시 stale `index.bin` 을 제거해 차원 불일치 복원·LRU byteSize 과소계상을 막고, 렌더러 제공 meta 및 디스크 manifest 의 개별 엔트리를 모두 서버측 정규화(길이 캡 + `Number.isFinite` + 비문자열 `lastAccessed` epoch 폴백)해 부분 쓰기/외부 편집으로 손상된 매니페스트가 최근목록·통계를 크래시시키거나 200MB 캡을 무력화하지 못하도록 차단
- **페이지 인용 + 사이드 PDF 뷰어 (v0.17.0)** — 요약/Q&A 답변의 각 핵심 사실에 출처 페이지 `[p.N]` 자동 생성, 클릭 시 우측 패널에서 해당 페이지 즉시 확인. RAG 청크에 page 메타데이터 전파 + LLM 프롬프트 CITATION_RULES(5 언어) 주입 + pdfjs-dist lazy 뷰어 + react-markdown text-block 오버라이드로 구현. v0.17.1 에서 단락별 inline 라벨로 인용 빈도 대폭 향상
- **가로 리사이즈 핸들 (v0.17.2)** — PDF 뷰어 패널 열렸을 때 중앙 구분선 드래그로 좌/우 비율 20~80% 자유 조정. Pointer + 키보드(← → Home End) + ARIA (`role="separator"`, `aria-valuenow`) + localStorage 영속화. PDF 는 `ResizeObserver` + 200ms debounce 로 자동 재렌더
- **인용 후처리 정규화 (v0.17.1)** — LLM 이 간혹 생성하는 괄호 감싸기 `([p.5])` 나 독립 목록 항목 `- [p.44]` 을 자동으로 본문 문장 끝에 부착
- **답변 자동 검증 (v0.18.0)** — Q&A 답변 초안을 문장 단위(다국어 종결부호 인식, mixed-CJK 분리 v0.18.8)로 분할 → 각 문장의 코사인 유사도(top-1)를 PDF 임베딩에 대조 → weakCount/weakRatio/avgScore 임계 초과 시 LLM 으로 한 번 더 refine. 단일 boilerplate 약문장은 허용해 refine 비용 최적화 (v0.18.3)

## 시스템 요구 사항

- **Windows 10 이상** 또는 **macOS 12 (Monterey) 이상**
- 디스크 공간 최소 8GB (AI 모델 저장용, Ollama 사용 시)
- 인터넷 연결 (첫 설치 시 및 유료 API 사용 시)
- PDF 제한: 최대 100MB, 최대 500페이지 (초과 시 문서 분할 권장)

## 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| Ollama 설치 실패 | [ollama.com](https://ollama.com)에서 수동 설치하거나, 설치 마법사의 "취소하고 다른 Provider 사용" 버튼으로 Claude/OpenAI 전환 |
| 한국어 요약 품질이 낮음 | 설정에서 gemma3 또는 exaone3.5 모델이 선택되어 있는지 확인해보세요 |
| 요약이 느림 | 설정에서 경량 모델(phi3 등)로 변경하거나 청크 크기를 줄여보세요 |
| PDF 텍스트 추출 불가 | 설정에서 "스캔 PDF OCR"이 활성화되어 있는지 확인하세요. Vision 모델(llava, Claude, GPT-4o)이 필요합니다 |
| OCR 결과가 부정확함 | Ollama llava는 한국어 정확도가 낮습니다. Claude 또는 OpenAI로 전환하면 정확도가 크게 향상됩니다 (+ 배치 크기도 3→8로 증가) |
| OCR이 너무 오래 걸림 | 진행 중 화면의 "■ 취소" 버튼을 눌러 중단할 수 있습니다. 클라우드 provider 로 전환하면 더 빠른 throughput 을 얻을 수 있습니다 |
| PDF가 500페이지 초과 | 수동으로 문서를 분할한 후 다시 업로드해주세요. 자원 폭주 방지를 위해 상한이 적용됩니다 |
| 이미지 분석이 안 됨 | Ollama 사용 시 llava 등 Vision 모델이 필요합니다. 설정에서 모델을 설치해주세요 |
| API 키 오류 | 설정에서 API 키가 올바른지 확인. Claude: `sk-ant-...`, OpenAI: `sk-...` |
| Claude/OpenAI 사용 불가 | API 키를 먼저 저장한 후 Provider를 선택해주세요 |
| 요약에 "잘 정리해주셨네요" 같은 문구가 나옴 | v0.10.0에서 프롬프트 강화 + 후처리 필터로 자동 제거됩니다 |
| Q&A에서 답변을 못 함 | RAG 배지가 없으면 `ollama pull nomic-embed-text`로 임베딩 모델을 설치하세요. 키워드 모드에서는 질문에 구체적 용어를 포함해주세요 |
| RAG 인덱싱이 안 됨 | 첫 실행 셋업을 완료했는지 확인하세요 (nomic-embed-text 자동 설치). 수동 설치: `ollama pull nomic-embed-text` |
| 모델 추가 후 선택한 모델이 바뀜 | v0.8.2 이상에서 수정됨 — 모델 추가 시 기존 선택이 유지됩니다 |
| 파싱 중 다른 파일 드롭이 무시됨 | v0.16.2 에서 abort-replace 패턴 적용 — 새 파일이 즉시 우선권을 갖습니다 |
| 청크 크기 입력이 한 글자씩 거부됨 | v0.16.2 에서 수정됨 — 타이핑 중에는 자유롭게 입력하고 blur 시 1000–16000 범위로 자동 보정됩니다 |
| 설정에서 언어를 바꿔도 일부 문구가 안 바뀜 | v0.16.2 에서 전체 UI 반응형 전환 — `tr()` 훅 기반으로 렌더 즉시 반영 |
| API 키 삭제 후에도 Claude/OpenAI 모델이 잔존 | v0.16.2 에서 수정됨 — 키 삭제 시 Ollama + 설치된 모델로 자동 전환 |
| 요약 복사 버튼이 동작하지 않음 | v0.16.2 에서 `clipboard-sanitized-write` 권한 명시 허용으로 해결 |
| 화면 오류로 앱이 멈춤 | v0.16.2 에서 ErrorBoundary "다시 시도" 버튼 제공 — 재시작 없이 복구 시도 가능 |
| 요약에 인용이 1개만 나옴 | v0.17.1 에서 단락별 inline 페이지 라벨로 개선 — 각 핵심 사실마다 인용 생성 |
| 요약에 `([p.5])` 같은 괄호 감싸기나 독립 라인 `- [p.44]` 가 나옴 | v0.17.1 후처리 정규화로 자동 정리됨 — 괄호 제거 + 이전 문장 끝에 부착 |
| PDF 뷰어가 너무 크게 표시됨 (좁은 패널) | v0.17.1 에서 수정 — 컨테이너 너비 기반 동적 scale 로 자동 fit |
| PDF 뷰어 패널 크기를 바꾸고 싶음 | v0.17.2 신규 — 중앙 구분선 드래그 또는 키보드 (Tab 포커스 후 ← → Home End) 로 20~80% 조정 |
| 리사이즈 후 PDF 가 늘어난 상태로 남음 | v0.17.2 에서 `ResizeObserver` 로 자동 재렌더 — 드래그 종료 200ms 후 새 scale 로 다시 그려짐 |
| Q&A 답변에서 환각이 자주 보임 | v0.18.0 답변 자동 검증으로 약한 근거의 문장 다수 발견 시 LLM 재정리. 비활성화하려면 설정에서 "답변 검증" 토글을 끌 수 있습니다 |
| 답변이 두 번 생성되는 듯한 지연이 있음 | v0.18.0 검증 후 refine 트리거 시 한 번 더 LLM 호출이 발생합니다. 단일 약문장은 허용(v0.18.3)되어 대부분의 답변에서는 한 번에 끝납니다 |
| 한·영 섞인 답변에서 환각이 한 문장으로 합쳐져 검출이 안 됨 | v0.18.8 에서 수정 — `splitIntoSentences` 가 Latin 종결부호 직후 공백 없이 CJK 가 따라오는 mixed 케이스도 분리합니다 |
| 임베딩 모델을 바꾼 뒤 모든 Q&A 답변이 두 번씩 생성됨 | v0.18.25 에서 수정 — 인덱스를 빌드한 임베딩 모델과 현재 검증 임베딩 모델의 차원이 다르면 RAG 검색이 항상 빈 결과를 반환해 모든 문장이 약문장으로 오분류되고 refine 이 매번 강제 트리거되던 문제. 차원 불일치 시 검증을 건너뛰고 초안을 그대로 유지하는 fail-safe 가드를 추가했습니다 |
| 같은 PDF를 다시 열면 처음부터 다시 요약·인덱싱됨 | v0.18.27 세션 영속화 — 동일 콘텐츠 문서는 요약·Q&A·검색 인덱스가 자동 복원됩니다. 임베딩 모델이 일치하면 재임베딩 없이 즉시. 끄려면 설정 → "세션 데이터" 토글을 해제하세요 |
| 최근 문서 목록에서 열었는데 원문 PDF 뷰어가 안 뜸 | v0.18.27 — 콘텐츠 해시로 식별하므로 요약·Q&A 분석은 복원되지만, 원본 파일이 이동/삭제되었으면 PDF 뷰어 렌더는 비활성화됩니다(분석은 그대로 사용 가능). 원본을 다시 열면 뷰어도 복구됩니다 |
| 저장된 세션이 디스크를 너무 많이 차지함 | v0.18.27 — LRU 로 최대 30개/200MB 까지만 보관하고 초과 시 가장 오래된 것부터 자동 삭제됩니다. 설정 → "세션 데이터" 에서 현재 용량 확인 및 "전체 비우기" 가능 |
| 복원한 요약 탭의 라벨과 실제 내용이 다름 | v0.19.0 에서 수정 — 특정 요약 유형이 저장돼 있지 않을 때 다른 유형으로 대체 표시하면서 라벨은 그대로 두던 문제(예: "키워드" 탭에 전체 본문). 대체 시 실제 유형으로 라벨링하고 잘못된 키로 자동저장되지 않도록 했습니다 |
| 세션 데이터가 손상돼도 앱이 멈추지 않게 하려면 | v0.19.0~v0.19.1 에서 강화 — 부분 저장/외부 편집으로 manifest 항목이 손상돼도 최근 문서 목록·용량 통계가 크래시하지 않고 손상 항목만 안전하게 무시·정리합니다(별도 조치 불필요) |
| 인스톨러가 변조됐는지 확인하고 싶음 | v0.18.8 신규 — 릴리즈 페이지의 `SHA256SUMS-windows.txt` 또는 본문 해시와 비교하거나, `gh attestation verify` 로 Sigstore provenance 를 검증할 수 있습니다 |
| macOS 다운로드가 보이지 않음 | v0.18.9 부터 코드사인/공증 자격이 갖춰지기 전까지 dmg 출시를 일시 중단했습니다 (사용자가 `xattr -d` 로 검역을 우회해야만 실행 가능한 unsigned 인스톨러 출시를 막기 위한 결정). 자격 등록 후 빠르게 복원되며, 그동안은 소스에서 `npm run package` 로 직접 빌드해 사용하실 수 있습니다 |
| 대용량 PDF 에서 메모리 사용이 폭주함 | v0.18.9 에서 수정 — 페이지 이미지 추출 캡(최대 50장)이 배치 동시성으로 우회되던 문제를 해결. 페이지 promise 진입 시점과 push 직전 2단계에서 잔여 슬롯을 재확인하여 한 번에 수십 장씩 base64 변환 중 OOM 가능성을 차단 |
| 요약·Q&A 를 조기 중단하면 토큰 listener 가 일정 시간 남아 있는 듯한 동작 | v0.18.9 에서 수정 — `ai-client` 의 listener/timer 등록을 `try/finally` 안으로 이동해, `generate()` 동기 throw 나 등록 도중 예외가 발생해도 unsub/`abort` 가 반드시 실행되도록 보장 |

---

## 개발자 가이드

### 기술 스택

| 항목 | 기술 |
|------|------|
| 프레임워크 | Electron 41 + React 19 |
| 언어 | TypeScript (strict mode) |
| AI 생성 | Ollama (로컬) / Claude API / OpenAI API — Main 프로세스 IPC 기반 |
| AI 임베딩 (RAG) | Ollama /api/embed / OpenAI /v1/embeddings — 인메모리 벡터 스토어 |
| PDF 파싱 | pdfjs-dist (위치 기반 텍스트 추출 + 이미지 추출, 한글 최적화) |
| 상태 관리 | Zustand |
| 스타일링 | Tailwind CSS v4 + @tailwindcss/typography |
| 빌드 | electron-vite + electron-builder (Windows NSIS — macOS DMG 는 v0.18.9 부터 공증 자격 추가 시까지 일시 중단) |
| 테스트 | Vitest (762개 단위 테스트, 39 파일 — renderer·shared 443 / main 319) + `tsc --noEmit` strict 타입 체크 (`noUncheckedIndexedAccess` 활성, v0.18.8; PR/release CI 양쪽에서 강제, v0.18.9; `vitest.config.mts` + `test/setup.ts` 진입점 도입, v0.18.11; `noFallthroughCasesInSwitch` + `noImplicitOverride` 활성, v0.18.19; `pool: 'forks'` 명시 + Vitest 4 마이그레이션, v0.18.19 patch). main 측 native deps 없는 pure helper 들을 별도 모듈로 분리하여 vitest 가 직접 테스트 가능 (`settings-keys.ts` / `ps-quote.ts` / `enrich-doc.ts` / `ollama-pull-progress.ts`, v0.18.23) — drift 가드 + Vision partial-failure 계약 + pull 진행 파싱 정적 검증. v0.18.23 부터 커버리지 임계(44/40/44/46)를 CI `coverage` 잡에서 강제. v0.18.24 R38 에서 메인 프로세스 행위 테스트(IPC·OllamaManager·API 키 저장소·ai-service, 11 파일 283건)를 electron 모킹 하니스로 신설. v0.18.27 세션 영속화로 session-store(in-memory fs 모킹)·VectorStore serialize 라운드트립·복원/자동저장 흐름·file:open-path 보안 가드 +30. v0.19.0 R41 +5 (use-session summaryType fallback·persist 직렬화 / session-store stale index.bin·meta 정규화) / v0.19.1 R42 +3 (loadManifest 손상 엔트리 정규화·폐기 회귀 가드) |
| 다국어 (i18n) | 자체 구현 (i18n.ts) — 172+ 키, useT() 훅, 템플릿 치환 |
| API 키 보안 | Electron safeStorage (OS 키체인 암호화), Main 프로세스에서만 복호화, 메모리 캐시로 hot path 최적화 |
| 공유 상수 | `src/shared/constants.ts` — Main/Renderer 공유 (MAX_PDF_SIZE 등 drift 방지) |

### 개발 환경 설정

```bash
# 의존성 설치
npm install

# 개발 모드 실행
npm run dev

# 프로덕션 빌드
npm run build

# 인스톨러 패키징
npm run package

# 테스트 실행
npm test

# 테스트 (watch 모드)
npm run test:watch
```

### 프로젝트 구조

```
src/
├── main/                 # Electron main process
│   ├── index.ts          # 앱 엔트리, IPC, 설정/API키 관리
│   ├── ai-service.ts     # AI API 호출 (스트리밍 요약 + Vision 이미지 분석 + OCR)
│   └── ollama-manager.ts # Ollama 설치/시작/모델 관리
├── preload/
│   └── index.ts          # contextBridge API (ai, settings, apiKey, ollama, file)
└── renderer/             # React UI
    ├── App.tsx            # 루트 컴포넌트, 요약 로직
    ├── components/        # UI 컴포넌트 (9개)
    ├── lib/
    │   ├── ai-client.ts       # AI Client (IPC를 통해 Main에 요약/Q&A 요청)
    │   ├── pdf-parser.ts      # PDF 텍스트 + 이미지 추출, 챕터 감지, OCR fallback
    │   ├── chunker.ts         # 텍스트 청크 분할 (한글 비율 자동 감지)
    │   ├── i18n.ts             # 다국어 번역 (172+ 키, t() 함수, useT() 훅)
    │   ├── use-qa.ts          # Q&A 채팅 훅 (RAG 시맨틱 검색 + 키워드 fallback, 대화 이력)
    │   ├── vector-store.ts    # 인메모리 벡터 스토어 (코사인 유사도 검색, 차원 검증)
    │   ├── store.ts           # Zustand 상태 관리 (요약 + Q&A + RAG 인덱스)
    │   └── __tests__/         # 단위 테스트 (762개, 39 파일)
    └── types/
        └── index.ts       # 타입 정의 + Provider 모델 상수
```

### 아키텍처

API 키 보안을 위해 AI API 호출은 Main 프로세스에서 수행됩니다. Renderer는 IPC를 통해 요약을 요청하고 토큰 스트림을 수신합니다.

```
Electron Main Process                Renderer Process (React)
┌──────────────────────────┐        ┌──────────────────────────┐
│ OllamaManager            │        │ App.tsx                  │
│ AiService ──┐            │◄─IPC─►│ ├── PdfUploader          │
│   ├── Ollama (HTTP)      │        │ ├── SummaryViewer        │
│   ├── Claude (HTTPS)     │        │ │   └── QaChat (Q&A)    │
│   └── OpenAI (HTTPS)     │        │ ├── SettingsPanel        │
│ Embedding ──┐            │        │ └── lib/                 │
│   ├── Ollama /api/embed  │        │     ├── AiClient (IPC)   │
│   └── OpenAI /v1/embed.  │        │     ├── PdfParser        │
│ Settings (JSON)          │        │     ├── VectorStore (RAG) │
│ API Keys (safeStorage)   │        │     ├── useQa (Q&A 훅)   │
│ File I/O                 │        │     └── Zustand           │
└──────────────────────────┘        └──────────────────────────┘
         │                                     │
         │  ai:generate ──► Main에서 API 호출   │
         │  ai:token    ◄── 토큰 스트리밍        │
         │  ai:done     ◄── 완료 신호           │
         │  ai:abort    ──► 요청 중단           │
         │  ai:embed    ──► 임베딩 벡터 생성     │
         │  ai:check-embed-model ──► 모델 확인  │
```

### 데이터 처리 파이프라인

PDF 파일이 요약 결과로 변환되는 전체 과정입니다.

```
PDF 파일
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 1. PDF 파싱 (pdf-parser.ts)                          │
│    ├── pdfjs-dist로 페이지별 텍스트 추출              │
│    │   └── 위치 기반(x,y,fontSize) 공백/줄바꿈 삽입   │
│    │       → 한글 글자 단위 분할 대응                  │
│    ├── 페이지별 이미지 추출 (paintImageXObject)        │
│    │   └── RGB/RGBA/Grayscale → JPEG base64 변환      │
│    │       → 최대 1024px 리사이즈, 4M 픽셀 초과 스킵  │
│    └── 챕터 자동 감지                                 │
│        └── "제1장", "Chapter 1", "1장" 패턴 매칭      │
│            → 미감지 시 10페이지 단위 분할              │
│                                                      │
│    배치 처리: 10페이지씩 병렬, 이미지 최대 50장       │
└─────────────────────────────────────────────────────┘
  │
  ▼ (텍스트 50자 미만 + OCR 활성화 시)
┌─────────────────────────────────────────────────────┐
│ 1-b. OCR Fallback (pdf-parser.ts, 스캔 PDF 전용)     │
│    ├── 각 페이지를 OffscreenCanvas로 JPEG 렌더링     │
│    │   └── scale 자동 조정 (50p+: 1.5, 100p+: 1.0)  │
│    │       → 최대 3000px, GPU 메모리 즉시 해제        │
│    ├── Provider-aware 배치 병렬로 Vision OCR 요청    │
│    │   └── Ollama: 3페이지 / Claude·OpenAI: 8페이지  │
│    │       → ai:ocr-page IPC → Main → Vision API    │
│    ├── AbortSignal 전파로 즉시 취소 (사용자 취소 버튼)│
│    └── 추출된 텍스트로 정상 파이프라인에 합류          │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 2. 이미지 분석 (선택적, enableImageAnalysis=true)     │
│    ├── 첫 이미지로 Vision 모델 사전 확인 (preflight)  │
│    ├── 나머지 이미지 3장씩 배치 병렬 분석             │
│    └── 분석 결과를 해당 페이지 텍스트에 삽입           │
│        → "[이미지 분석: 차트는 매출 상승을...]"        │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 3. 텍스트 청크 분할 (chunker.ts)                      │
│    ├── 한글 비율 자동 감지 (처음 2000자 샘플링)        │
│    │   └── 100% 한글: 1.5 chars/token                │
│    │       0% 한글:   4.0 chars/token                │
│    ├── maxChunkSize(기본 4000 토큰) × chars/token     │
│    │   → 실제 문자 수 기준 분할                       │
│    └── 문단(\n\n) 경계에서만 분할 (문장 중간 절단 방지)│
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 4. AI 요약 생성 (ai-service.ts)                       │
│    ├── 프롬프트 구성: 시스템 지시 + 금지 사항 + 본문   │
│    ├── IPC: Renderer → Main (ai:generate)             │
│    ├── Main에서 API 키 복호화 후 HTTP 스트리밍 요청    │
│    │   ├── Ollama:  /api/generate (NDJSON)            │
│    │   ├── Claude:  /v1/messages  (SSE)               │
│    │   └── OpenAI:  /v1/chat/completions (SSE)        │
│    ├── 토큰 스트리밍: Main → Renderer (ai:token)       │
│    └── 다중 청크 시 개별 요약 후 통합 요약 추가 생성   │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 5. Renderer 표시 (SummaryViewer.tsx + store.ts)       │
│    ├── 토큰 버퍼링 (50ms 간격 배치 flush)             │
│    ├── Markdown 렌더링 leading-edge throttle (150ms) │
│    │   └── 첫 토큰 즉시 표시, 이후 150ms 윈도우 제한  │
│    ├── 자동 스크롤 (하단 100px 이내일 때만)            │
│    ├── aria-live=polite 로 스크린 리더 알림           │
│    ├── stripConversationalText 후처리 (대화형 멘트 제거)│
│    └── .md 내보내기 / 클립보드 복사                    │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 6-a. RAG 벡터 인덱스 빌드 (문서 로드 시 자동)        │
│    ├── 임베딩 모델 사용 가능 여부 확인                │
│    │   └── Ollama: nomic-embed-text 등 자동 감지     │
│    │       OpenAI: text-embedding-3-small             │
│    │       Claude: Ollama fallback → 불가 시 키워드   │
│    ├── 오버랩 청킹 (500토큰, 10% 오버랩)             │
│    ├── 50건씩 배치 임베딩 (배치당 2분 타임아웃)       │
│    │   └── ai:embed IPC → Main → 임베딩 API          │
│    │       → IPC 경계에서 NaN/Infinity 검증           │
│    ├── 인메모리 벡터 스토어에 청크+임베딩 저장         │
│    │   └── 차원 고정: 첫 청크 차원으로 lock           │
│    ├── 문서 전환 시 buildId 가드로 즉시 취소          │
│    └── UI: 인덱싱 진행률 → 완료 시 RAG 배지          │
└─────────────────────────────────────────────────────┘
  │
  ▼
┌─────────────────────────────────────────────────────┐
│ 6-b. Q&A 채팅 (use-qa.ts + QaChat.tsx)               │
│    ├── 사용자 질문 입력 (Enter 전송, Shift+Enter 줄바꿈)│
│    ├── RAG 시맨틱 검색 (코사인 유사도 Top-5)          │
│    │   ├── 질문 임베딩 → 벡터 스토어 검색             │
│    │   ├── minScore 0.3 미만 결과 제외                │
│    │   └── 8000자 컨텍스트 크기 제한 적용             │
│    ├── RAG 실패 시 키워드 TF 스코어링 fallback        │
│    ├── 요약 결과(3000자) + 검색 결과(8000자) 결합     │
│    ├── 프롬프트 인젝션 방어 (RAG/키워드 양쪽 적용)    │
│    ├── 대화 이력 포함 프롬프트 조립 (최대 10턴)       │
│    ├── ai:generate(type:'qa')로 스트리밍 답변 생성     │
│    └── 요약/Q&A 상호 배제 — 동시 실행 불가            │
└─────────────────────────────────────────────────────┘
```

### AI 요약 프롬프트 설계

각 요약 유형별로 시스템 지시 + 금지 사항이 포함된 프롬프트가 구성됩니다.

| 유형 | 프롬프트 핵심 지시 |
|------|-------------------|
| `full` | 핵심 개념, 주요 내용, 수식/공식, 예제, 핵심 포인트 5개 항목 구조 |
| `chapter` | 해당 섹션의 개념/정의, 수식, 예제, 3~5개 핵심 포인트 |
| `keywords` | 키워드/설명/중요도 마크다운 테이블 (10~30개) |
| `qa` | PDF 내용 기반 Q&A — 요약 + 원문 관련 청크를 컨텍스트로 제공, 대화 이력 포함 |

**금지 사항** (요약 유형 공통): 인사말, 칭찬, 감상평, 대화형 멘트를 "절대 금지 사항"으로 강하게 지시합니다. 추가로 `stripConversationalText` 후처리 필터가 로컬 LLM이 생성한 대화형 멘트를 자동 제거합니다 (Q&A 답변에는 적용되지 않음).

### AI 요약 IPC 흐름

1. Renderer에서 `ai:generate` IPC로 텍스트 + provider + model 전달
2. Main 프로세스가 `safeStorage`에서 API 키를 복호화하여 직접 API 호출
3. 스트리밍 토큰을 `ai:token` 이벤트로 Renderer에 전달
4. Renderer의 `AiClient`가 AsyncGenerator로 토큰을 yield

새 Provider를 추가하려면 `src/main/ai-service.ts`에 생성 함수를 추가하고 `generate()` switch문에 등록합니다.

### 보안 설계

| 위협 | 대응 |
|------|------|
| API 키 탈취 | `safeStorage` (OS 키체인) 암호화, Renderer에 키 미전달, 프로세스 메모리 캐시로 복호화 비용 최소화 |
| Ollama SSRF | localhost만 허용 (`validateOllamaUrl`), http/https만 허용 |
| SSRF 포트-스캔 오라클 (v0.18.26) | `ai:check-available` 가 renderer 전달 URL 을 그대로 신뢰하면 손상된 렌더러가 임의 localhost 포트를 프로브하는 오라클이 됨(host/protocol 은 검증되나 port 미검증). 설정 store 의 정규 URL 만 사용하도록 전환해 per-call 포트 스윕 차단 (embeddings/vision 핸들러와 동일 패턴) |
| 세션 경로 traversal (v0.18.27) | 세션 저장 디렉토리를 콘텐츠 해시로 식별 — `docHash` 를 `/^[a-f0-9]{64}$/` 화이트리스트로 강제해 `..` 등 경로 조작 차단. `file:open-path` 최근목록 재오픈은 `.pdf` 확장자·심볼릭링크 거부·100MB 캡으로 임의 파일 읽기 차단. 세션 데이터에 API 키 미포함 |
| PDF 드롭 경로 조작 | `will-navigate` 차단, `file://` + `.pdf` 확장자만 허용, `lstat` 심볼릭 링크 거부 (악성 `.pdf` 링크가 시스템 파일 가리키는 공격 차단) |
| IPC 입력값 조작 | 모든 IPC 핸들러에서 타입/범위/길이 검증, 공유 상수 모듈로 main/renderer drift 방지 |
| 외부 URL 열기 | 정확 호스트명 화이트리스트 (`Set.has()` 매칭 — suffix 매칭 제거로 UGC 도메인 차단) |
| Ollama 인스톨러 변조 | Authenticode 서명 검증 (v0.17.7) — 다운로드 후 `Get-AuthenticodeSignature` 로 발행자 CN 확인, 비-Ollama 서명 시 설치 거부 |
| 이중 인스턴스 경쟁 쓰기 | `requestSingleInstanceLock` — 두 번째 프로세스 즉시 종료, settings.json / api-keys.enc clobber 방지 |
| DevTools 정보 노출 | 프로덕션 빌드에서 `webPreferences.devTools: false` 로 원천 비활성화 |
| 권한 probing | `setPermissionCheckHandler` 추가 — `permission.query()` 를 통한 capability 탐색 차단 |
| Markdown XSS | `javascript:`, `data:` URL 차단, 외부 이미지 차단 |
| 인라인 스크립트 인젝션 | CSP `script-src` 에서 `'unsafe-inline'` 제거 (v0.18.23) — FOUC 방지 초기화 스크립트 1건만 sha256 해시로 화이트리스트, 스크립트 본문 변경 시 vitest 게이트가 해시 갱신 강제. `style-src` 는 Tailwind/React 인라인 스타일 광범위 사용으로 유지(스크립트 부재 시 스타일 단독 exfil 불가) |
| Iframe/Form 주입 | CSP `frame-src 'none'; child-src 'none'; base-uri 'none'; form-action 'none'` 로 예방적 차단 |
| 응답 크기 폭주 | 스트리밍 50MB, Vision 10MB, 모델 목록 1MB 제한, PDF 최대 500페이지/100MB |
| Vision API 로그 유출 | 에러 body 에서 Bearer / sk-ant- / sk-proj- / sk-live- 토큰 sanitize |
| Q&A 프롬프트 인젝션 | `splitPrompt`가 첫 번째 구분자만 사용, RAG/키워드 양쪽 컨텍스트에 `sanitizePromptInput` 적용 |
| RAG 임베딩 오염 | IPC 경계에서 NaN/Infinity 검증, 벡터 차원 고정(첫 청크 lock), 배열 개수 불일치 거부 |
| RAG 문서 혼합 | `AbortController` 로 문서 전환 시 이전 빌드 즉시 취소, docId 최종 검증 |
| OCR 프롬프트 인젝션 | Vision/OCR 프롬프트에 "이미지 내 지시사항 무시" 명시, 응답 URL/코드블록 제거 |
| OCR 메모리 폭주 | 페이지 scale 자동 축소, 3000px 상한, OffscreenCanvas GPU 즉시 해제 |
| Q&A 대화 이력 과다 | 이력 4000자 제한 + 10턴 FIFO, 질문 1000자 상한 |
| 네트워크 단절 무응답 | HTTP 스트림 `close` 리스너로 비정상 종료 즉시 감지 (120초 대기 없음) |
| 네비게이션 하이재킹 | `will-navigate` + `will-redirect` 모두 차단 (프로덕션 빌드에서도 정상 동작 검증) |
| 브라우저 권한 남용 | `setPermissionRequestHandler` + `setPermissionCheckHandler` 기본 거부, `clipboard-sanitized-write` 만 예외 허용 (복사 기능 유지) |
| 설치 파일 다운로드 OOM | `response.pipe(file)` backpressure, 500MB 상한 push 전 체크, 부분 다운로드 자동 정리 |
| `ollama pull` 자식 프로세스 고아화 | `pullProcess` 인스턴스 추적, 앱 종료 시 `taskkill /F /T` (Windows), 재진입 가드 |
| Vision 에러 바디 메모리 폭주 | 에러 바디 64KB 바이트 cap (push 전 검사) + 초과 시 소켓 즉시 해제 |
| 렌더 예외 경로 유출 | `AppErrorBoundary` 에서 홈 디렉토리 경로(`C:\Users\...`, 슬래시형 `C:/Users/...`, `/Users/...`, `/home/...`)를 `~`로 치환 후 500자 truncate (v0.18.23 슬래시형 Windows 경로 보강 — Node/pdf.js 정규화 경로의 드라이브 레터 잔존 차단) |
| 악성 파일 전량 로드 유도 | `PdfUploader` 가 `file.slice(0,5)` 로 `%PDF-` 매직바이트만 먼저 검사 — 전량 메모리 로드 전에 거부 |
| UTF-16 surrogate pair split | 청커·RAG 오버랩 모두 codepoint 단위 분할 (이모지/확장 CJK 안전) |
| 프롬프트 인젝션 (URL scheme) | Markdown allowlist: `https/http/mailto/#`, blocklist: `javascript:`/`data:`/`vbscript:`/`file:` |
| 인스톨러 변조 감지 (v0.18.8) | 빌드 산출물에 SHA-256 해시 자동 첨부 + Sigstore `attest-build-provenance` 발급 — `gh attestation verify` 로 빌드 출처 검증 가능 |
| Supply chain (CI 주입, v0.18.8) | GitHub Actions 의 third-party action (`actions/checkout`, `setup-node`, `softprops/action-gh-release`, `attest-build-provenance`) 을 모두 SHA pin — maintainer 계정 탈취 시 임의 코드 주입 차단 |
| 빌드 비결정성 (v0.18.8) | CI 가 `npm install` 대신 `npm ci` + lockfile 동기화 사용 — 동일 태그에서 transitive dep 변동으로 인한 NSIS/asar 해시 표류 차단 |
| Array OOB 회귀 (v0.18.8) | TypeScript `noUncheckedIndexedAccess: true` — 배열 인덱싱 결과를 `T \| undefined` 로 좁혀 컴파일 타임에 OOB 류 결함 차단 |
| Hallucination (v0.18.0) | Q&A 답변을 문장 단위로 분할 → RAG 인덱스 코사인 유사도 평가 → 약문장 다수 시 LLM 재정리. 다국어 종결부호 인식 + Latin/CJK mixed 경계 분리(v0.18.8) |
| 이미지 추출 OOM (v0.18.9) | `MAX_TOTAL_IMAGES=50` 캡이 배치 병렬 promise 들 사이에서 우회되던 race 를 수정 — 진입 시점과 push 직전 2단계 잔여 슬롯 검사로 한 번에 수십 장씩 base64 변환되는 폭주 차단 |
| IPC listener leak (v0.18.9) | `ai-client.summarize` 의 `onToken`/`onDone`/timer 등록을 `try/finally` 안으로 이동 — `generate()` 동기 throw 등 등록 도중 예외 발생 시에도 unsub 과 서버측 `abort` 가 반드시 호출 |
| CI 회귀 게이트 (v0.18.9) | 모든 workflow job 에 `timeout-minutes` 설정 (hung build 가 360분 burn 하던 가능성 차단), test job 에 Ubuntu+Windows OS matrix 적용 (Windows 경로/pwsh 회귀 사전 차단), `npx tsc --noEmit` 단계 PR/release 양쪽 강제 (strict 옵션 회귀 방지) |
| 미공증 macOS dmg 배포 (v0.18.9) | 코드사인/공증 자격 미구비 상태에서는 `build-mac` job 비활성화 — Gatekeeper 가 차단하는 unsigned dmg 가 사용자에게 배포되어 `xattr -d` 강제하는 상황을 사전 차단 |
| 셸 인용 fragility (v0.18.11) | `package.json` build 스크립트의 인라인 `node -e "..."` heredoc 을 `scripts/postbuild.mjs` 로 분리 — Windows PowerShell 인용 처리 표면 제거 + pdfjs-dist cmaps 경로 변경 시 진단 메시지 노출 |
| 알려진 취약점 가시성 (v0.18.11) | `test.yml` 에 `npm audit --audit-level=high` advisory 단계 추가 — 알려진 vulnerable 의존성(`vite`, `postcss`, `xmldom`, `ip-address` 등 dev-only)이 PR/push 마다 가시화되도록 함 (빌드는 막지 않는 advisory 출력) |
| GitHub Actions Node 20 deprecation (v0.18.11) | `actions/checkout` v4.2.2 → v6.0.2 / `actions/setup-node` v4.4.0 → v6.4.0 으로 SHA pin 갱신 — 2026-06-02 강제 마이그레이션 시한 이전에 Node.js 24 호환 메이저로 이전 |
| contributor 환경 ABI/lockfile drift (v0.18.11) | `package.json` 에 `engines: { node: ">=20.10 <23", npm: ">=10" }` 추가 — electron 41 node-gyp ABI 불일치나 npm v9 lockfile 포맷 차이로 인한 silent failure 사전 차단 |
| API 키 캐시 prototype pollution (v0.18.12) | `apiKeysCache` 를 `Object.create(null)` 위에 알려진 provider 키(`ollama`, `claude`, `openai`)만 화이트리스트 복사 — 디스크 변조 JSON 의 `__proto__` 키가 Object.prototype 을 오염시키는 경로 차단 |
| 임베딩 비용 amp DoS (v0.18.12) | `ai:embed` 핸들러에 `MAX_CONCURRENT_EMBED_REQUESTS=4` 캡 도입 — 손상/폭주 renderer 가 OpenAI 토큰 비용을 amp 하거나 Ollama 백엔드를 마비시키는 자기-DoS 경로 차단. 정상 RAG 인덱스 빌드(동시 in-flight 1~2개) 에는 영향 없음 |
| Ollama 인증서 검증 wildcard 오해석 (v0.18.12) | `Get-AuthenticodeSignature -FilePath` → `-LiteralPath` — 임시 경로/사용자명에 `[`, `*`, `?` 가 포함될 때 wildcard 로 해석되어 검증이 잘못된 경로를 보거나 설치가 DoS 되는 견고성 결함 해결 |
| 새 PDF 로드 시 stale 상태 누출 (v0.18.12) | `setDocument(newDoc)` 비-null 분기에서도 `resetSummaryState` 를 호출 — 호출자가 reset 가드를 잊는 새 호출 경로에서도 이전 문서의 `summary`/`qaMessages`/`pdfBytes`/RAG 인덱스가 누출되지 않도록 함 |
| 언어 전환 시 stale 라벨 (v0.18.12) | `ProgressBar` 의 모듈 레벨 `t()` → `useT()` 마이그레이션 — 진행 중 언어를 전환해도 다음 progress 업데이트를 기다리지 않고 즉시 새 언어로 라벨이 재렌더 |
| Markdown 링크 visual spoofing (v0.18.12) | `safe-markdown` 의 href 에 제어문자(`U+0000~U+001F`, `U+007F`) / bidi override(`U+202A~U+202E`, `U+2066~U+2069`) 포함 시 일률 차단 — LLM 응답이 표시 텍스트와 destination 을 시각적으로 위장하는 경로 차단 |
| onDone-후 거절 마이크로태스크 누락 (v0.18.13) | `ai-client.summarize` 의 메인 루프 종료 후 `await resultPromise.then(...)` 로 재확인 — `generate()` 의 거절이 `onDone` 직후 도착할 때 throw 가 동기 실행돼 사용자가 빈/부분 요약을 "성공" 으로 보던 race 차단 |
| 손상된 PDF op 의 페이지 단위 사일런트 손실 (v0.18.13) | `extractPageImages` 의 `argsArray[j]![0]` non-null 단언을 `Array.isArray + typeof` 가드로 교체 — 손상된 op 1개로 해당 페이지 이미지 9장이 silently 손실되던 결함 해결 |
| `activeEmbedRequests` 카운터 leak (v0.18.13) | 카운터 증가를 `try` 블록 안으로 이동 + `counted` 플래그 — controller 등록이 동기 throw 할 경우 카운터가 leak (4회 후 self-DoS) 되던 경로 차단 |
| 임베딩 `requestId` 재진입 시 `ai:abort` 무력화 (v0.18.13) | `registerEmbedRequest`/`unregisterEmbedRequest` 에 controller identity 체크 — 같은 `requestId` 재진입 시 이전 요청의 `finally` 가 새 요청 entry 를 무차별 삭제해 abort 가 작동하지 않던 결함 해결 |
| 제어바이트 정규식 가시성 결함 (v0.18.13) | `safe-markdown` 의 raw 제어바이트 정규식을 `new RegExp(...)` + `String.fromCharCode(...)` 로 교체 — grep 의 binary 분류와 에디터/linter normalization 으로 silently 보호가 사라질 risk 제거 |
| Postbuild 호환성 (v0.18.13) | `engines.node` `>=20.10` → `>=20.11` — `scripts/postbuild.mjs` 의 `import.meta.dirname` 요구를 충족하지 못해 Node 20.10 정확 매칭 시 throw 되던 결함 해결 |
| Packaged build CJK 글리프 (v0.18.13) | `electron-builder.asarUnpack: ["**/cmaps/**"]` 추가 — pdfjs CMap (`.bcmap`) 이 asar 내부에서 fetch 되지 않는 환경에서도 정상 동작하도록 보장 |
| .gitignore tracked+ignored 모순 (v0.18.13) | `CLAUDE.md` 를 `.gitignore` 에서 제거 — 체크인된 문서가 동시에 ignore 돼 contributor 가 `git status` 로 변경을 못 보던 모순 해소 |
| Vitest setup file collision (v0.18.13) | `test/setup.ts` 의 `vi.restoreAllMocks()` → `vi.clearAllMocks()` — file 레벨 mock 의 구현이 매 테스트마다 reset 되어 의도치 않은 collision 가능성 차단 |
| electron-builder schema 미준수 (v0.18.14) | 코멘트성 `//asarUnpack` 키 제거 — electron-builder 26.x 의 strict schema validation 이 알려지지 않은 키(`//` prefix 포함)를 거부해 v0.18.13 빌드가 실패했던 핫픽스 |
| Ollama cold-load 페널티 (v0.18.15, 성능) | `/api/generate` (텍스트 + Vision) / `/api/embed` 3곳 모두 `keep_alive: '30m'` 명시 — 기본 5분 후 모델 unload 로 발생하던 cold-load 페널티(수 초~수십 초) 제거. 한 세션의 청크 요약/통합/Q&A/검증/임베딩 연쇄 호출이 모두 warm cache |
| 단일 808KB renderer chunk (v0.18.15, 성능) | `electron.vite.config.ts` 의 `manualChunks` 로 vendor 분리 — main chunk 808 KB → 304 KB (62% 감소). app 코드 변경 시 vendor cache 유지 |
| 클라우드 Vision 동시성 부족 (v0.18.15, 성능) | `analyzeDocumentImages` provider-aware 동시성 (Ollama 3 / Claude·OpenAI 8) — 이미지 많은 PDF 의 클라우드 분석 시간 ~30-40% 단축 |
| PdfViewer bulk-render 메모리/지연 (v0.18.16, 성능) | sequential bulk render → `IntersectionObserver` 기반 on-demand 큐 (rootMargin '100% 0px' lookahead). 100p PDF 인용 클릭 시 렌더 canvas 가 ~5장만 활성 (기존 100장 대비 95% 감소). 500p PDF 메모리도 방문 페이지 수에 비례 |
| pdf-parser Promise.race 타이머 leak (v0.18.17) | `extractPageImages` 의 5s race timer 가 `getOperatorList()` 가 빨리 resolve 된 후에도 살아남아 200p PDF 기준 200개 pending timer + 200개의 오해 소지 있는 "timeout" 경고가 5초 뒤 폭주하던 leak 차단. `timeoutId` 를 `finally` 에서 `clearTimeout` |
| PdfViewer 리사이즈 후 viewport race (v0.18.17) | 리사이즈로 `renderVersion` 이 증가하면 IO 가 첫 콜백 발화 전 viewport 안 페이지가 빈 placeholder 로 잠시 보이던 race. 컨테이너 + `rootMargin: 100%` 영역과 교차하는 wrapper 들을 IO 와 별도로 즉시 enqueue |
| PdfViewer targetPage 폴링 stuck (v0.18.17) | target wrapper 가 IO viewport 밖이면 폴링이 IO 발화를 헛기다리다 3초 후 placeholder 200px 기준 부정확한 `scrollIntoView` 로 폴백하던 결함. `enqueueRenderRef` 로 enqueue 노출 + 폴링 시작 시 직접 호출 |
| 빈 image name op 1초 낭비 (v0.18.17) | `extractPageImages` 의 R29 가드를 `length > 0` 까지 좁힘 — `page.objs.get('')` 가 callback 미호출로 1s 타임아웃 낭비하던 dead path 사전 거절 |
| package-lock.json root version drift (v0.18.17) | lockfile root 가 `0.18.9` 에 박혀 7 릴리즈 불일치. 향후 contributor 의 `npm ci` 실패 위험. `npm install --package-lock-only` 로 동기화 + version-bump 워크플로에 반영 |
| Workflow node-version drift (v0.18.17) | `node-version: 20` (bare) ↔ `engines >=20.11` 불일치 (미래 cache 가 20.10 으로 떨어지면 violation). `'20.11'` 명시. `test.yml` 의 `npm audit` step 을 `\|\| true` → `continue-on-error: true` 로 교체해 진짜 실행 실패와 advisory 출력 구분 |
| Vision in-flight abort 미배선 (v0.18.18) | `analyzeImage` IPC 체인에 `requestId`/`AbortSignal` 추가 — Stop / 문서 전환 / 타임아웃 시 in-flight Vision (특히 Claude·OpenAI) 호출을 즉시 끊어 토큰 추가 청구 차단. `use-summarize` 가 in-flight requestId 추적 + `isGenerating` false 감지 시 폴링으로 `ai.abort` 전체 호출 |
| 일시 notice 영구 잔류 (v0.18.18) | `setNotice` 후 6초 자동 dismiss + 새 호출 시 이전 타이머 cancel — 다중 파일 드롭 안내 등이 파싱 완료 후에도 화면에 남던 UX 문제 해결 |
| `LOCALHOST_HOSTS` 4곳 drift 위험 (v0.18.18) | `['localhost','127.0.0.1','::1']` 인라인 리터럴 4곳을 `src/shared/constants.ts` 의 `LOCALHOST_HOSTS` + `isLocalhostHost` 헬퍼로 통합. 한쪽만 수정 시 SSRF 우회 발생할 수 있는 drift 위험 차단 |
| Bearer 토큰 redaction 누락 char (v0.18.18) | redaction regex 에 `~` 추가 — RFC 6750 token68 char class 와 일치시켜 토큰 접미부 누출 가능성 차단 (defense-in-depth) |
| `shell:open-external` 입력 길이 무캡 (v0.18.18) | URL parser 진입 전 2048 chars cap — 손상된 renderer 가 multi-MB URL 을 보내 parser 에 부담을 주는 경로 사전 차단 |
| 새 문서 로드 시 이전 페이지 잔존 (v0.18.18 patch) | PdfViewer 의 `pdfBytes` 변경 + `totalPages` 동일 시 React 가 wrapper DOM 을 재사용해 이전 문서 canvas 가 새 문서에 잠시 표시되던 회귀. render effect 진입 시 무조건 canvas 청소로 차단 |
| timedOut 후 summarize 재진입 race (v0.18.18 patch) | timeout 콜백이 abort 한 직후 summarize 가 새 requestId 를 발급하면 abort 가 무력화되던 race. 명시 가드로 즉시 종료 |
| `noticeDismissTimer` HMR 누락 (v0.18.18 patch) | 이전 store 인스턴스의 6초 타이머가 새 store 의 notice 를 잘못 dismiss 시도하던 leak. dispose 콜백에 `clearTimeout` 추가 |
| `ai:analyze-image` requestId 충돌 (v0.18.18 patch) | generate/embed/vision 이 같은 `activeRequests` Map 공유로 requestId 충돌 시 entry leak 가능. Vision 측을 `vision:` prefix 로 namespacing, `ai:abort` 가 양쪽 시도 |
| package-lock.json drift 재발 (v0.18.18 patch) | v0.18.17 가 약속한 자동화가 미구현으로 v0.18.18 도 drift 했던 결함. `test.yml`/`release.yml` 에 lockfile root version 검증 게이트 추가, 미일치 시 빌드 실패 |
| Packaged asar sourcemap 누설 가능성 (v0.18.19) | electron-builder `files` 에 `!**/*.map` negative glob 추가 — 미래에 sourcemap 가 실수로 켜져도 asar 에 누설되지 않도록 안전망 |
| `asarUnpack` glob 과넓음 (v0.18.19) | `**/cmaps/**` → `out/renderer/cmaps/**` 로 좁힘. 미래 의존성이 다른 `cmaps` 디렉터리를 가져와도 과넓게 unpack 되지 않음 |
| postbuild 실패 시 raw stack trace 노출 (v0.18.19) | `scripts/postbuild.mjs` 의 `cpSync` 를 try/catch 로 감싸 ENOENT/EACCES/EEXIST 등의 친절한 메시지 + 재시도 가이드 출력 |
| Switch fallthrough 컴파일 타임 미검출 (v0.18.19) | `tsconfig.json` 에 `noFallthroughCasesInSwitch` 활성 — main 의 settings:set 등 switch 의 fallthrough 가 컴파일 타임에 차단 |
| React 메소드 override 명시성 (v0.18.19) | `tsconfig.json` 에 `noImplicitOverride` 활성 — `Component` 의 state/componentDidCatch/render override 가 명시 키워드 요구. 잘못된 메소드 오버라이드를 컴파일 타임에 차단 |
| `npm audit` advisory 가시성 (v0.18.19) | `test.yml` 의 audit step 결과를 JSON 파싱해 `GITHUB_STEP_SUMMARY` 에 severity 별 카운트 출력. 이전엔 raw 로그에 묻혀 advisory 존재를 인지하기 어려웠음 |
| Q&A cross-session 토큰 contamination (v0.18.19 patch) | 문서 전환 시 `setDocument()` → `resetSummaryState()` 가 store 플래그만 비우고 main 의 in-flight AiClient generator 는 토큰을 계속 yield 하여, 사용자가 새 문서로 빠르게 질문하면 stale 세션 토큰이 새 세션의 `qaStream` 에 인터리브되던 race. `resetSummaryState` 가 in-flight `qaRequestId`/`currentRequestId` 모두에 `ai.abort` 직접 전파하여 root cause 차단 |
| 프롬프트 인젝션 — summary + assistant history (v0.18.19 patch) | `sanitizePromptInput` 이 사용자 질문/refine 질문/RAG 청크에만 적용되고 `[요약 내용]` 의 summary text 와 `formatHistory` 의 assistant 분기는 sanitize 되지 않아, 악성 PDF 가 LLM 을 유도해 답변/요약에 `\n[질문]\n` / `\n---\n` 마커를 포함시키면 후속 턴 프롬프트 구조가 오염되던 indirect prompt injection. 양쪽 모두 sanitize 통과 |
| PDF parse 오류 banner 경로 누출 (v0.18.19 patch) | `AppErrorBoundary` 의 `sanitizeErrorPath` 는 render-time exception 채널만 커버해, App.tsx drop/Ctrl+O 와 PdfUploader 에서 `setError({ message: err.message })` 로 banner 에 들어가는 경로가 pdfjs/main 의 절대경로를 그대로 노출했음. `setError` 자체에 `sanitizeErrorPath` 자동 적용 + `sanitizeErrorPath` 를 `error-sanitize.ts` 로 추출 (store 가 React 트리 미import) |
| OCR 클라우드 abort 미전파 (v0.18.19 patch) | R30 P2 가 `ai:analyze-image` 만 고치고 OCR 경로는 누락되어 클라우드 OCR `BATCH_SIZE=8` 에서 사용자 Stop 클릭이 다음 배치만 차단하고 in-flight 8건 (~90s/call) 의 토큰 청구는 끝까지 진행되던 결함. preload `ocrPage(base64, requestId?)` 시그니처 확장, main `ai:ocr-page` 핸들러에 `vision:` namespacing, `analyzeImageForOcr` signal 수용, pdf-parser per-page requestId + abort listener |
| CI audit step red CI 에서 invisible (v0.18.19 patch) | `npm test` 실패 시 후속 audit step 이 통째로 skip 되어 supply-chain 신호가 `GITHUB_STEP_SUMMARY` 에서 사라지던 결함. `if: always()` 추가하여 test 실패와 독립적으로 항상 출력 |
| Vision partial-failure stale enrichment (v0.18.19 patch) | 이미지 분석이 켜진 채로 모든 이미지가 실패해 `enrichedPagesRef` 가 null 인 경우 이전 run 에서 세팅된 `enrichedPageTexts` 가 store 에 남아 RAG 가 stale enriched 데이터로 검색하던 결함. 명시적 null 세팅으로 raw `pageTexts` 재빌드 강제 |
| 테마 라이브 preview localStorage drift (v0.18.19 patch) | SettingsPanel 라디오만 만져보고 X 로 닫으면 dirty preview 값이 영구 저장되어 settings.json 과 drift 발생. `applyTheme(theme, { persist?: boolean })` 시그니처로 persist 분리, preview 는 `persist:false` |
| MarkdownErrorBoundary latch (v0.18.19 patch) | 스트리밍 중 일시적 마크다운 파싱 오류 한 번으로 `hasError=true` 가 latch 되어 후속 토큰으로 완성된 답변까지 raw-text fallback 유지. `componentDidUpdate` 에서 children 변경 시 reset |
| OCR 클라우드 피크 메모리 (v0.18.19 patch) | `BATCH_SIZE=8` + 3000×3000 캔버스(~36MB RGBA each)가 50–100p PDF (`scale=1.5`) 에서 피크 ~250–300MB 일시 점유로 저사양 노트북 OOM 위험. 50–100p 구간만 BATCH_SIZE=4 로 축소 |
| `streamRequest` MAX_LINE_SIZE silent skip (v0.18.19 patch) | 1MB 초과 라인을 `continue` 로 건너뛰면 손상된 응답이 빈 답변으로 "성공" 보고되어 사용자가 빈 화면만 보던 결함. `safeReject` 로 명시 중단하여 ai-client 가 `streamInterrupted` 로 surface |
| Lockfile drift gate `packages[""]` 미검사 (v0.18.19 patch) | lockfileVersion 3 은 root `version` 과 `packages[""].version` 두 곳에 버전이 박혀 있는데 게이트는 root 만 검사하여 hand-edit 으로 둘이 어긋나면 `npm ci` 가 cache 키 무효화 + 경고를 발생시키는 채로 CI 그린이던 결함. 둘 다 검증 |
| Audit JSON 3× 재파싱 fragility (v0.18.19 patch) | 동일 audit JSON 을 3개 node spawn 으로 재파싱했고 `set +e` 와 결합돼 한 호출이 빈 문자열 반환 시 `[ "" -gt 0 ]` 가 silent 산식 오류 발생. `read HIGH MODERATE LOW <<<` 로 단일 spawn 통합 |
| PowerShell quote escape 테스트 부재 (v0.18.19 patch) | R15 H1 / R28 P2 가 발생했던 영역인데도 escape 로직에 unit test 0건. `ollama-manager.ts` 가 electron 을 import 하여 vitest 직접 import 불가 → helper 를 `src/main/ps-quote.ts` 로 분리 + 9 케이스 단위 테스트 |
| Q&A appendQaStream ghost-token race (v0.18.19 patch) | `clearQaStream` 직후 in-flight 루프가 추가 토큰을 흘려 cancelled placeholder 뒤에 잔여 토큰이 나타나던 race. `appendQaStream` 입구에 `isQaGenerating` 가드 추가 |
| `enrichedPageTexts` length-only fingerprint 충돌 (v0.18.19 patch) | useRagBuilder fingerprint 가 `e${length}` 만 사용해 길이가 같은 두 번째 Vision 패스가 재빌드 트리거 안 되던 결함. store 에 `enrichedPageTextsVersion` monotonic 카운터 추가 |
| `taskkill` 실패 silent 처리 (v0.18.19 patch) | 권한 거부 / AV / PID re-use race 시 ollama 자식 트리가 살아남아 port 11434 squat 하던 silent 결함. 실패 시 `SIGKILL` fallback + `console.warn` 으로 가시화 |
| `will-redirect` file:// 무차별 허용 (v0.18.19 patch) | 임의의 `file://` 리다이렉트를 통과시키던 가드를 정확한 packaged renderer URL 만 허용하도록 좁힘 (defense-in-depth) |
| i18n prototype 누출 (v0.18.19 patch) | `params['toString']` 같은 inherited 속성이 `String(...)` 으로 함수 소스를 템플릿에 주입할 수 있던 경로. `Object.prototype.hasOwnProperty.call` 로 own property 만 허용 |
| i18n production 미정의 키 raw 노출 (v0.18.19 patch) | `app.modelHint` 같은 내부 식별자가 사용자 UI 에 노출되던 결함. 마지막 dot-segment 만 fallback 으로 약화 |
| `ResizeHandle` Home/End ARIA 관례 반전 (v0.18.19 patch) | WAI-ARIA separator 관례 (`Home=MIN`, `End=MAX`) 와 반대로 매핑되어 스크린리더 사용자 예상 동작과 어긋나던 접근성 결함 swap |
| `safe-markdown` 헤딩·blockquote citation 미적용 (v0.18.19 patch) | `## 결론 [p.12]` 같이 헤딩/blockquote 에 인용이 들어간 경우 literal text 로 렌더되어 클릭 불가였음. `h1-h6` + `blockquote` 도 `renderWithCitations` 적용 |
| vitest 멀티 fork stub 충돌 위험 (v0.18.19 patch) | 다수 테스트가 모듈 init 에서 `vi.stubGlobal('window', { electronAPI: ... })` 호출하는데 default pool 의 다중 fork 가 같은 global 을 동시 stub 할 race 위험. `pool: 'forks'` 명시 + Vitest 4 deprecation 정리 |
| `ai-client.test` real timer flake 마진 (v0.18.19 patch) | 5/10/20ms 짧은 setTimeout 이 CI 부하 시 race flake 가능. 50/100ms 로 상향 |
| `release.yml` Ubuntu 플레이크가 Windows cancel (v0.18.19 patch) | `fail-fast: true` 였던 OS matrix 를 `false` 로 — Ubuntu test 한 건의 플레이크가 Windows 빌드를 cancel 해 재태깅이 필요한 비용 차단 |
| postbuild cmap 부분 복사 silent (v0.18.19 patch) | `cpSync` 가 ENOSPC / 중간 실패로 부분 복사된 채 빠져나오면 NSIS 가 깨진 cmap 세트로 패키징되어 사용자가 설치 후에야 CJK 글리프 깨짐을 발견하던 결함. 대표 cmap 3개 (`Adobe-Japan1-UCS2.bcmap`, `Adobe-Korea1-UCS2.bcmap`, `Adobe-GB1-UCS2.bcmap`) 존재 smoke check (R34 P2 에서 `Adobe-CNS1-UCS2.bcmap` 추가 — 번체 중국어 부분 누락 catch) |
| MarkdownErrorBoundary streaming reset thrash (v0.18.19 patch R34 P1) | R32 P2 가 추가한 `componentDidUpdate` 가 `children` identity 를 비교했는데 부모(SummaryViewer / QaChat) 가 매 렌더마다 JSX 로 새 `<ReactMarkdown>` 을 생성 → 매 렌더 reset trigger → 영구 오류 콘텐츠에서 latch ↔ reset thrash 가능. 비교 대상을 `fallbackText` (실제 content 문자열) 로 교체 — 일시 mid-stream 자연 회복은 보존, 매 렌더 reset 만 차단 (R33 Surface 3 P2) |
| `generate()` placeholder leak on sync throw (v0.18.19 patch R34 P1) | R32 P3 가 도입한 placeholder controller 가 `validateOllamaUrl` / `new URL()` / `API_KEY_MISSING` 동기 throw 시 `activeRequests` Map 에 남아 10분 TTL 까지 잔존하던 결함. try/catch + identity 일치 시에만 cleanup (R33 Surface 2 P3) |
| `will-redirect` Windows file:// slash 불일치 (v0.18.19 patch R34 P1) | R32 P3 가 추가한 `file://${path}` (2 슬래시) 가 Electron 의 실제 `file:///${path}` (3 슬래시, RFC 8089) 와 매치되지 않아 항상 false. `pathToFileURL(...).href` 로 표준 file URL 생성 (소문자 드라이브 / UNC / 백슬래시 정규화 함께) (R33 Surface 2 P4) |
| CI audit step `npm ci` 실패 후 거짓 보고 (v0.18.19 patch R34 P1) | R32 P2 가 도입한 `if: always()` 가 `npm ci` 실패 후 audit step 을 실행하는데, `node_modules` 부재 시 npm audit 이 error JSON 을 반환해 이전 파서가 `0 0 0` 으로 떨어뜨려 "취약점 없음" 으로 거짓 보고. 선행 `[ -d node_modules ]` 검사 + `j.error` 분기 + `: "${VAR:=0}"` 디폴트로 가시성 회복 (R33 Surface 4 P3) |
| `VALID_SETTINGS_KEYS` 양곳 drift 위험 (v0.18.19 patch R34 P2) | `main/index.ts` 의 `VALID_SETTINGS_KEYS_SET` (loadSettings 필터) 과 `VALID_SETTINGS_KEYS` (settings:set 검증) 가 별도 리터럴로 유지되어 한쪽만 갱신 시 silent drift 위험. `src/main/settings-keys.ts` 단일 출처 + 6-case drift 가드 (Set/Array 동치, `AppSettings` 타입 subset, `DEFAULT_SETTINGS` 양방향 커버, prototype key 차단, readonly tuple) (R33 Surface 4 P3) |
| Vision partial-failure 계약 단위 미검증 (v0.18.19 patch R34 P2) | R32 P3 의 "이미지 분석 켜진 채 모두 실패 → enrichedPages null → raw pageTexts 재빌드" 정책이 `use-summarize.ts` 내부 헬퍼라 단위 테스트 0건. `src/renderer/lib/enrich-doc.ts` 로 pure 함수 분리 + 11-case 가드 (size=0 ↔ null / size>0 ↔ non-null / 불변식 / mutation 방지) (R33 Surface 4 P3) |
| preload contextBridge IPC channel drift (v0.18.19 patch R34 P2) | `src/preload/index.ts` 가 electron 의존성으로 vitest 직접 import 불가했음. source 텍스트 정적 검사로 expose target / top keys / IPC channel 이름 / 핵심 시그니처 (ocrPage / embed / analyzeImage requestId) / openExternal 가드 / on* listener removeListener 9-case snapshot 가드 (R33 Surface 4 P3) |
| i18n own-undefined "undefined" 렌더 (v0.18.19 patch R34 P2) | R32 P3 의 `hasOwnProperty.call` 전환 후 own property 값이 `undefined` 인 경우 `String(undefined) = "undefined"` 가 UI 에 박혀 사용자가 missing param 임을 식별 못함. `hasOwnProperty` AND `=== undefined` 결합 (R33 Surface 3 P4) |
| pdf-parser OCR signal abort listener race (v0.18.19 patch R34 P2) | `signal.aborted` 체크 직후 `addEventListener('abort', ...)` 등록 전 abort 발화 시 late-attached listener 가 fire 안 해 IPC 가 그대로 진행되며 ~90s 토큰 비용. listener 등록 직후 `throwIfAborted` 재확인 (R33 Surface 2 P4) |
| RAG 청크 멀티페이지 라벨 인용 소실 (v0.18.21 R35) | 멀티페이지 RAG 청크에 범위 라벨 `[p.N-M]` 을 프롬프트에 주입하고 LLM 이 본문 인용 시 단일 `[p.N]` 으로 변환하도록 지시하던 결함. `CITATION_REGEX` 는 단일 라벨만 인식하므로 로컬 소형 모델이 변환 지시를 어기면 인용이 소실됐다. `formatPageLabel` 이 항상 청크 첫 페이지 기준 단일 `[p.N]` 만 방출하도록 변경해 Decision #6 을 코드로 강제 (R34 P3 의 회귀 라운드 catch) |
| 청크 페이지 귀속이 overlap tail 로 끌려가던 오류 (v0.18.21 R35) | RAG 청커가 overlap tail 영역까지 페이지 라벨 좌표 계산에 포함하여, body 가 페이지 N+1 에서 시작해도 tail 한 토큰이 페이지 N 에 닿으면 청크 라벨이 `[p.N]` 으로 잘못 귀속되던 결함. body 좌표 기준으로 전환하여 retrieval 좌표계(overlap 포함) 와 attribution 좌표계(body only) 분리 |
| `appendStream` ghost-token race 비대칭 (v0.18.21 patch R36 P1) | R32 P3 가 `appendQaStream` 입구에 추가한 `isQaGenerating` 가드가 요약 측 `appendStream` 에는 누락. 사용자 Stop → `handleAbort` → `setIsGenerating(false)` 직후 in-flight IPC for-await 가 다음 iteration 의 게이트 전에 토큰을 흘리면 `cleared=false` 로 reset 되어 50ms flush 가 ghost text 를 `summaryStream` 에 잔존시키던 경로. QA 측 패턴을 미러링하여 입구 게이트 대칭화 |
| `setEnrichedPageTexts` reference-equal no-op 미적용 (v0.18.21 patch R36 P2) | R32 P3 의 monotonic version 카운터는 fingerprint 가 길이 같은 두 번째 Vision 패스도 감지하게 했으나, 동일 reference (특히 반복적 null 호출) 도 매번 version 을 bump 하던 잠재 결함. 향후 `useRagBuilder` fingerprint 가 `r` 분기에서 version 을 포함하도록 바뀌면 즉시 false-positive 재빌드. `s.enrichedPageTexts === pages` 일 때 set 자체를 건너뛰는 멱등 가드 추가 |
| `splitIntoSentences` 인용 클러스터 false-positive 검증 (v0.18.21 patch R36 P2) | R35 의 single-label 도입 이후 `[p.5][p.6][p.7]` 같은 연속 인용 토큰이 늘어났는데, `\s+` 정규화 + 종결부호 split 으로 마침표 뒤 인용 클러스터가 별도 fragment 가 되어 15자 필터를 통과 → `verifyAnswerSentences` 의 임베딩 대상이 되며 weak score 를 양산하여 false-positive refine 트리거가 되던 경로. split 전에 `[p.N]` / `[p.N\|quote]` 토큰을 제거하여 본문 의미 기반 검증만 수행 |
| IPv6 loopback `http://[::1]` 가드 mismatch (v0.18.21 patch R36 P3) | WHATWG URL parser 가 `http://[::1]` 의 hostname 을 `[::1]` (괄호 포함) 으로 반환하지만 `LOCALHOST_HOSTS` 는 `::1` (괄호 없음) 만 보유해 IPv6 loopback 이 의도와 달리 차단되던 결함. Top5 #1 (validateOllamaUrl 단위 테스트) 작성 중 발견. `isLocalhostHost(hostname)` 헬퍼가 양끝 `[ ]` 정규화 후 비교하도록 수정하고, 4개 호출 지점(ai-service.validateOllamaUrl, index.ts 의 settings:set / ai:generate / ai:check-available) 을 `LOCALHOST_HOSTS.includes()` 직접 호출 → `isLocalhostHost()` 단일 헬퍼로 통일하여 향후 drift 위험도 함께 차단 |
| R36 P4 cosmetic/documentation 라운드 (v0.18.22) | 런타임 무영향 cleanup 3건: (1) pdf-parser `extractPageImages` 5s 타임아웃이 pdfjs `AbortSignal` 부재로 백그라운드 작업을 실제 취소하지 못하는 한계를 코멘트로 명시 — `Promise.race` 는 결과 selection 만 단축할 뿐 pdfjs 내부 op 파싱은 계속 진행되며 업스트림 abort 지원 도입 전까지 mitigation 영역 밖; (2) `use-summarize` cleanup useEffect 의 의도된 빈 deps 에 `eslint-disable-next-line react-hooks/exhaustive-deps` 가드 — 향후 reactive 외부 상태 추가 시 deps 누락이 stale closure 회귀를 유발할 가능성을 사전 차단; (3) `noticeDismissTimer` / `NOTICE_DISMISS_MS` 모듈 변수를 다른 디바운스 타이머 옆으로 이동 — 시각적 비대칭만 해소 (HMR dispose 핸들러의 closure 동작 동일) |
| isLocalhostHost RFC 3986 strict 정책 (v0.18.22 M1) | R36 P3 직후 24차 QA 라운드에서 발견. `isLocalhostHost('[localhost]')` / `isLocalhostHost('[127.0.0.1]')` 가 `true` 를 반환하던 결함 — RFC 3986 상 `[ ]` 는 IPv6 IP-literal 전용이다. WHATWG URL parser 가 `http://[localhost]` 같은 입력을 throw 하므로 IPC 경계 미도달이지만, 향후 raw-socket 호출자가 추가되면 비표준 입력이 통과하던 잠재 결함. brackets 안 내용에 `:` 이 없으면 즉시 false 반환하도록 strict 가드 추가 — RFC 3986 위반 입력의 fail-fast 차단. constants.test.ts 의 기존 `[localhost] === true` 단언 제거 + 신규 strict 회귀 가드 (5 assertions) 추가 |
| stripCitations 단일 source 통합 (v0.18.22 C-L1) | `use-qa.splitIntoSentences` (R36 P2-b) 의 인라인 strip 정규식 `[^\]]*?` (non-greedy) 과 `citation.CITATION_REGEX` 의 `[^\]]*` (greedy) 비대칭. 정상 입력에서는 `]` 가 종결자라 동일 동작이나, 향후 quote escape 정책 변경 시 silent skew 위험. `citation.ts` 에 `stripCitations(text)` 헬퍼 신규 export 하여 single source 화. g flag stateful lastIndex 누적 방지 위해 매 호출 fresh RegExp 복제 (`parseCitations` 와 동일 dispose 패턴). use-qa 가 헬퍼 호출로 교체, 9건 회귀 가드 추가 |

## 라이선스

MIT License. See [LICENSE](LICENSE) for details.
