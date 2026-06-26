🌐 **한국어** | [English](README.md)

# 📄 로컬 AI PDF 분석기 (Local AI PDF Analyzer)

**개인 PC에서 직접 실행되는 로컬 AI 기반 PDF 요약 도구입니다.**

기존 AI 요약 서비스는 PDF를 외부 서버에 업로드해야 하지만, 이 앱은 **AI가 내 컴퓨터 안에서 실행**됩니다.

- **완전한 오프라인 동작** — Ollama 로컬 AI 엔진이 PC에서 직접 실행되어, PDF 파일이 외부 서버로 전송되지 않습니다
- **텍스트 + 이미지 통합 분석** — 텍스트는 물론 차트, 다이어그램, 표 등 삽입 이미지까지 Vision AI로 분석합니다
- **스캔 PDF OCR** — 이미지 기반 스캔 PDF도 Vision AI가 페이지별로 텍스트를 인식하여 분석합니다
- **RAG 기반 Q&A 채팅** — 임베딩 시맨틱 검색으로 질문과 가장 관련 높은 부분을 찾아 답변하고, 답변의 근거를 자동 검증합니다
- **페이지 인용 + 목차 네비게이션 PDF 뷰어** — 요약/답변에 `[p.12]` 출처 인용이 자동으로 붙어 클릭하면 PDF 원문의 해당 페이지가 바로 열리고, 문서에 내장된 목차(북마크)는 뷰어 사이드바에서 클릭해 해당 섹션으로 점프할 수 있습니다
- **다중 문서 탭 + 교차 문서 Q&A** — 여러 PDF를 탭으로 열고 한 번의 질문으로 함께 검색합니다. 답변은 출처 문서를 표기하고 해당 페이지로 바로 이동합니다
- **컬렉션 + 교차 문서 요약** — 함께 보는 문서 묶음을 이름과 함께 저장해 나중에 탭 세트째 다시 열고, 선택한 문서들의 통합 요약 또는 비교 분석을 생성합니다
- **세션 자동 저장·복원** — 분석한 PDF를 다시 열면 요약·Q&A·검색 인덱스가 재요약·재임베딩 없이 즉시 복원됩니다
- **전체 문서 검색** — 저장된 모든 문서를 가로질러 키워드를 한 번에 검색(페이지 텍스트+요약+파일명)하고 매칭된 페이지로 바로 이동합니다
- **개인 자료 걱정 없이 사용** — 시험자료, 사내 문서, 논문 초고 등 민감한 자료도 안심하고 요약할 수 있습니다
- **한국어/English UI · 외부 AI 전환** — 더 높은 품질이 필요하면 Claude/OpenAI/Gemini API로 간편하게 전환할 수 있습니다

