# Design: pdf-image-recognition

> **Feature**: PDF 내 삽입 이미지 인식 및 요약 통합
> **작성일**: 2026-03-24
> **설계안**: Option C — 실용적 균형 (기존 모듈 확장, 신규 파일 0개)

## Context Anchor

| 항목 | 내용 |
|------|------|
| **WHY** | 강의 자료 PDF에는 차트, 그래프, 다이어그램이 핵심 내용을 담고 있으나 현재 완전히 무시됨 |
| **WHO** | 강의 자료를 요약하는 학생/직장인 — 시각 자료가 많은 PDF를 자주 다루는 사용자 |
| **RISK** | Vision 모델 VRAM 요구사항 증가, API 토큰 비용 증가, 이미지 추출 실패 시 graceful fallback 필요 |
| **SUCCESS** | 이미지가 포함된 PDF에서 이미지 의미가 요약 텍스트에 자연스럽게 통합됨 |
| **SCOPE** | PDF 이미지 추출 + Vision API 분석 + 프롬프트 병합 (UI 변경 최소화) |

---

## 1. Overview

기존 파일을 확장하여 PDF 이미지 추출 → Vision 분석 → 텍스트 병합 파이프라인을 구축한다. 신규 파일 없이 `pdf-parser.ts`에 이미지 추출, `ai-service.ts`에 Vision 분석 기능을 추가한다.

---

## 2. 타입 변경

### 2.1 `src/renderer/types/index.ts`

```typescript
// 추가할 타입

// 페이지별 추출 이미지
export interface PageImage {
  pageIndex: number;     // 0-based 페이지 인덱스
  imageIndex: number;    // 페이지 내 이미지 순번
  base64: string;        // base64 인코딩된 JPEG 데이터
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
}

// PdfDocument 확장
export interface PdfDocument {
  // ... 기존 필드
  images: PageImage[];   // 추출된 이미지 목록 (이미지 없으면 빈 배열)
}

// AppSettings 확장
export interface AppSettings {
  // ... 기존 필드
  enableImageAnalysis: boolean;  // 이미지 분석 on/off (기본: true)
}

// GenerateRequest 확장 (ai-service.ts)
// images?: string[] 추가 — 해당 청크에 속하는 이미지 base64 목록
```

---

## 3. PDF 이미지 추출 (`pdf-parser.ts`)

### 3.1 추출 함수 설계

```typescript
async function extractPageImages(
  page: PDFPageProxy,
  pageIndex: number,
): Promise<PageImage[]>
```

**흐름:**
1. `page.getOperatorList()` 호출
2. `OPS.paintImageXObject` 연산자 탐색
3. 각 이미지 이름으로 `page.objs.get(imageName)` → `{width, height, data, kind}` 취득
4. 크기 필터: `width < 50 || height < 50` → skip (아이콘/장식)
5. OffscreenCanvas (또는 Canvas)에 ImageData 그리기
6. `canvas.toDataURL('image/jpeg', 0.8)` → base64
7. 장변 > 1024px인 경우 리사이즈 후 변환
8. 페이지당 최대 10개

**필터 기준:**
- 최소: 50x50px
- 최대: 장변 1024px (리사이즈)
- 페이지당 상한: 10개
- 전체 PDF 상한: 50개

### 3.2 parsePdf 변경

```typescript
export async function parsePdf(...): Promise<PdfDocument> {
  // 기존 텍스트 추출 로직 유지

  // 이미지 추출 (텍스트 추출과 동일 배치 루프에서 병렬 실행)
  const allImages: PageImage[] = [];
  // 각 페이지 처리 시 getTextContent()와 함께 extractPageImages() 호출
  // try/catch로 개별 페이지 이미지 추출 실패 무시

  return {
    ...기존,
    images: allImages,  // 빈 배열 가능 (이미지 없는 PDF)
  };
}
```

### 3.3 Renderer에서 Canvas 사용

Renderer 프로세스에서 `OffscreenCanvas` 사용 가능. pdfjs가 이미 Renderer에서 실행되므로 이미지 변환도 Renderer에서 수행한다.

