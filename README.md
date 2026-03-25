# PDF 자료 요약기

**내 컴퓨터에서 직접 돌아가는 로컬 AI 기반 PDF 요약 도구입니다.**
클라우드 서비스와 달리, Ollama 로컬 AI 엔진을 사용해 PDF 파일이 외부 서버로 전송되지 않습니다.
강의자료, 논문, 보고서 등 어떤 PDF든 텍스트는 물론 **차트, 다이어그램, 표 등 삽입 이미지까지 Vision AI로 분석**하여 핵심 내용을 빠르게 파악할 수 있습니다.
필요에 따라 Claude, OpenAI 등 유료 API로 전환하여 더 높은 품질의 요약도 가능합니다.

---

## 다운로드 및 설치

> **[최신 버전 다운로드](https://github.com/wpdlf/summarize_PDF_files_locally/releases/latest)**

1. 위 링크에서 `PDF.자료.요약기.Setup.x.x.x.exe`를 다운로드합니다
2. 다운로드한 파일을 실행하여 설치합니다
3. 바탕화면 바로가기 또는 시작 메뉴에서 앱을 실행합니다
4. 첫 실행 시 AI 엔진(Ollama)과 한국어 특화 모델(gemma3, exaone3.5)이 자동 설치됩니다 — 안내를 따라 진행해주세요

> **참고**: AI 모델 다운로드에 약 8GB의 디스크 공간과 수 분의 시간이 필요합니다.

## 사용 방법

### 1. PDF 업로드
- 앱 화면에 PDF 파일을 **드래그앤드롭**하거나
- **파일 선택** 버튼을 클릭하여 PDF를 선택합니다

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

## AI Provider 선택

기본은 로컬 AI(Ollama)로 동작하며, 더 높은 품질의 요약이 필요하면 유료 AI를 사용할 수 있습니다.

| Provider | 특징 | 비용 |
|----------|------|------|
| **Ollama (기본)** | 오프라인 사용, 개인 자료 보안 | 무료 |
| **Claude API** | 높은 요약 품질, 긴 문서 처리에 강점 | 유료 (토큰당 과금) |
| **OpenAI API** | GPT-4o 기반, 범용적 요약 | 유료 (토큰당 과금) |

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

## 주요 특징

- **로컬 AI 기반** — Ollama 로컬 엔진으로 인터넷 없이 요약, PDF가 외부로 전송되지 않음
- **이미지 분석** — PDF 내 차트/다이어그램/표를 Vision AI로 분석하여 요약에 통합
- **한국어 최적화** — 한글 PDF 텍스트 추출 품질 개선, 한글 비율에 따른 청크 자동 조절
- **한국어 모델 자동 설치** — 첫 실행 시 gemma3, exaone3.5 한국어 특화 모델 자동 다운로드
- **유료 AI 지원** — Claude API, OpenAI API로 고품질 요약 가능
- **API 키 보안** — OS 키체인 암호화 + Main 프로세스에서만 복호화 (Renderer에 노출되지 않음)
- **개인 자료 보안** — Ollama 사용 시 PDF가 외부 서버로 전송되지 않음
- **요약 중단 가능** — 진행 중인 요약을 언제든 중단 가능, 5분 타임아웃 자동 abort
- **로딩 UX** — PDF 파싱 중/요약 생성 중 스피너 로딩 화면 표시
- **다크모드 지원** — 설정에서 라이트/다크/시스템 테마 선택
- **대용량 PDF 지원** — 긴 문서도 자동으로 나누어 처리 후 통합 요약 (배치 병렬 처리)
- **설정 저장** — 앱 재시작 후에도 설정 유지

## 시스템 요구 사항

- Windows 10 이상
- 디스크 공간 최소 8GB (AI 모델 저장용, Ollama 사용 시)
- 인터넷 연결 (첫 설치 시 및 유료 API 사용 시)

## 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| Ollama 설치 실패 | [ollama.com](https://ollama.com)에서 수동 설치하거나, "다른 AI Provider 사용" 버튼으로 Claude/OpenAI 전환 |
| 한국어 요약 품질이 낮음 | 설정에서 gemma3 또는 exaone3.5 모델이 선택되어 있는지 확인해보세요 |
| 요약이 느림 | 설정에서 경량 모델(phi3 등)로 변경하거나 청크 크기를 줄여보세요 |
| PDF 텍스트 추출 불가 | 스캔/이미지 기반 PDF는 지원하지 않습니다 (텍스트 PDF만 가능) |
| 이미지 분석이 안 됨 | Ollama 사용 시 llava 등 Vision 모델이 필요합니다. 설정에서 모델을 설치해주세요 |
| API 키 오류 | 설정에서 API 키가 올바른지 확인. Claude: `sk-ant-...`, OpenAI: `sk-...` |
| Claude/OpenAI 사용 불가 | API 키를 먼저 저장한 후 Provider를 선택해주세요 |

---

## 개발자 가이드

### 기술 스택

| 항목 | 기술 |
|------|------|
| 프레임워크 | Electron 34 + React 19 |
| 언어 | TypeScript (strict mode) |
| AI | Ollama (로컬) / Claude API / OpenAI API — Main 프로세스 IPC 기반 |
| PDF 파싱 | pdfjs-dist (위치 기반 텍스트 추출 + 이미지 추출, 한글 최적화) |
| 상태 관리 | Zustand |
| 스타일링 | Tailwind CSS v4 + @tailwindcss/typography |
| 빌드 | electron-vite + electron-builder (NSIS) |
| 테스트 | Vitest (19개 단위 테스트) |
| API 키 보안 | Electron safeStorage (OS 키체인 암호화), Main 프로세스에서만 복호화 |

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
npx vitest run
```

### 프로젝트 구조

```
src/
├── main/                 # Electron main process
│   ├── index.ts          # 앱 엔트리, IPC, 설정/API키 관리
│   ├── ai-service.ts     # AI API 호출 (스트리밍 요약 + Vision 이미지 분석)
│   └── ollama-manager.ts # Ollama 설치/시작/모델 관리
├── preload/
│   └── index.ts          # contextBridge API (ai, settings, apiKey, ollama, file)
└── renderer/             # React UI
    ├── App.tsx            # 루트 컴포넌트, 요약 로직
    ├── components/        # UI 컴포넌트 (8개)
    ├── lib/
    │   ├── ai-client.ts       # AI Client (IPC를 통해 Main에 요약 요청)
    │   ├── pdf-parser.ts      # PDF 텍스트 + 이미지 추출, 챕터 감지 (배치 병렬)
    │   ├── chunker.ts         # 텍스트 청크 분할 (한글 비율 자동 감지)
    │   ├── store.ts           # Zustand 상태 관리
    │   └── __tests__/         # 단위 테스트 (19개)
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
│   ├── Claude (HTTPS)     │        │ ├── SettingsPanel        │
│   └── OpenAI (HTTPS)     │        │ └── lib/                 │
│ Settings (JSON)          │        │     ├── AiClient (IPC)   │
│ API Keys (safeStorage)   │        │     ├── PdfParser        │
│ File I/O                 │        │     └── Zustand           │
└──────────────────────────┘        └──────────────────────────┘
         │                                     │
         │  ai:generate ──► Main에서 API 호출   │
         │  ai:token    ◄── 토큰 스트리밍        │
         │  ai:done     ◄── 완료 신호           │
         │  ai:abort    ──► 요청 중단           │
```

### AI 요약 흐름

1. Renderer에서 `ai:generate` IPC로 텍스트 + provider + model 전달
2. Main 프로세스가 `safeStorage`에서 API 키를 복호화하여 직접 API 호출
3. 스트리밍 토큰을 `ai:token` 이벤트로 Renderer에 전달
4. Renderer의 `AiClient`가 AsyncGenerator로 토큰을 yield

새 Provider를 추가하려면 `src/main/ai-service.ts`에 생성 함수를 추가하고 `generate()` switch문에 등록합니다.

## 라이선스

copyright 2026. JJW. All rights reserved.