이 문서는 두 부분으로 구성됩니다 — **[사용자 가이드](#사용자-가이드)** (설치 · 사용법 · 문제 해결) | **[개발자 가이드](#개발자-가이드)** (기술 스택 · 아키텍처 · 보안 설계)

---

# 사용자 가이드

## 다운로드 및 설치

> **[최신 버전 다운로드](https://github.com/wpdlf/local-pdf-analyzer/releases/latest)**

| 플랫폼 | 파일 |
|---|---|
| **Windows** | `Local-PDF-Analyzer-Setup-x.x.x.exe` |
| **macOS** | _일시 제외_ (코드사인/공증 자격 추가 후 복원 예정 — 그동안은 `npm run package` 소스 빌드로 사용 가능) |

1. 위 링크에서 Windows 설치 파일을 다운로드합니다
2. 다운로드한 파일을 실행하여 설치합니다
3. 바탕화면 바로가기 또는 시작 메뉴에서 앱을 실행합니다
4. 첫 실행 시 AI 엔진(Ollama)과 기본 AI 모델(gemma3) + RAG 임베딩 모델(nomic-embed-text)이 자동 설치됩니다 (약 3.6GB) — 안내를 따라 진행해주세요
5. 한국어 기반 자료를 주로 분석한다면 설치 화면의 **한국어 특화 모델(exaone3.5, 약 4.8GB) 함께 설치** 옵션을 체크하세요 — 한국어 요약 품질이 더 좋아집니다. 나중에 설정 → 모델 관리에서도 추가할 수 있습니다

<a id="smartscreen"></a>
> **Windows SmartScreen 안내**: EV 코드서명 인증서 미도입으로, 첫 설치 시 **"Windows의 PC 보호"** / **"알 수 없는 게시자"** SmartScreen 경고가 표시될 수 있습니다. 정상 동작이며, **추가 정보(More info) → 실행(Run anyway)** 으로 진행하세요. 인스톨러 진위는 아래 [무결성 검증](#인스톨러-무결성-검증)으로 확인할 수 있습니다.

> **참고**: AI 모델 다운로드에 기본 구성 약 3.6GB(한국어 특화 모델 포함 시 약 8.4GB)의 디스크 공간과 수 분의 시간이 필요합니다.

### 인스톨러 무결성 검증

각 릴리즈에는 인스톨러의 **SHA-256 해시**(`SHA256SUMS-windows.txt`)가 자산으로 첨부되며, GitHub Actions가 발급하는 **Sigstore build provenance attestation**으로 빌드 출처를 검증할 수 있습니다.

```bash
# Windows (PowerShell) — 해시 비교
Get-FileHash -Algorithm SHA256 .\Local-PDF-Analyzer-Setup-x.x.x.exe

# GitHub CLI 로 attestation 검증 (선택)
gh attestation verify ./Local-PDF-Analyzer-Setup-x.x.x.exe --repo wpdlf/local-pdf-analyzer
```

## 사용 방법

### 1. PDF 업로드
- 앱 화면에 PDF 파일을 **드래그앤드롭**하거나, **파일 선택** 버튼 또는 **Ctrl+O**로 선택합니다
- 이전에 분석한 PDF는 업로드 화면 하단 **최근 문서** 목록에서 바로 열 수 있고, 같은 PDF를 다시 열면 요약·Q&A·검색 인덱스가 **자동 복원**됩니다
- **저장 문서 전체 검색** — 업로드 화면의 검색바로 저장된 모든 세션(페이지 텍스트·요약·파일명)에서 키워드를 찾습니다. 결과에 매칭 페이지가 하이라이트 발췌로 표시되며, 클릭하면 바로 열립니다
- **여러 문서를 탭으로** — 새 PDF를 열면 상단에 탭이 추가되고, 탭 클릭으로 문서를 오가며 각각의 요약·Q&A를 이어서 사용할 수 있습니다 (전환 시 자동 저장·복원). `＋` 버튼으로 문서를 추가합니다

### 2. 요약 유형 선택

| 유형 | 설명 |
|------|------|
| **전체 요약** | PDF 전체 내용을 하나의 요약으로 정리 |
| **챕터별 요약** | 장/절 단위로 나누어 각각 요약 |
| **키워드 추출** | 핵심 키워드와 설명을 표로 정리 |

### 3. 결과 확인 및 저장
- 요약이 실시간으로 화면에 표시됩니다
- **`.md` 내보내기**·**PDF 내보내기**(헤딩/표/인용이 담긴 서식 PDF)로 파일 저장, **복사** 버튼으로 클립보드에 복사
- 요약 닫기는 비파괴적 — 문서 화면으로 접히고, **요약 보기 / Q&A 계속**으로 Q&A 스레드까지 그대로 다시 엽니다

### 4. Q&A 채팅 (RAG 시맨틱 검색)
- PDF 로드 시 자동으로 **RAG 벡터 인덱스**가 생성됩니다 (헤더에 진행률 → 완료 시 **RAG** 배지 표시)
- 질문하면 임베딩 유사도로 PDF에서 가장 관련 높은 부분을 찾아 AI가 답변합니다 (최대 10턴까지 이전 대화 맥락 유지)
- 임베딩 모델이 없으면 키워드 기반 검색으로 자동 전환됩니다 (기능 동일, 정확도 차이)
- **답변 자동 검증** — 답변의 각 문장을 PDF 임베딩에 대조하여, 근거가 약한 문장이 많으면 자동으로 한 번 더 다듬어 출력합니다 (설정에서 비활성화 가능)
- **교차 문서 Q&A (컬렉션 모드)** — 문서를 2개 이상 열면 **"여러 문서에 걸쳐 질문"** 토글이 나타납니다. 체크박스로 검색 대상을 고르면 선택한 각 문서의 인덱스에서 질문을 검색해 **재임베딩 없이** 병합합니다. 답변은 출처 문서를 표기하며(예: `[Service Discovery.pdf p.5]`), 인용을 클릭하면 해당 문서로 전환되며 그 페이지로 이동합니다. 임베딩 모델이 다른 문서는 사유와 함께 자동 제외됩니다.
- **교차 문서 요약 / 비교** — 컬렉션 모드에서 **통합 요약**·**비교 분석** 버튼으로 선택 문서들을 종합합니다. 각 문서의 기존 요약을 재사용하고, 아직 요약하지 않은 문서는 그 자리에서 요약해 해당 문서에 저장합니다(다음에 재사용). 결과는 Q&A 스레드에 문서별 출처로 표시됩니다.
- **컬렉션 저장·재오픈** — **컬렉션 저장**으로 현재 문서 묶음을 이름과 함께 저장하고, 업로드 화면의 **저장된 컬렉션** 목록에서 탭 세트를 한 번에 다시 엽니다(세션에서 복원 — 재파싱 없음).
- `Enter`: 전송 / `Shift+Enter`: 줄바꿈

### 5. 페이지 인용 + PDF 뷰어
- 요약과 Q&A 답변의 핵심 사실마다 **`[p.12]` 형태의 페이지 인용**이 자동으로 붙습니다
- 인용을 **클릭**하면 화면 우측에 **PDF 뷰어 패널**이 열려 해당 페이지로 바로 이동합니다 — AI 환각 여부를 1-click으로 검증할 수 있습니다
- **목차 네비게이션** — PDF에 내장 목차(북마크)가 있으면 뷰어의 ☰ 버튼으로 목차 사이드바가 열리고, 항목을 클릭하면 해당 페이지로 이동합니다(현재 섹션을 다시 클릭하면 재스크롤)
- 중앙 구분선을 드래그하거나 키보드(Tab 포커스 후 `←`/`→`, `Home`/`End`)로 좌/우 비율을 20~80% 사이로 조정할 수 있고, 비율은 저장되어 재시작 시 복원됩니다
- `ESC` 또는 ✕ 버튼으로 패널을 닫습니다

## AI Provider 선택

기본은 로컬 AI(Ollama)로 동작하며, 더 높은 품질의 요약이 필요하면 유료 AI를 사용할 수 있습니다.

| Provider | 특징 | 비용 |
|----------|------|------|
| **Ollama (기본)** | 오프라인 사용, 개인 자료 보안 | 무료 |
| **Claude API** | 높은 요약 품질, 긴 문서 처리에 강점 | 유료 (토큰당 과금) |
| **OpenAI API** | GPT-4o 기반, 범용적 요약 | 유료 (토큰당 과금) |
| **Google Gemini API** | 요약·Vision·임베딩을 한 키로 모두 지원 | 무료 티어 제공 (한도 초과 시 유료) |

외부 AI를 사용하려면:
1. 설정(⚙️) → AI Provider에서 Claude, OpenAI 또는 Gemini 선택
2. API 키 입력 후 **저장** (키는 암호화되어 로컬에 저장됩니다)
3. 모델 선택 후 **설정 저장**

### Q&A 임베딩 모델 (RAG)

| Provider | 임베딩 모델 | 차원 | 비고 |
|----------|------------|------|------|
| **Ollama** | nomic-embed-text (274MB) | 768 | 로컬 실행, 첫 실행 셋업 시 자동 설치 |
| **OpenAI** | text-embedding-3-small | 1536 | API 키로 자동 사용, 추가 설치 불필요 |
| **Gemini** | gemini-embedding-2 | — | API 키로 자동 사용, 추가 설치 불필요 |
| **Claude** | Ollama fallback | — | 자체 임베딩 API 없음, Ollama 모델 사용 시도 → 불가 시 키워드 검색 |

> 임베딩 모델이 없어도 Q&A는 키워드 기반 검색으로 동작합니다. RAG는 정확도를 높이는 선택적 기능입니다.

## PDF 이미지 분석

PDF에 포함된 차트, 다이어그램, 표, 사진 등을 Vision AI가 자동으로 분석하여 요약에 포함합니다.

- PDF 페이지에서 이미지를 개별 추출하여 Vision 모델로 의미 분석
- 분석 결과가 해당 페이지 텍스트에 자연스럽게 통합되어 요약 품질 향상
- 설정에서 이미지 분석 on/off 가능

| Provider | Vision 모델 | 비고 |
|----------|------------|------|
| **Ollama** | llava, llama3.2-vision | 로컬 실행, 미설치 시 자동 안내 |
| **Claude** | claude-sonnet-4 | API 비용 발생 |
| **OpenAI** | gpt-4o | API 비용 발생 |
| **Gemini** | 선택한 Gemini 모델 (전 모델 멀티모달) | 무료 티어 제공 |

> Ollama 사용 시 Vision 모델(llava 등)이 별도로 필요합니다. 설정 → 모델 관리에서 설치할 수 있습니다.

## 스캔 PDF OCR

텍스트를 추출할 수 없는 이미지 기반/스캔 PDF에서 Vision AI가 페이지별로 텍스트를 자동 인식합니다.

- 텍스트 추출 실패 시 자동으로 OCR fallback 진입 (설정에서 on/off 가능)
- 배치 병렬 처리 + 진행률 표시, 진행 중 언제든 취소 가능
- OCR로 처리된 문서에는 `OCR` 배지가 표시됩니다

| Provider | OCR 정확도 (한국어) | 비고 |
|----------|-------------------|------|
| **Claude** | 90~98% | 표/수식 구조 인식 포함, API 비용 발생 |
| **OpenAI (GPT-4o)** | 90~95% | 표/수식 구조 인식 포함, API 비용 발생 |
| **Gemini** | 90~97% | 표/수식 구조 인식 포함, 무료 티어 제공 |
| **Ollama (llava)** | 60~75% | 무료, 간단한 영문 PDF에 적합 |

> 스캔 PDF의 페이지 수에 따라 처리 시간과 API 비용이 증가합니다. 50페이지 기준 Claude 약 $0.15~0.30, GPT-4o 약 $0.25~0.50입니다.

## 주요 특징

**분석 품질**
- 한국어 최적화 — 한글 PDF 텍스트 추출 품질 개선, 한글 비율에 따른 청크 자동 조절
- 깔끔한 요약 — AI가 생성하는 인사말·감상평·대화형 멘트를 프롬프트 제약 + 후처리 필터로 이중 제거
- 대용량 PDF 지원 — 긴 문서도 자동 분할 후 배치 병렬 처리, 통합 요약 생성 (최대 500페이지)
- 답변 자동 검증 — Q&A 답변을 문장 단위로 PDF 임베딩에 대조, 근거 약한 답변은 자동 재정리

**사용성**
- 실시간 스트리밍 — 요약이 생성되는 즉시 표시, 자동 스크롤 (직접 스크롤하면 멈춤)
- 모든 장시간 작업 취소 가능 — 요약/파싱/OCR 중단, Ollama 설치 중도 취소 후 다른 Provider 전환
- 파싱 중 파일 교체 — 분석 도중 다른 파일을 드롭하면 이전 작업을 자동 취소하고 새 파일로 전환
- 요약 내보내기 — 마크다운, 서식 PDF(네이티브·무의존성), 클립보드 복사. Q&A 답변도 개별 복사 가능
- 전체 문서 검색 — 저장된 모든 문서의 페이지 텍스트·요약·파일명에서 키워드 검색, 하이라이트 발췌 + 원클릭 열기
- 다중 문서 탭 — 여러 PDF를 열어두고 전환, 무거운 상태는 활성 문서만 메모리에 유지(전환 시 세션 복원으로 즉시). 컬렉션 모드로 열린 문서들에 걸쳐 한 번에 질문하고 출처를 표기, 묶음을 이름으로 저장하고 통합/비교 요약 생성
- PDF 목차 네비게이션 — 내장 목차가 있는 문서는 뷰어에 접이식 목차 사이드바가 표시되어 원클릭으로 원하는 섹션으로 점프
- 다크모드, 한국어/English 즉시 전환 — 첫 실행 시 OS 언어 자동 감지, 설치 화면 우상단 토글로 바로 변경 가능, 스크린 리더·키보드 접근성

**안정성 · 보안**
- API 키 OS 키체인 암호화 — Main 프로세스에서만 복호화, 화면(Renderer)에 노출되지 않음
- 세션 자동 저장·복원 — 문서 해시 기준 복원, 최대 30개/200MB LRU 자동 정리 (설정에서 끄기/비우기 가능)
- 페이지 단위 손상 복원력 — 깨진 페이지가 있어도 나머지 페이지는 계속 처리
- 렌더 오류 복구 — 예기치 못한 UI 오류 시 "다시 시도" 버튼으로 재시작 없이 복구

**품질 보증**
- 단위 테스트 1288건 + Playwright E2E + CI 품질 게이트, 릴리즈마다 4-에이전트 병렬 QA 수행
- 빌드 무결성 — 인스톨러 SHA-256 해시 + Sigstore attestation 자동 게시
- 상세 개선·수정 이력: [docs/HISTORY.md](docs/HISTORY.md)

## 시스템 요구 사항

- **Windows 10 이상** 또는 **macOS 12 (Monterey) 이상**
- 디스크 공간 최소 4GB (기본 AI 모델 기준, Ollama 사용 시 — 한국어 특화 모델 포함 시 약 9GB)
- 인터넷 연결 (첫 설치 시 및 유료 API 사용 시)
- PDF 제한: 최대 100MB, 최대 500페이지 (초과 시 문서 분할 권장)

## 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| Ollama 설치 실패 | [ollama.com](https://ollama.com)에서 수동 설치하거나, 설치 마법사의 "취소하고 다른 Provider 사용" 버튼으로 Claude/OpenAI/Gemini 전환 |
| 요약 시작 버튼이 비활성화됨 | Ollama가 실행 중이 아니거나 설치된 모델이 없습니다 — 버튼 옆 **설정 열기** 링크로 해결하거나 클라우드 Provider로 전환하세요 |
| 한국어 요약 품질이 낮음 | 한국어 특화 모델(exaone3.5)을 설정 → 모델 관리에서 설치 후 선택해보세요. 첫 설치에서 선택 설치 옵션이며, 기본 모델(gemma3)보다 한국어 요약 품질이 좋습니다 |
| 요약이 느림 | 설정에서 경량 모델(phi3 등)로 변경하거나 청크 크기를 줄여보세요 |
| PDF 텍스트 추출 불가 | 설정에서 "스캔 PDF OCR"이 활성화되어 있는지 확인하세요. Vision 모델(llava, Claude, GPT-4o, Gemini)이 필요합니다 |
| OCR 결과가 부정확함 | Ollama llava는 한국어 정확도가 낮습니다. Claude, OpenAI 또는 Gemini로 전환하면 정확도가 크게 향상됩니다 |
| OCR이 너무 오래 걸림 | 진행 중 "■ 취소" 버튼으로 중단할 수 있습니다. 클라우드 provider로 전환하면 더 빠릅니다 |
| PDF가 500페이지 초과 | 수동으로 문서를 분할한 후 다시 업로드해주세요. 자원 폭주 방지를 위해 상한이 적용됩니다 |
| 이미지 분석이 안 됨 | Ollama 사용 시 llava 등 Vision 모델이 필요합니다. 설정에서 모델을 설치해주세요 |
| API 키 오류 | 설정에서 API 키가 올바른지 확인. Claude: `sk-ant-...`, OpenAI: `sk-...`, Gemini: `AIza...` |
| Claude/OpenAI/Gemini 사용 불가 | API 키를 먼저 저장한 후 Provider를 선택해주세요 |
| Gemini에서 "응답이 차단되었습니다" 에러 | Gemini 안전 필터가 문서 내용을 차단했거나 출력 한도를 초과한 경우입니다. 다른 모델(gemini-2.5-pro 등)로 바꾸거나 문서를 분할해보세요 |
| Gemini "요청 한도를 초과했습니다 (rate limit)" | 무료 티어는 분당 요청 수 제한이 낮습니다. 앱이 자동으로 동시 요청을 줄이고 최대 2회 재시도하지만, 계속 발생하면 잠시 후 다시 시도하거나 이미지가 많은 PDF는 이미지 분석을 끄고 사용해보세요 |
| Q&A에서 답변을 못 함 | RAG 배지가 없으면 `ollama pull nomic-embed-text`로 임베딩 모델을 설치하세요. 키워드 모드에서는 질문에 구체적 용어를 포함해주세요 |
| RAG 인덱싱이 안 됨 | 첫 실행 셋업을 완료했는지 확인하세요 (nomic-embed-text 자동 설치). 수동 설치: `ollama pull nomic-embed-text` |
| 답변이 두 번 생성되는 듯한 지연이 있음 | 답변 자동 검증이 근거 약한 답변을 다듬을 때 LLM 호출이 한 번 더 발생합니다. 설정에서 "답변 검증" 토글을 끌 수 있습니다 |
| 최근 문서에서 열었는데 PDF 뷰어가 안 뜸 | 요약·Q&A 분석은 복원되지만, 원본 파일이 이동/삭제되었으면 뷰어 렌더는 비활성화됩니다. 원본을 다시 열면 뷰어도 복구됩니다 |
| 저장된 세션이 디스크를 너무 많이 차지함 | 최대 30개/200MB까지만 보관하고 초과 시 오래된 것부터 자동 삭제됩니다. 설정 → "세션 데이터"에서 용량 확인 및 "전체 비우기" 가능 |
| 화면 오류로 앱이 멈춤 | 오류 화면의 "다시 시도" 버튼으로 재시작 없이 복구를 시도할 수 있습니다 |
| 인스톨러가 변조됐는지 확인하고 싶음 | 릴리즈 페이지의 `SHA256SUMS-windows.txt` 해시와 비교하거나, `gh attestation verify`로 Sigstore provenance를 검증하세요 ([무결성 검증](#인스톨러-무결성-검증) 참고) |
| macOS 다운로드가 보이지 않음 | 코드사인/공증 자격이 갖춰질 때까지 dmg 출시를 일시 중단했습니다. 그동안은 소스에서 `npm run package`로 직접 빌드해 사용하실 수 있습니다 |

> 과거 버전에서 수정된 문제들의 상세 이력은 [docs/HISTORY.md](docs/HISTORY.md)와 [GitHub Releases](https://github.com/wpdlf/local-pdf-analyzer/releases)를 참고하세요.

---

# 개발자 가이드

## 기술 스택

| 항목 | 기술 |
|------|------|
| 프레임워크 | Electron 42 + React 19 |
| 언어 | TypeScript (strict mode, `noUncheckedIndexedAccess` 등 활성) |
| AI 생성 | Ollama (로컬) / Claude API / OpenAI API / Gemini API — Main 프로세스 IPC 기반 |
| AI 임베딩 (RAG) | Ollama /api/embed / OpenAI /v1/embeddings / Gemini batchEmbedContents — 인메모리 벡터 스토어 |
| PDF 파싱 | pdfjs-dist (위치 기반 텍스트 추출 + 이미지 추출, 한글 최적화) |
| 상태 관리 | Zustand |
| 스타일링 | Tailwind CSS v4 + @tailwindcss/typography |
| 빌드 | electron-vite + electron-builder (Windows NSIS — macOS DMG는 공증 자격 확보 시까지 일시 중단) |
| 테스트 | Vitest 단위 테스트 1288건/80파일 (renderer·shared 857 + main 431) + Playwright E2E (CI-결정적 8건) + `tsc --noEmit` 타입 체크 + CI 커버리지 게이트 (77/69/79/81) |
| 다국어 (i18n) | 자체 구현 (i18n.ts) — 290+ 키, useT() 훅, 템플릿 치환 |
| API 키 보안 | Electron safeStorage (OS 키체인 암호화), Main 프로세스에서만 복호화 |
| 공유 상수 | `src/shared/constants.ts` — Main/Renderer 공유 (MAX_PDF_SIZE 등 drift 방지) |

## 개발 환경 설정

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

# E2E 스모크 (빌드 후 실제 Electron 기동 — Playwright)
npm run test:e2e
```

## 프로젝트 구조

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
    ├── components/        # UI 컴포넌트 (16개)
    ├── lib/
    │   ├── ai-client.ts       # AI Client (IPC를 통해 Main에 요약/Q&A 요청)
    │   ├── pdf-parser.ts      # PDF 텍스트 + 이미지 추출, 챕터 감지, OCR fallback
    │   ├── chunker.ts         # 텍스트 청크 분할 (한글 비율 자동 감지)
    │   ├── i18n.ts             # 다국어 번역 (290+ 키, t() 함수, useT() 훅)
    │   ├── use-qa.ts          # Q&A 채팅 훅 (RAG 시맨틱 검색 + 키워드 fallback, 대화 이력)
    │   ├── vector-store.ts    # 인메모리 벡터 스토어 (코사인 유사도 검색, 차원 검증)
    │   ├── store.ts           # Zustand 상태 관리 (요약 + Q&A + RAG 인덱스)
    │   └── __tests__/         # 단위 테스트 (1288건, 80 파일)
    └── types/
        └── index.ts       # 타입 정의 + Provider 모델 상수
```

## 아키텍처

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

## 데이터 처리 파이프라인

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

추가로, 문서 콘텐츠 해시(SHA-256) 기준으로 요약·Q&A·파싱 텍스트는 JSON, 임베딩 인덱스는 Float32 바이너리 블롭으로 `userData/sessions/`에 영속화됩니다(원자적 tmp→rename, LRU 최대 30개/200MB). 같은 PDF 재오픈 시 해시 매칭으로 복원하고, 임베딩 모델·차원이 일치하면 인덱스를 역직렬화해 재임베딩·재요약 호출이 발생하지 않습니다.

## AI 요약 프롬프트 설계

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

## 보안 설계

현재 적용 중인 위협 모델과 대응입니다. 버전별 상세 수정 이력은 [docs/HISTORY.md](docs/HISTORY.md)를 참고하세요.

| 영역 | 대응 |
|------|------|
| API 키 보호 | `safeStorage`(OS 키체인) 암호화, Main 프로세스에서만 복호화, Renderer에 키 미전달, prototype pollution 차단(`Object.create(null)` + provider 화이트리스트) |
| SSRF | Ollama URL은 localhost만 허용(`isLocalhostHost` — IPv6 `[::1]` 정규화 포함), `ai:check-available` 등은 renderer 전달 URL 대신 설정 store의 정규 URL만 사용해 포트 프로브 오라클 차단 |
| IPC 입력 검증 | 모든 IPC 핸들러에서 타입/범위/길이 검증, 공유 상수 모듈(`src/shared/constants.ts`)로 main/renderer drift 방지 |
| 파일 접근 | `.pdf` 확장자 + `%PDF-` 매직바이트 선행 검사 + `lstat` 심볼릭링크 거부 + 100MB 캡. 세션 디렉토리는 콘텐츠 해시(`/^[a-f0-9]{64}$/` 화이트리스트)로 식별해 경로 traversal 차단 |
| 네비게이션/권한 | `will-navigate` + `will-redirect` 차단(packaged renderer URL만 허용), 권한 요청/조회 기본 거부(`clipboard-sanitized-write`만 예외), 프로덕션 DevTools 비활성화, 외부 URL은 정확 호스트명 화이트리스트 |
| Markdown/XSS | URL scheme allowlist(`https/http/mailto/#`), `javascript:`/`data:` 등 차단, 제어문자·bidi override 차단, 외부 이미지 차단 |
| PDF 내보내기 | 요약 HTML을 앱 내 마크다운과 동일하게 새니타이즈(raw HTML/스크립트 차단, 스킴 화이트리스트) 후, 잠금 오프스크린 창(Node 차단·sandbox·JS 비활성)에서 인쇄 |
| CSP | `script-src`에서 `unsafe-inline` 제거(FOUC 방지 스크립트만 sha256 화이트리스트), `frame-src/child-src/base-uri/form-action` 차단 |
| 프롬프트 인젝션 | 사용자 질문/RAG 청크/요약 텍스트/대화 이력 모두 `sanitizePromptInput` 적용, OCR·Vision 프롬프트에 "이미지 내 지시사항 무시" 명시 |
| 환각 완화 | Q&A 답변을 문장 단위로 분할 → RAG 임베딩 코사인 유사도 평가 → 약한 문장 다수 시 LLM 재정리 (다국어 종결부호 + Latin/CJK mixed 경계 인식) |
| 리소스 상한 | 스트리밍 50MB / Vision 10MB / 에러 바디 64KB / PDF 100MB·500페이지 / 이미지 50장 캡 / 임베딩 동시 4건 / 대화 이력 4000자·10턴 / URL 2048자 |
| RAG 무결성 | IPC 경계 NaN/Infinity 검증, 벡터 차원 고정(첫 청크 lock), 문서 전환 시 AbortController로 이전 빌드 취소 + docId 최종 검증 |
| 프로세스 안정성 | `requestSingleInstanceLock` 이중 인스턴스 차단, Ollama 자식 프로세스 추적·종료(taskkill + SIGKILL fallback), 네트워크 단절 시 스트림 `close` 즉시 감지 |
| 인스톨러/공급망 | Ollama 인스톨러 Authenticode 서명 검증, GitHub Actions third-party action SHA pin, `npm ci` + lockfile 동기화 게이트, 인스톨러 SHA-256 + Sigstore attestation 발급, sourcemap asar 제외 |

## 품질 보증

- **단위 테스트 1288건 / 80파일** — renderer·shared 857 + main 431. 메인 프로세스는 electron 모킹 하니스로 IPC 핸들러·OllamaManager·API 키 저장소·ai-service·전체 문서 검색까지 행위 테스트, 렌더러/preload 레이어(컴포넌트 16종 전수 + use-summarize/use-session/pdf-parser/safe-markdown 등 핵심 라이브러리 + preload 브리지)는 happy-dom 으로 행위 테스트
- **Playwright E2E** — 실제 Electron 빌드를 구동하는 CI-결정적 테스트 8건(콜드 스타트 위자드·PDF 파싱·세션/설정 재시작 복원·업로드 에러 경로), 전부 AI 비의존, 멀티탭 복원과 요약/Q&A/컬렉션은 로컬-전용 Ollama 스펙으로 커버
- **CI 게이트** — `tsc --noEmit`(strict, e2e 전용 타입체크 프로젝트 포함), 커버리지 임계(77/69/79/81) 강제, lockfile 버전 동기화 검증, `npm audit` advisory, Node 22/24 매트릭스
- **4-에이전트 병렬 QA** — 릴리즈마다 전체 코드베이스 QA 라운드 수행, 48+ 라운드 연속 Critical 0건 (검출된 High/Important 는 릴리즈 전 즉시 수정 — 예: R41 이 v0.19.0 의 세션 손상 High 를 사전 차단; 최근 라운드는 Low/코스메틱만 검출 — 가장 최근 라운드는 교차 문서 요약 경로로 수렴해 v0.31.3 로 수정 출시)
- 상세 개선·수정 이력: [docs/HISTORY.md](docs/HISTORY.md)

## 라이선스

MIT License. See [LICENSE](LICENSE) for details.