---

## 4. Vision 분석 (`ai-service.ts`)

### 4.1 새 함수: `analyzeImage`

```typescript
export async function analyzeImage(
  requestId: string,
  imageBase64: string,
  provider: AiProviderType,
  model: string,
  ollamaBaseUrl: string,
  apiKey: string | undefined,
): Promise<string>  // 이미지 설명 텍스트 반환
```

Vision 모델에 이미지를 전송하고 설명 텍스트를 **비스트리밍**으로 수신한다. (이미지 분석은 짧은 응답이므로 스트리밍 불필요)

### 4.2 Provider별 Vision API 구성

**Ollama:**
```json
{
  "model": "llava",
  "prompt": "이 이미지의 핵심 내용을 한국어로 2~3문장으로 설명하세요.",
  "images": ["<base64>"],
  "stream": false
}
```

**Claude:**
```json
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 300,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "<base64>"}},
      {"type": "text", "text": "이 이미지의 핵심 내용을 한국어로 2~3문장으로 설명하세요."}
    ]
  }]
}
```

**OpenAI:**
```json
{
  "model": "gpt-4o",
  "max_tokens": 300,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,<base64>"}},
      {"type": "text", "text": "이 이미지의 핵심 내용을 한국어로 2~3문장으로 설명하세요."}
    ]
  }]
}
```

### 4.3 응답 파싱

비스트리밍이므로 응답 본문을 한 번에 수신:
- Ollama: `JSON.parse(body).response`
- Claude: `JSON.parse(body).content[0].text`
- OpenAI: `JSON.parse(body).choices[0].message.content`

---

## 5. IPC 변경

### 5.1 새 IPC 핸들러 (`main/index.ts`)

```typescript
ipcMain.handle('ai:analyze-image', async (_event, imageBase64: string) => {
  // 입력 검증: string, base64 형식, 최대 10MB
  // 현재 settings에서 provider/model/url/apiKey 읽기
  // analyzeImage() 호출
  // return { success: true, description: string } | { success: false, error: string }
});
```

### 5.2 Preload 브릿지 (`preload/index.ts`)

```typescript
ai: {
  // 기존: generate, onToken, onDone, abort, checkAvailable
  analyzeImage: (imageBase64: string) => ipcRenderer.invoke('ai:analyze-image', imageBase64),
}
```

---

## 6. 요약 흐름 변경 (`App.tsx`)

### 6.1 handleSummarize 변경

```
기존 흐름:
  text → chunk → AI 요약

새 흐름:
  text + images → 이미지 분석 단계 (images가 있고 설정 on인 경우만) → 텍스트에 설명 삽입 → chunk → AI 요약
```

**이미지 분석 단계:**
1. `document.images` 확인 (빈 배열이면 skip → 기존 흐름)
2. `settings.enableImageAnalysis` 확인 (false면 skip)
3. 각 이미지에 대해 `window.electronAPI.ai.analyzeImage(image.base64)` 호출
4. 이미지 3개씩 병렬 처리 (동시 API 호출 제한)
5. 결과: `Map<pageIndex, string[]>` — 페이지별 이미지 설명 목록
6. `extractedText`에 페이지별로 `\n[이미지 분석: ...]\n` 삽입
7. 변경된 텍스트로 기존 요약 흐름 진행

### 6.2 진행 상태

이미지 분석 중일 때 ProgressBar 또는 상태 메시지 표시:
- "이미지 분석 중... (3/7)"
- 분석 완료 후 기존 요약 진행

---

## 7. 설정 변경 (`SettingsPanel.tsx`)

### 7.1 토글 추가

"이미지 분석" 섹션에 on/off 토글:
```
[이미지 분석]
  ☑ PDF 이미지 자동 분석
  Vision 지원 모델이 필요합니다 (llava, Claude, GPT-4o 등)
```

### 7.2 DEFAULT_SETTINGS 변경

```typescript
export const DEFAULT_SETTINGS: AppSettings = {
  // ... 기존
  enableImageAnalysis: true,
};
```

