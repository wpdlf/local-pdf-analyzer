# PDF 대학교 강의자료 요약 앱 Design Document

> **Summary**: Electron + Ollama 기반 PDF 강의자료 자동 요약 데스크톱 앱의 기술 설계
>
> **Project**: summary-lecture-material
> **Version**: 0.1.0
> **Author**: jjw
> **Date**: 2026-03-17
> **Status**: Draft
> **Planning Doc**: [pdf-lecture-summary.plan.md](../01-plan/features/pdf-lecture-summary.plan.md)

### Pipeline References

| Phase | Document | Status |
|-------|----------|--------|
| Phase 1 | Schema Definition | N/A |
| Phase 2 | Coding Conventions | N/A |
| Phase 3 | Mockup | N/A |
| Phase 4 | API Spec | N/A |

---

## 1. Overview

### 1.1 Design Goals

- PDF 텍스트 추출부터 AI 요약까지 원클릭 자동화
- Ollama 자동 설치/관리로 사용자가 LLM 환경을 의식하지 않도록 함
- Provider 추상화로 추후 유료 API(Claude, OpenAI) 전환 무중단 지원
- 대용량 PDF(200+ 페이지) 처리를 위한 청크 분할 전략

### 1.2 Design Principles

- **단순성 우선**: Starter 레벨에 맞는 플랫 구조, 과도한 추상화 지양
- **Provider 교체 가능성**: AI 호출부만 인터페이스로 분리
- **프로세스 분리**: Electron main(Ollama 관리, 파일 I/O) / renderer(UI) 명확 분리
- **오프라인 우선**: 로컬 LLM으로 인터넷 없이 동작 가능

---

## 2. Architecture

### 2.1 Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    Electron Application                       │
├──────────────────────┬───────────────────────────────────────┤
│   Main Process       │          Renderer Process             │
│                      │                                       │
│  ┌────────────────┐  │  ┌─────────────┐  ┌───────────────┐  │
│  │ OllamaManager  │  │  │ PdfUploader │  │ SummaryViewer │  │
│  │ - install       │  │  └──────┬──────┘  └───────▲───────┘  │
│  │ - start/stop    │  │         │                  │          │
│  │ - health check  │  │         ▼                  │          │
│  └────────┬───────┘  │  ┌──────────────┐   ┌──────┴───────┐ │
│           │          │  │  PdfParser   │──▶│  AiClient    │ │
│  ┌────────▼───────┐  │  │  (pdfjs-dist)│   │  (Provider)  │ │
│  │ IPC Bridge     │◀─┼─▶│              │   └──────────────┘ │
│  │ (ipcMain)      │  │  └──────────────┘                    │
│  └────────────────┘  │                                       │
│                      │  ┌──────────────┐  ┌───────────────┐  │
│  ┌────────────────┐  │  │ SettingsPanel│  │  ProgressBar  │  │
│  │ FileManager    │  │  └──────────────┘  └───────────────┘  │
│  │ (export/save)  │  │                                       │
│  └────────────────┘  │  ┌──────────────────────────────────┐ │
│                      │  │      Zustand Store               │ │
│                      │  └──────────────────────────────────┘ │
├──────────────────────┴───────────────────────────────────────┤
│                    Ollama (localhost:11434)                    │
│                    ┌─────────────────────┐                    │
│                    │  llama3.2 / phi3    │                    │
│                    └─────────────────────┘                    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 Data Flow

```
[PDF 파일 선택/드롭]
       │
       ▼
[PdfParser: 텍스트 추출 (pdfjs-dist)]
       │
       ▼
[텍스트 청크 분할 (페이지/챕터 기준)]
       │
       ▼
[프롬프트 생성 (요약 유형별 템플릿)]
       │
       ▼
[AiClient: Ollama API 호출 (POST /api/generate)]
       │
       ▼
[스트리밍 응답 수신 → 실시간 표시]
       │
       ▼
[마크다운 렌더링 (react-markdown)]
       │
       ▼
[내보내기 (선택) → .md / .txt 파일 저장]
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| PdfParser | pdfjs-dist | PDF 텍스트 추출 |
| AiClient | Ollama REST API | LLM 요약 생성 |
| OllamaManager | child_process, https | Ollama 설치/프로세스 관리 |
| SummaryViewer | react-markdown, remark-gfm | 마크다운 렌더링 |
| Store | zustand | 전역 상태 관리 |
| UI | tailwindcss | 스타일링 |
| App Shell | electron-vite | 빌드/번들링 |

---

## 3. Data Model

### 3.1 Entity Definition

```typescript
// PDF 문서 정보
interface PdfDocument {
  id: string;              // crypto.randomUUID()
  fileName: string;        // 원본 파일명
  filePath: string;        // 로컬 파일 경로
  pageCount: number;       // 총 페이지 수
  extractedText: string;   // 추출된 전체 텍스트
  chapters: Chapter[];     // 챕터 분할 결과
  createdAt: Date;
}

