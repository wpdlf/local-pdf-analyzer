# PDF 자료 요약기

PDF 파일을 AI가 자동으로 요약해주는 데스크톱 애플리케이션입니다.
강의자료, 논문, 보고서 등 어떤 PDF든 핵심 내용을 빠르게 파악할 수 있습니다.

---

## 다운로드 및 설치

> **[최신 버전 다운로드](https://github.com/wpdlf/summary_lecture_material/releases/latest)**

1. 위 링크에서 `PDF.자료.요약기.Setup.x.x.x.exe`를 다운로드합니다
2. 다운로드한 파일을 실행하여 설치합니다
3. 바탕화면 바로가기 또는 시작 메뉴에서 앱을 실행합니다
4. 첫 실행 시 AI 엔진(Ollama)이 자동 설치됩니다 — 안내를 따라 진행해주세요

> **참고**: AI 모델 다운로드에 약 4GB의 디스크 공간과 수 분의 시간이 필요합니다.

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

## 주요 특징

- **오프라인 사용 가능** — 모든 AI 처리가 내 컴퓨터에서 실행됩니다
- **개인 자료 보안** — PDF가 외부 서버로 전송되지 않습니다
- **다크모드 지원** — 설정에서 라이트/다크/시스템 테마 선택
- **대용량 PDF 지원** — 긴 문서도 자동으로 나누어 처리 후 통합 요약

## 시스템 요구 사항

- Windows 10 이상
- 디스크 공간 최소 4GB (AI 모델 저장용)
- 인터넷 연결 (첫 설치 시에만 필요)

## 문제 해결

| 증상 | 해결 방법 |
|------|----------|
| Ollama 설치 실패 | [ollama.com](https://ollama.com)에서 수동 설치 후 앱 재실행 |
| 요약이 느림 | 설정에서 경량 모델(phi3 등)로 변경하거나 청크 크기를 줄여보세요 |
| PDF 텍스트 추출 불가 | 스캔/이미지 기반 PDF는 지원하지 않습니다 (텍스트 PDF만 가능) |

---

## 개발자 가이드

### 기술 스택

| 항목 | 기술 |
|------|------|
| 프레임워크 | Electron 34 + React 19 |
| 언어 | TypeScript (strict mode) |
| AI | Ollama (로컬 LLM), Provider 추상화로 확장 가능 |
| PDF 파싱 | pdfjs-dist |
| 상태 관리 | Zustand |
| 스타일링 | Tailwind CSS v4 + @tailwindcss/typography |
| 빌드 | electron-vite + electron-builder (NSIS) |
| 테스트 | Vitest (24개 단위 테스트) |

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
│   ├── index.ts          # 앱 엔트리, IPC 핸들러, 설정 저장
│   └── ollama-manager.ts # Ollama 설치/시작/모델 관리
├── preload/
│   └── index.ts          # contextBridge API
└── renderer/             # React UI
    ├── App.tsx            # 루트 컴포넌트, 요약 로직
    ├── components/        # UI 컴포넌트 (8개)
    ├── lib/               # 비즈니스 로직
    │   ├── ai-client.ts       # AI Client (Provider 패턴)
    │   ├── ai-provider.ts     # Ollama Provider 구현
    │   ├── pdf-parser.ts      # PDF 텍스트 추출 + 챕터 감지
    │   ├── prompts.ts         # 요약 프롬프트 템플릿 (3종)
    │   ├── chunker.ts         # 텍스트 청크 분할
    │   ├── store.ts           # Zustand 상태 관리
    │   └── __tests__/         # 단위 테스트 (24개)
    └── types/
        └── index.ts       # TypeScript 타입 정의
```

### 아키텍처

```
Electron Main Process          Renderer Process (React)
┌──────────────────┐          ┌──────────────────────┐
│ OllamaManager    │◄── IPC ─►│ App.tsx              │
│ Settings (JSON)  │          │ ├── PdfUploader      │
│ File I/O         │          │ ├── SummaryViewer    │
└──────────────────┘          │ ├── SettingsPanel    │
                              │ └── lib/             │
        Ollama                │     ├── AiClient     │
  (localhost:11434)           │     ├── PdfParser    │
┌──────────────────┐          │     └── Zustand      │
│ llama3.2 / phi3  │◄── HTTP ─┤                      │
└──────────────────┘          └──────────────────────┘
```

### AI Provider 확장

`AiProvider` 인터페이스를 구현하여 다른 AI 서비스를 추가할 수 있습니다:

```typescript
// src/renderer/lib/ai-provider.ts
class ClaudeProvider implements AiProvider {
  async *generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string> { ... }
  async listModels(): Promise<string[]> { ... }
  async isAvailable(): Promise<boolean> { ... }
}
```

## 라이선스

copyright 2026. JJW. All rights reserved.