---

## 8. 에러 처리 및 Fallback

| 상황 | 처리 |
|------|------|
| 이미지 추출 실패 (개별 페이지) | try/catch, 해당 페이지 이미지 무시, 텍스트만 사용 |
| Vision API 호출 실패 (개별 이미지) | 해당 이미지 설명 생략, 로그만 출력 |
| Vision 모델 미지원 (Ollama 텍스트 모델) | API 에러 시 "이미지 분석을 위해 Vision 모델이 필요합니다" 안내 후 텍스트 전용으로 계속 |
| 전체 이미지 분석 실패 | 텍스트 전용으로 정상 요약 완료 (기존 동작과 동일) |
| base64 데이터 10MB 초과 | 해당 이미지 skip |

---

## 9. 보안 고려

- 이미지 base64 데이터는 IPC를 통해 Main 프로세스에서만 외부 API로 전송
- Renderer에서 외부 네트워크 요청 없음 (CSP `connect-src 'self'` 유지)
- 이미지 데이터 크기 검증 (IPC 핸들러에서 10MB 제한)
- 이미지 분석 프롬프트는 하드코딩 (사용자 입력 주입 불가)

---

## 10. 메모리 관리

- `PdfDocument.images`는 파싱 완료 후 저장, 요약 시 사용
- 이미지 분석 완료 후 `document.images = []`로 메모리 해제 가능
- 이미지 데이터는 JPEG 0.8 품질로 압축 (PNG 대비 ~70% 크기 절감)
- 페이지당 10개, 전체 50개 상한으로 메모리 폭증 방지

---

## 11. Implementation Guide

### 11.1 변경 파일 목록

| # | 파일 | 변경 유형 | 내용 |
|:-:|------|:--------:|------|
| 1 | `src/renderer/types/index.ts` | 수정 | `PageImage` 인터페이스, `PdfDocument.images`, `AppSettings.enableImageAnalysis` |
| 2 | `src/renderer/lib/pdf-parser.ts` | 수정 | `extractPageImages()` 추가, `parsePdf`에 이미지 추출 통합 |
| 3 | `src/main/ai-service.ts` | 수정 | `analyzeImage()` Vision API 함수 추가 (Ollama/Claude/OpenAI) |
| 4 | `src/main/index.ts` | 수정 | `ai:analyze-image` IPC 핸들러, `defaultSettings.enableImageAnalysis` |
| 5 | `src/preload/index.ts` | 수정 | `ai.analyzeImage` 브릿지 |
| 6 | `src/renderer/lib/ai-client.ts` | 수정 | `analyzeImage()` 래퍼 메서드 |
| 7 | `src/renderer/App.tsx` | 수정 | 이미지 분석 단계 + 텍스트 병합 + 진행 상태 |
| 8 | `src/renderer/components/SettingsPanel.tsx` | 수정 | 이미지 분석 on/off 토글 |

### 11.2 구현 순서

1. **타입 정의** — `types/index.ts` 변경
2. **이미지 추출** — `pdf-parser.ts`에 `extractPageImages()` 구현
3. **Vision API** — `ai-service.ts`에 `analyzeImage()` 구현
4. **IPC 연결** — `index.ts` 핸들러 + `preload/index.ts` 브릿지
5. **클라이언트** — `ai-client.ts` 래퍼
6. **요약 통합** — `App.tsx`에 이미지 분석 단계 삽입
7. **설정 UI** — `SettingsPanel.tsx` 토글 추가
8. **빌드 검증**

### 11.3 Session Guide

| Module | 파일 | 설명 |
|--------|------|------|
| module-1 | types, pdf-parser | 타입 정의 + 이미지 추출 |
| module-2 | ai-service, index, preload | Vision API + IPC 연결 |
| module-3 | ai-client, App, SettingsPanel | 클라이언트 통합 + UI |

**권장 세션 계획:**
- 세션 1: module-1 (타입 + 이미지 추출)
- 세션 2: module-2 (Vision API + IPC)
- 세션 3: module-3 (통합 + UI + 테스트)