// 챕터 (페이지 기반 분할)
interface Chapter {
  index: number;           // 챕터 순번
  title: string;           // 감지된 제목 (없으면 "Chapter N")
  startPage: number;
  endPage: number;
  text: string;
}

// 요약 결과
interface Summary {
  id: string;
  documentId: string;      // PdfDocument.id 참조
  type: SummaryType;
  content: string;         // 마크다운 형식 요약 결과
  model: string;           // 사용한 모델명
  provider: AiProvider;
  createdAt: Date;
  durationMs: number;      // 요약 소요 시간
}

// 요약 유형
type SummaryType = 'full' | 'chapter' | 'keywords';

// AI 제공자
type AiProvider = 'ollama' | 'claude' | 'openai';

// 앱 설정
interface AppSettings {
  provider: AiProvider;
  model: string;           // e.g., "llama3.2"
  ollamaBaseUrl: string;   // e.g., "http://localhost:11434"
  apiKey?: string;         // 유료 API용 (암호화 저장)
  theme: 'light' | 'dark' | 'system';
  defaultSummaryType: SummaryType;
  maxChunkSize: number;    // 청크당 최대 토큰 수 (기본: 4000)
}

// Ollama 상태
interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version?: string;
  models: string[];        // 설치된 모델 목록
  selectedModel?: string;
}
```

### 3.2 로컬 저장소 구조

```
%APPDATA%/summary-lecture-material/    (Windows)
~/Library/Application Support/summary-lecture-material/  (macOS)
├── settings.json          # AppSettings
├── history/               # 요약 이력
│   ├── {id}.json          # Summary + PdfDocument 메타데이터
│   └── ...
└── exports/               # 기본 내보내기 경로
```

> 저장소는 `electron-store`로 관리. API 키만 `safeStorage`로 별도 암호화.

---

## 4. Ollama 관리 설계

### 4.1 OllamaManager (Main Process)

```typescript
// src/main/ollama-manager.ts

class OllamaManager {
  // 설치 확인
  async isInstalled(): Promise<boolean>
  // OS별 Ollama 설치 (Windows: winget/installer, macOS: brew/installer)
  async install(onProgress: (percent: number) => void): Promise<void>
  // Ollama 프로세스 시작
  async start(): Promise<void>
  // Ollama 프로세스 중지
  async stop(): Promise<void>
  // 헬스 체크 (GET http://localhost:11434)
  async healthCheck(): Promise<boolean>
  // 설치된 모델 목록
  async listModels(): Promise<string[]>
  // 모델 다운로드 (ollama pull)
  async pullModel(model: string, onProgress: (percent: number) => void): Promise<void>
  // 전체 초기화 플로우 (설치 → 시작 → 모델 다운로드)
  async initialize(): Promise<OllamaStatus>
}
```

### 4.2 Ollama 설치 플로우

```
[앱 첫 실행]
     │
     ▼
[Ollama 설치 확인] ──(설치됨)──▶ [Ollama 시작]
     │                                │
   (미설치)                           ▼
     │                         [모델 확인]
     ▼                                │
[설치 안내 다이얼로그]          (모델 있음)──▶ [준비 완료]
     │                                │
   (동의)                          (모델 없음)
     │                                │
     ▼                                ▼
[OS별 설치 실행]              [모델 다운로드]
  - Windows: OllamaSetup.exe          │
    다운로드 후 실행                    ▼
  - macOS: Ollama.dmg                 [준비 완료]
    다운로드 후 실행
     │
     ▼
[설치 완료 → Ollama 시작 → 모델 다운로드]
```

### 4.3 OS별 설치 전략

| OS | 설치 방식 | 설치 경로 | 비고 |
|----|----------|----------|------|
| Windows | OllamaSetup.exe 다운로드 후 `child_process.exec` 실행 | `%LOCALAPPDATA%\Ollama` | 관리자 권한 불필요 |
| macOS | Ollama-darwin.zip 다운로드 후 /Applications에 복사 | `/usr/local/bin/ollama` | 브루 대신 직접 다운로드 |

---

## 5. AI Client 설계

### 5.1 Provider 추상화

```typescript
// src/renderer/lib/ai-provider.ts

interface AiProvider {
  generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string>;
  listModels(): Promise<string[]>;
  isAvailable(): Promise<boolean>;
}

interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

// Ollama 구현
class OllamaProvider implements AiProvider {
  constructor(private baseUrl: string = 'http://localhost:11434') {}

  async *generate(prompt: string, options?: GenerateOptions): AsyncGenerator<string> {
    // POST /api/generate (stream: true)
    // yield each token as it arrives
  }

  async listModels(): Promise<string[]> {
    // GET /api/tags
  }

  async isAvailable(): Promise<boolean> {
    // GET / (health check)
  }
}

// 추후 확장 예시
// class ClaudeProvider implements AiProvider { ... }
// class OpenAiProvider implements AiProvider { ... }
```

### 5.2 AI Client (Facade)

```typescript
// src/renderer/lib/ai-client.ts

class AiClient {
  private provider: AiProvider;

  constructor(settings: AppSettings) {
    this.provider = this.createProvider(settings);
  }

  private createProvider(settings: AppSettings): AiProvider {
    switch (settings.provider) {
      case 'ollama': return new OllamaProvider(settings.ollamaBaseUrl);
      // case 'claude': return new ClaudeProvider(settings.apiKey);
      // case 'openai': return new OpenAiProvider(settings.apiKey);
    }
  }

  async *summarize(text: string, type: SummaryType): AsyncGenerator<string> {
    const prompt = buildPrompt(text, type);
    yield* this.provider.generate(prompt, { temperature: 0.3 });
  }
}
```

### 5.3 청크 분할 전략

```
대용량 PDF 처리:

[전체 텍스트]
     │
     ▼
[청크 분할] (maxChunkSize: 4000 tokens 기준)
     │
     ├──▶ [Chunk 1] → [요약 1]
     ├──▶ [Chunk 2] → [요약 2]  ──▶ [최종 통합 요약]
     └──▶ [Chunk N] → [요약 N]

분할 기준:
1. 챕터/섹션 헤딩 기반 (우선)
2. 페이지 기반 (헤딩 없는 경우)
3. 토큰 수 기반 (최종 폴백)
```

---

## 6. UI/UX Design

### 6.1 메인 화면 레이아웃

```
┌─────────────────────────────────────────────────────────┐
│  📄 강의자료 요약기                    [⚙️] [🌙/☀️]     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │                                                   │  │
│  │   PDF 파일을 여기에 드래그하거나                    │  │
│  │            클릭하여 선택                           │  │
│  │                                                   │  │
│  │            📁 [파일 선택]                          │  │
│  │                                                   │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  요약 유형:  (● 전체 요약) (○ 챕터별) (○ 키워드 추출)   │
│                                                         │
│              [📝 요약 시작]                              │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Ollama: ✅ Running (llama3.2)                          │
└─────────────────────────────────────────────────────────┘
```

### 6.2 요약 결과 화면

```
┌─────────────────────────────────────────────────────────┐
│  📄 강의자료 요약기                    [⚙️] [🌙/☀️]     │
├─────────────────────────────────────────────────────────┤
│  📎 운영체제_Chapter3.pdf (42p)        [✕ 닫기]         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ## 3장: 프로세스 관리 요약                              │
│                                                         │
│  ### 핵심 개념                                          │
│  - **프로세스**: 실행 중인 프로그램의 인스턴스           │
│  - **스레드**: 프로세스 내의 실행 단위                   │
│  ...                                                    │
│                                                         │
│  ### 주요 수식                                          │
│  - CPU 이용률 = 1 - p^n                                 │
│  ...                                                    │
│                                                         │
│  ████████████████████░░░░░  80% (32/42 pages)           │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  [💾 .md 내보내기]  [📋 복사]            소요: 45초      │
└─────────────────────────────────────────────────────────┘
```

### 6.3 설정 화면

```
┌─────────────────────────────────────────────────────────┐
│  ⚙️ 설정                                   [✕ 닫기]     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  AI 모델 설정                                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Provider:  [Ollama (로컬)     ▾]                  │  │
│  │ Model:     [llama3.2          ▾]                  │  │
│  │ Ollama URL: [http://localhost:11434]               │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Ollama 관리                                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │ 상태: ✅ Running (v0.6.2)                         │  │
│  │ 설치된 모델: llama3.2 (4.7GB), phi3 (2.2GB)      │  │
│  │ [모델 추가 다운로드]  [Ollama 재시작]              │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  테마                                                   │
│  (○ 라이트) (○ 다크) (● 시스템 설정 따르기)             │
│                                                         │
│  청크 크기: [4000] tokens                               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### 6.4 User Flow

```
[앱 실행]
    │
    ├──(첫 실행)──▶ [Ollama 설치 마법사] → [모델 다운로드] → [메인 화면]
    │
    └──(이후)──▶ [Ollama 자동 시작] → [메인 화면]
                                          │
                            ┌─────────────┼─────────────┐
                            ▼             ▼             ▼
                     [PDF 업로드]    [설정 변경]    [이력 조회]
                         │
                         ▼
                   [요약 유형 선택]
                         │
                         ▼
                   [요약 진행 (스트리밍)]
                         │
                         ▼
                   [결과 확인 / 내보내기]
```

### 6.5 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `App.tsx` | `src/renderer/` | 루트 컴포넌트, 라우팅 |
| `PdfUploader.tsx` | `src/renderer/components/` | PDF 드래그앤드롭, 파일 선택 |
| `SummaryViewer.tsx` | `src/renderer/components/` | 마크다운 요약 결과 표시 |
| `SettingsPanel.tsx` | `src/renderer/components/` | AI/테마 설정 UI |
| `ProgressBar.tsx` | `src/renderer/components/` | 요약 진행률 표시 |
| `OllamaSetupWizard.tsx` | `src/renderer/components/` | 첫 실행 Ollama 설치 안내 |
| `SummaryTypeSelector.tsx` | `src/renderer/components/` | 전체/챕터별/키워드 선택 |
| `StatusBar.tsx` | `src/renderer/components/` | 하단 Ollama 상태 표시 |

---

## 7. Error Handling

### 7.1 에러 코드 정의

| Code | Message | Cause | Handling |
|------|---------|-------|----------|
| `PDF_PARSE_FAIL` | PDF를 읽을 수 없습니다 | 손상된 파일, 암호화 | 파일 확인 안내 |
| `PDF_NO_TEXT` | 텍스트를 추출할 수 없습니다 | 이미지/스캔 기반 PDF | OCR 미지원 안내 |
| `OLLAMA_NOT_FOUND` | Ollama가 설치되지 않았습니다 | 미설치 | 설치 마법사 실행 |
| `OLLAMA_NOT_RUNNING` | Ollama가 실행 중이 아닙니다 | 프로세스 종료 | 자동 재시작 시도 |
| `OLLAMA_INSTALL_FAIL` | Ollama 설치에 실패했습니다 | 권한, 네트워크 | 수동 설치 링크 안내 |
| `MODEL_NOT_FOUND` | 모델이 설치되지 않았습니다 | 모델 미다운로드 | 모델 다운로드 안내 |
| `MODEL_PULL_FAIL` | 모델 다운로드에 실패했습니다 | 네트워크, 디스크 부족 | 디스크/네트워크 확인 안내 |
| `GENERATE_FAIL` | 요약 생성에 실패했습니다 | LLM 오류 | 재시도 버튼 제공 |
| `GENERATE_TIMEOUT` | 요약 시간이 초과되었습니다 | 대용량, 느린 하드웨어 | 경량 모델 전환 제안 |
| `EXPORT_FAIL` | 파일 저장에 실패했습니다 | 권한, 경로 | 다른 경로 선택 안내 |

### 7.2 에러 표시 방식

```typescript
// 토스트 알림 (경미한 에러)
showToast({ type: 'error', message: '...' });

// 인라인 에러 (입력 관련)
<ErrorMessage>PDF를 읽을 수 없습니다. 다른 파일을 선택해주세요.</ErrorMessage>

// 모달 다이얼로그 (심각한 에러 - Ollama 관련)
showDialog({ title: 'Ollama 설치 필요', message: '...', actions: ['설치', '취소'] });
```

---

## 8. Security Considerations

- [x] 로컬 전용 앱이므로 네트워크 보안 위험 최소화
- [ ] PDF 파일 파싱 시 악성 콘텐츠 필터링 (pdfjs-dist 자체 샌드박싱)
- [ ] 추후 API 키 저장 시 `electron safeStorage` 사용
- [ ] Ollama 통신은 localhost만 허용 (외부 노출 차단)
- [ ] Electron `contextIsolation: true`, `nodeIntegration: false` 설정

---

## 9. Test Plan

### 9.1 Test Scope

| Type | Target | Tool |
|------|--------|------|
| Unit Test | PdfParser, AiClient, prompts | Vitest |
| Integration Test | Ollama 연동, 파일 내보내기 | Vitest |
| E2E Test | 전체 요약 플로우 | Playwright + Electron |

### 9.2 Test Cases (Key)

- [ ] Happy path: PDF 업로드 → 텍스트 추출 → 요약 생성 → 결과 표시
- [ ] Happy path: 요약 결과 .md 내보내기
- [ ] Error: 이미지 기반 PDF 업로드 시 `PDF_NO_TEXT` 에러 표시
- [ ] Error: Ollama 미실행 시 자동 시작 후 재시도
- [ ] Edge case: 200페이지 이상 PDF 청크 분할 처리
- [ ] Edge case: Ollama 미설치 환경에서 설치 마법사 동작

---

## 10. Clean Architecture

### 10.1 Layer Structure (Starter Level)

| Layer | Responsibility | Location |
|-------|---------------|----------|
| **Presentation** | React UI 컴포넌트 | `src/renderer/components/` |
| **Application** | AI 요약 로직, PDF 처리 오케스트레이션 | `src/renderer/lib/` |
| **Domain** | 타입 정의, 프롬프트 템플릿 | `src/renderer/types/`, `src/renderer/lib/prompts.ts` |
| **Infrastructure** | Ollama API 호출, 파일 I/O, Electron IPC | `src/renderer/lib/ai-provider.ts`, `src/main/` |

### 10.2 This Feature's Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| PdfUploader, SummaryViewer, SettingsPanel | Presentation | `src/renderer/components/` |
| AiClient, PdfParser | Application | `src/renderer/lib/` |
| PdfDocument, Summary, AppSettings (types) | Domain | `src/renderer/types/` |
| OllamaProvider, OllamaManager | Infrastructure | `src/renderer/lib/`, `src/main/` |

---

## 11. Coding Convention

### 11.1 Naming Conventions

| Target | Rule | Example |
|--------|------|---------|
| Components | PascalCase | `PdfUploader`, `SummaryViewer` |
| Functions | camelCase | `extractText()`, `summarize()` |
| Constants | UPPER_SNAKE_CASE | `MAX_CHUNK_SIZE`, `DEFAULT_MODEL` |
| Types/Interfaces | PascalCase | `PdfDocument`, `AiProvider` |
| Files (component) | PascalCase.tsx | `PdfUploader.tsx` |
| Files (utility) | kebab-case.ts | `ai-client.ts`, `pdf-parser.ts` |
| Folders | kebab-case | `components/`, `lib/` |

### 11.2 Import Order

```typescript
// 1. External libraries
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

// 2. Internal modules
import { AiClient } from '../lib/ai-client';
import { useAppStore } from '../lib/store';

// 3. Components
import { ProgressBar } from './ProgressBar';

// 4. Type imports
import type { Summary, SummaryType } from '../types';
```

### 11.3 This Feature's Conventions

| Item | Convention Applied |
|------|-------------------|
| Component naming | PascalCase, 기능 명확히 반영 (`PdfUploader`, not `Uploader`) |
| File organization | main/ (Electron), renderer/ (React) 분리 |
| State management | Zustand single store, 슬라이스 패턴 불필요 (Starter) |
| Error handling | 에러 코드 기반, 사용자 친화적 한국어 메시지 |
| AI 호출 | AsyncGenerator 스트리밍, Provider 인터페이스 |

---

## 12. Implementation Guide

### 12.1 File Structure

```
summary-lecture-material/
├── package.json
├── electron.vite.config.ts
├── tailwind.config.js
├── tsconfig.json
├── src/
│   ├── main/
│   │   ├── index.ts              # Electron 엔트리
│   │   └── ollama-manager.ts     # Ollama 설치/시작/관리
│   ├── preload/
│   │   └── index.ts              # contextBridge 노출 API
│   └── renderer/
│       ├── index.html
│       ├── App.tsx               # 루트 컴포넌트
│       ├── components/
│       │   ├── PdfUploader.tsx
│       │   ├── SummaryViewer.tsx
│       │   ├── SummaryTypeSelector.tsx
│       │   ├── SettingsPanel.tsx
│       │   ├── ProgressBar.tsx
│       │   ├── OllamaSetupWizard.tsx
│       │   └── StatusBar.tsx
│       ├── lib/
│       │   ├── ai-client.ts      # AiClient facade
│       │   ├── ai-provider.ts    # Provider 인터페이스 + OllamaProvider
│       │   ├── pdf-parser.ts     # PDF 텍스트 추출
│       │   ├── prompts.ts        # 요약 프롬프트 템플릿
│       │   ├── chunker.ts        # 텍스트 청크 분할
│       │   └── store.ts          # Zustand store
│       └── types/
│           └── index.ts          # 모든 타입 정의
└── resources/                    # 앱 아이콘 등 정적 리소스
```

### 12.2 Implementation Order

1. [ ] **프로젝트 초기화**: `electron-vite` + React + TypeScript + Tailwind 셋업
2. [ ] **타입 정의**: `types/index.ts` — 모든 인터페이스/타입
3. [ ] **OllamaManager**: Main process — 설치 확인, 자동 설치, 프로세스 시작
4. [ ] **Preload/IPC**: Main ↔ Renderer 통신 브릿지 (Ollama 상태, 파일 저장)
5. [ ] **PdfParser**: pdfjs-dist로 텍스트 추출 + 챕터 분할
6. [ ] **AI Provider + Client**: Ollama 호출, 스트리밍, 프롬프트 생성
7. [ ] **UI 컴포넌트**: PdfUploader → SummaryTypeSelector → SummaryViewer → ProgressBar
8. [ ] **OllamaSetupWizard**: 첫 실행 설치 마법사 UI
9. [ ] **SettingsPanel**: 모델 선택, 테마, 청크 크기 설정
10. [ ] **내보내기**: 요약 결과 .md/.txt 파일 저장
11. [ ] **다크모드/테마**: Tailwind dark mode 적용
12. [ ] **빌드/패키징**: electron-builder로 Windows/macOS 인스톨러 생성

### 12.3 핵심 패키지

```json
{
  "dependencies": {
    "react": "^19.0",
    "react-dom": "^19.0",
    "react-markdown": "^9.0",
    "remark-gfm": "^4.0",
    "pdfjs-dist": "^4.0",
    "zustand": "^5.0",
    "electron-store": "^10.0"
  },
  "devDependencies": {
    "electron": "^34.0",
    "electron-vite": "^3.0",
    "electron-builder": "^25.0",
    "typescript": "^5.7",
    "tailwindcss": "^4.0",
    "vitest": "^3.0",
    "@types/react": "^19.0"
  }
}
```

---

## 13. 프롬프트 설계

### 13.1 전체 요약 프롬프트

```
당신은 대학교 강의자료 요약 전문가입니다.

다음 강의자료를 분석하여 구조적으로 요약해주세요.

## 요약 규칙
1. **핵심 개념**: 주요 개념과 정의를 목록으로 정리
2. **주요 내용**: 각 섹션의 핵심 내용을 간결하게 요약
3. **수식/공식**: 중요한 수식이 있으면 원문 그대로 포함
4. **예제**: 핵심 예제가 있으면 간략히 포함
5. **시험 포인트**: 시험에 출제될 가능성이 높은 내용 별도 표시

## 출력 형식
마크다운 형식으로 출력하세요.

---

{extracted_text}
```

### 13.2 키워드 추출 프롬프트

```
다음 강의자료에서 핵심 키워드를 추출하고 각각 간단히 설명해주세요.

## 출력 형식
| 키워드 | 설명 | 중요도 |
|--------|------|--------|

---

{extracted_text}
```

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-03-17 | Initial draft | jjw |
