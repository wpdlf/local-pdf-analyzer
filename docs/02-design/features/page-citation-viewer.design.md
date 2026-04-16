---
template: design
version: 1.3
feature: page-citation-viewer
date: 2026-04-14
author: jjw
project: local-pdf-analyzer
projectVersion: 0.16.2
status: Draft
---

# page-citation-viewer Design Document

> **Summary**: Option C (Pragmatic) — 얼라인 유틸리티 + 신규 컴포넌트. 청커/벡터스토어에 page 메타데이터를 옵셔널로 확장, `citation.ts` 단일 유틸리티에서 인용 파싱/라벨링을 일원화, 신규 `PdfViewer`/`CitationButton` 컴포넌트 추가.
>
> **Project**: local-pdf-analyzer
> **Version**: 0.16.2
> **Author**: jjw
> **Date**: 2026-04-14
> **Status**: Draft
> **Planning Doc**: [page-citation-viewer.plan.md](../../01-plan/features/page-citation-viewer.plan.md)

---

## Context Anchor

> Copied from Plan document. Ensures strategic context survives Design→Do handoff.

| Key | Value |
|-----|-------|
| **WHY** | LLM 출력의 환각 여부를 사용자가 직접 검증할 수 없는 신뢰도 문제 해결 |
| **WHO** | 학생/연구자/검토자 — 요약 결과를 신뢰하기 위해 원문 확인이 필수인 사용자 |
| **RISK** | RAG 청커 변경이 기존 v0.16.2 검색 정확도에 회귀 영향, pdfjs 뷰어 마운트 시 메모리 spike |
| **SUCCESS** | (1) 요약/Q&A 답변에 ≥1개 인용 토큰 포함 (2) 인용 클릭 → 정확한 페이지 스크롤 (3) 기존 RAG 테스트 39/39 회귀 없음 |
| **SCOPE** | Phase 1: 청크 page 메타데이터 + 프롬프트 / Phase 2: 인용 마크다운 렌더링 / Phase 3: 온디맨드 PdfViewer 패널 |

---

## 1. Overview

### 1.1 Design Goals

1. **신뢰성**: 요약/Q&A 답변에서 AI 가 주장하는 근거를 원문과 1-click 으로 대조 가능
2. **회귀 0**: 기존 RAG 파이프라인과 39/39 단위 테스트에 영향 없는 backward-compatible 확장
3. **메모리 효율**: 첫 인용 클릭 전까지 pdfjs 인스턴스 생성 0. 이후 동일 문서 재클릭 시 모듈 캐시 재사용 (DR-04, v0.17.5)
4. **실패 우아함**: LLM 이 인용 토큰을 누락해도 답변은 정상 렌더 (FR-12)
5. **타입 안전**: 인용 파싱·전파·렌더까지 타입 추론으로 NPE 방지

### 1.2 Design Principles

- **단일 진실원(Single Source of Truth)**: 인용 파싱 로직은 `citation.ts` 한 곳에만 존재
- **Opt-in metadata**: `VectorChunk` 의 page 필드는 optional — 기존 호출자 무영향
- **Prompt engineering > post-processing**: LLM 이 자연스럽게 인용 생성 (컨텍스트에 이미 `[p.N]` 라벨 존재)
- **Progressive disclosure**: PdfViewer 는 첫 인용 클릭 시까지 번들/메모리 점유 0
- **YAGNI**: 페이지 범위/다중 인용/하이라이트는 v0.17 후속

---

## 2. Architecture Options (v1.7.0)

### 2.0 Architecture Comparison

| Criteria | Option A: Minimal | Option B: Clean | Option C: Pragmatic |
|----------|:-:|:-:|:-:|
| **Approach** | 인라인 확장 | 도메인 모듈 분리 | 유틸 + 신규 컴포넌트 |
| **New Files** | 2 (PdfViewer, 테스트) | 8 (citation/*, types/*, tests) | 4 (citation.ts, PdfViewer, CitationButton, test) |
| **Modified Files** | 8 | 8 | 7~8 |
| **Complexity** | Low | High | Medium |
| **Maintainability** | Medium | High | High |
| **Effort** | Low | High | Medium |
| **Risk** | Low (coupled) | Low (clean) | Low (balanced) |
| **Recommendation** | 빠른 프로토타입 | 대규모 리팩터 | **선택됨** |

**Selected**: **Option C — Pragmatic** — **Rationale**: 단일 기능 추가에 도메인 폴더까지 만드는 것은 과공학. 인용 파싱은 순수 함수 몇 개로 충분하므로 `citation.ts` 한 파일에 모으고, UI 만 신규 컴포넌트로 분리. 기존 v0.16.2 의 "한 파일에 관련 로직 응집" 컨벤션과도 일치.

### 2.1 Component Diagram

```
┌───────────────────┐      ┌────────────────────┐
│  PDF Document     │─────▶│  parsePdf          │  (existing)
│  (pdfjs)          │      │  → pageTexts[]     │
└───────────────────┘      └──────────┬─────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  chunkTextWithOverlap│
                           │  ByPage (NEW)        │
                           │  → {text, pageStart, │
                           │     pageEnd}[]       │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  VectorStore         │
                           │  {text, embedding,   │
                           │   index, pageStart,  │  (extended)
                           │   pageEnd}           │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  use-qa / use-sum    │
                           │  buildContext()      │  (extended)
                           │  → "[p.5-7]\n..."    │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  ai-service          │
                           │  (prompt w/ [p.N]    │  (extended)
                           │   instruction)       │
                           └──────────┬───────────┘
                                      │   LLM response w/ [p.12]
                                      ▼
                           ┌──────────────────────┐
                           │  SummaryViewer /     │
                           │  QaChat              │
                           │  <ReactMarkdown      │
                           │    components={      │
                           │      safeComponents  │
                           │    }/>               │
                           └──────────┬───────────┘
                                      │   text renderer
                                      ▼
                           ┌──────────────────────┐
                           │  parseCitations()    │
                           │  → [{type:'text'}    │  (NEW)
                           │    {type:'cite',p:12}│
                           │    ...]              │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  <CitationButton     │
                           │    page={12}         │  (NEW)
                           │    onClick={...}/>   │
                           └──────────┬───────────┘
                                      │   click
                                      ▼
                           ┌──────────────────────┐
                           │  store.              │
                           │  setCitationTarget(  │  (extended)
                           │    {page:12})        │
                           └──────────┬───────────┘
                                      │
                                      ▼
                           ┌──────────────────────┐
                           │  <PdfViewer          │
                           │    targetPage={12}/> │  (NEW, lazy)
                           │  pdfjs canvas render │
                           └──────────────────────┘
```

### 2.2 Data Flow

```
1. PDF 로드
   parsePdf → pageTexts: string[]          (기존)

2. RAG 인덱싱 (use-qa.buildRagIndex)
   chunkTextWithOverlapByPage(pageTexts)
   → VectorChunk[] { text, pageStart, pageEnd }
   → vectorStore.addChunk(text, embedding, index, { pageStart, pageEnd })

3. Q&A 검색 (use-qa.handleAsk)
   store.search(queryEmbedding, 5)
   → SearchResult[] { text, score, index, pageStart?, pageEnd? }
   → context = formatContextWithPages(results)
     "[p.5-7]\n{text}\n\n[p.12]\n{text}"
   → ai.generate(prompt + context)

4. 요약 (use-summarize)
   chunks = chunkChaptersByPage(...)  // 청크별 page 보존
   각 청크를 [p.N-M]\n{chunk} 형태로 프롬프트에 포함

5. LLM 응답 (한글 예시)
   "메모리 누수는 백그래피런 백프레셔 부재로 발생한다[p.12]. 이 문제는 response.pipe(file)로 해결된다[p.13]."

6. safe-markdown 렌더
   text renderer 에서 parseCitations(string)
   → [
       { type: 'text', content: '메모리 누수는 백그래피런 백프레셔 부재로 발생한다' },
       { type: 'citation', page: 12 },
       { type: 'text', content: '. 이 문제는 response.pipe(file)로 해결된다' },
       { type: 'citation', page: 13 },
       { type: 'text', content: '.' },
     ]
   → 각 citation 조각을 <CitationButton page={N} /> 로 렌더

7. 클릭
   store.setCitationTarget({ page: 12 })
   → SummaryViewer 가 citationTarget 존재 시 우측 패널 슬롯에 <PdfViewer /> 마운트
   → PdfViewer 내부 useEffect([targetPage]) 에서 page 12 로 scroll

8. 패널 닫기
   store.setCitationTarget(null) → PdfViewer 언마운트 → pdf 인스턴스는 모듈 캐시에 보존 (DR-04). 다음 문서 로드 또는 다른 pdfBytes 전달 시 destroy.
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| `citation.ts` | (순수 함수) | 인용 파싱 / 라벨 포맷 / 정규식 |
| `chunker.ts` | `citation.ts`? No — 순수 확장 | page 메타데이터 부착 |
| `vector-store.ts` | 없음 | VectorChunk 타입 확장 |
| `use-qa.ts` | `vector-store`, `citation` | page-labeled context 빌드 |
| `use-summarize.ts` | `chunker`, `citation` | page-labeled chunk 프롬프트 |
| `safe-markdown.tsx` | `citation`, `store` | p/li/td/th/em/strong renderers 에서 인용 파싱·렌더 |
| `CitationButton.tsx` | `store`, `useT` | 버튼 + 접근성 + i18n |
| `PdfViewer.tsx` | `pdfjs-dist`, `store`, `useT` | canvas 페이지 리스트 뷰어 (v0.18 가상 스크롤 예정). `ResizeObserver` 기반 debounce 재렌더. |
| `ResizeHandle.tsx` | `store`, `useT` | DR-01 가로 리사이즈 핸들 (pointer capture + 키보드 Arrow / Home / End + ARIA slider). `store.citationPanelWidth` 구독·갱신 + `localStorage` 영속화. |
| `SummaryViewer.tsx` | `PdfViewer`, `ResizeHandle`, `store` | 우측 패널 레이아웃. `flexBasis` 로 가변 분배. |
| `ai-service.ts` (main) | 없음 | 프롬프트 시스템 메시지 확장 |

---

## 3. Data Model

### 3.1 Entity Definition

```typescript
// src/renderer/lib/citation.ts
export interface CitationSegment {
  /** 'text' — 일반 문자열, 'citation' — 인용 토큰 */
  type: 'text' | 'citation';
  /** text 일 때 원문 */
  content?: string;
  /** citation 일 때 대상 페이지 (1-based) */
  page?: number;
  /** citation 일 때 raw token ([p.12]) — 디버그/롤백용 */
  raw?: string;
}

// src/renderer/lib/vector-store.ts (extended)
export interface VectorChunk {
  text: string;
  embedding: Float32Array;
  index: number;
  /** NEW — 청크가 시작된 1-based 페이지 번호 */
  pageStart?: number;
  /** NEW — 청크가 끝난 1-based 페이지 번호 (pageStart 와 같으면 단일 페이지) */
  pageEnd?: number;
}

export interface SearchResult {
  text: string;
  score: number;
  index: number;
  pageStart?: number;  // NEW
  pageEnd?: number;    // NEW
}

// src/renderer/lib/chunker.ts (new function)
export interface PageChunk {
  text: string;
  pageStart: number; // 1-based
  pageEnd: number;   // 1-based
}

// src/renderer/lib/store.ts (extended AppState)
interface AppState {
  // ... existing
  /** NEW — 인용 클릭 대상. null 이면 PdfViewer 패널 비활성. */
  citationTarget: { page: number } | null;
  setCitationTarget: (target: { page: number } | null) => void;
}
```

### 3.2 Entity Relationships

```
PdfDocument.pageTexts[]  (existing)
     │
     ▼ (chunkTextWithOverlapByPage)
PageChunk[]  { text, pageStart, pageEnd }
     │
     ▼ (use-qa buildRagIndex)
VectorChunk  { text, embedding, index, pageStart, pageEnd }
     │
     ▼ (vector-store.search)
SearchResult[]  { text, score, index, pageStart, pageEnd }
     │
     ▼ (use-qa.handleAsk → prompt context)
string  "[p.5-7]\n...\n\n[p.12]\n..."
     │
     ▼ (LLM + ai-service prompt w/ instruction)
string  "...문장[p.12]. 다음 문장[p.13]."
     │
     ▼ (safe-markdown text renderer + parseCitations)
CitationSegment[]
     │
     ▼ (CitationButton click)
store.citationTarget: { page: 12 }
     │
     ▼ (SummaryViewer conditional)
<PdfViewer targetPage={12} />
```

### 3.3 Core Algorithms

#### 3.3.1 `chunkTextWithOverlapByPage`

```typescript
export function chunkTextWithOverlapByPage(
  pageTexts: string[],     // parsePdf 결과
  maxChunkSize: number = 500,
  overlapRatio: number = 0.1,
): PageChunk[] {
  // 1. 각 페이지의 시작 문자 offset 계산 (page boundary map)
  //    pageOffsets[i] = sum(pageTexts[0..i-1].length + separator)
  //
  // 2. 전체 텍스트 기준으로 chunkTextWithOverlap 호출
  //    (기존 함수 재활용 — 회귀 위험 최소)
  //
  // 3. 각 결과 chunk 의 시작/끝 오프셋을 구해, pageOffsets 에서
  //    binary search → pageStart / pageEnd 산출
  //
  // 4. overlap 영역은 pageStart = min(before, after), pageEnd = max(...)
  //    → 경계 청크는 자연스럽게 범위가 넓어짐
}
```

#### 3.3.2 `parseCitations`

```typescript
// 정규식: [p.숫자] — 대소문자 무시, 공백 허용
const CITATION_REGEX = /\[p\.\s*(\d+)\]/gi;

export function parseCitations(text: string): CitationSegment[] {
  const segments: CitationSegment[] = [];
  let lastIdx = 0;
  for (const match of text.matchAll(CITATION_REGEX)) {
    const [raw, pageStr] = match;
    const start = match.index!;
    if (start > lastIdx) {
      segments.push({ type: 'text', content: text.slice(lastIdx, start) });
    }
    const page = parseInt(pageStr, 10);
    if (Number.isFinite(page) && page >= 1) {
      segments.push({ type: 'citation', page, raw });
    }
    lastIdx = start + raw.length;
  }
  if (lastIdx < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIdx) });
  }
  return segments;
}
```

#### 3.3.3 `formatPageLabel` (prompt context 빌더)

```typescript
export function formatPageLabel(pageStart?: number, pageEnd?: number): string {
  if (!pageStart) return '';
  if (!pageEnd || pageEnd === pageStart) return `[p.${pageStart}]`;
  return `[p.${pageStart}-${pageEnd}]`;
}
```

---

## 4. API Specification

이 기능은 외부 HTTP API 를 추가하지 않는다. IPC 는 기존 `ai:generate` / `ai:embed` 인터페이스를 그대로 사용.

### 4.1 내부 인터페이스 (citation.ts)

| Symbol | Signature | Purpose |
|---|---|---|
| `parseCitations` | `(text: string) => CitationSegment[]` | 마크다운 텍스트에서 `[p.N]` 추출 |
| `formatPageLabel` | `(pageStart?: number, pageEnd?: number) => string` | 컨텍스트 빌더용 라벨 생성 |
| `clampCitationPage` | `(page: number, maxPage: number) => number \| null` | 잘못된 페이지 방어 (음수/초과) |

### 4.2 Store API

```typescript
// src/renderer/lib/store.ts
citationTarget: { page: number } | null;
setCitationTarget: (target: { page: number } | null) => void;
```

### 4.3 PdfViewer Props

```typescript
interface PdfViewerProps {
  /** pdfjs 에 로드할 PDF 바이트. pdf-parser.ts 의 handlePdfData 가 이미 Uint8Array
   *  사본을 만들어 store.pdfBytes 에 보관하므로 ArrayBuffer 오버로드는 불필요. */
  pdfBytes: Uint8Array;
  /** 현재 포커스할 페이지 (1-based). 변경 시 해당 페이지로 스크롤 */
  targetPage: number;
  /** 패널 닫기 */
  onClose: () => void;
}
```

> **Note**: 패널 너비는 `store.citationPanelWidth` 상태(기본 50%, 20%~80% clamp)를
> `flexBasis` 로 적용하며, `ResizeHandle` 컴포넌트가 pointer drag / 키보드 Arrow / Home / End 로 조정한다.
> 너비는 `localStorage` 에 영속화되어 재시작 후 복원된다 (DR-01, v0.17.2 구현 완료).

---

## 5. UI/UX Design

### 5.1 Screen Layout

```
요약 진행 중 (기존):
┌────────────────────────────────────────────────────┐
│  Header                                            │
├────────────────────────────────────────────────────┤
│  SummaryViewer (full width)                        │
│    ├─ 요약 스트리밍                                 │
│    └─ QaChat                                       │
└────────────────────────────────────────────────────┘

인용 클릭 후 (신규):
┌────────────────────────────────────────────────────┐
│  Header                                            │
├──────────────────────────┬─────────────────────────┤
│  SummaryViewer           │  PdfViewer Panel (NEW)  │
│    ├─ 요약 + [p.12]      │    ├─ Close ×          │
│    └─ QaChat + [p.15]    │    ├─ Page 12 canvas   │
│                          │    ├─ Page 13 canvas   │
│                          │    └─ Page 14 canvas   │
└──────────────────────────┴─────────────────────────┘
    가변 (기본 50%)                가변 (기본 50%)
      ↑ ResizeHandle 드래그 / Arrow·Home·End 로 조정 (20%~80%)
```

> **v0.17.2 범위**: 좌/우 패널은 `store.citationPanelWidth` 기반 `flexBasis` 로 가변 분할.
> 가로 `ResizeHandle` 컴포넌트(DR-01)가 pointer drag 및 키보드(Arrow / Home / End)를 지원하고,
> 패널 너비는 `localStorage` 에 저장되어 세션 간 복원된다.

### 5.2 User Flow

```
1. 사용자 → PDF 업로드
2. 요약 생성 → 답변에 [p.12] 등 인용 포함
3. 사용자 → [p.12] 클릭
4. 우측 패널 슬라이드 인 → PdfViewer 마운트 → 페이지 12 로 스크롤
5. 사용자 → 원문 확인
6. (a) 다른 인용 클릭 → 패널 유지 + targetPage 갱신 + 해당 페이지 스크롤
   (b) × 클릭 → 패널 닫기 + PdfViewer 언마운트. pdfjs 인스턴스는 모듈 캐시에 유지되어 재클릭 시 즉시 재사용 (DR-04). 문서 변경 시에만 destroy.
7. 새 PDF 로드 시 citationTarget 자동 null
```

### 5.3 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| `PdfViewer` | `src/renderer/components/PdfViewer.tsx` | pdfjs canvas 렌더링, 페이지 스크롤, ResizeObserver 기반 재렌더, destroy on unmount |
| `CitationButton` | `src/renderer/components/CitationButton.tsx` | `[p.N]` 인라인 버튼, 접근성, i18n, click dispatch |
| `ResizeHandle` | `src/renderer/components/ResizeHandle.tsx` | DR-01 가로 리사이즈 핸들. pointer drag / 키보드(Arrow / Home / End) / ARIA slider. `store.citationPanelWidth` 를 구독·갱신하고 `localStorage` 에 영속화 |
| `SummaryViewer` | (수정) | 우측 패널 슬롯 + citationTarget 구독 + `flexBasis` 분배 + `ResizeHandle` 통합 |
| `safeComponents.{p,li,td,th,em,strong}` | (신규 추가) | react-markdown 9 의 text-bearing 블록 컴포넌트 6개에 `renderWithCitations` 헬퍼를 적용. (react-markdown 9 는 `text` 키를 노출하지 않으므로 부모 블록을 가로채는 방식이 필요) |

### 5.4 Page UI Checklist

#### SummaryViewer (수정)

- [ ] 기존 요약 스트리밍 영역 유지 (좌측 패널, `flexBasis` 가변 분배 — 기본 50%)
- [ ] `citationTarget !== null` 일 때만 우측 패널(`flexBasis` 가변 — 기본 50%, 20%~80% clamp)에 `<PdfViewer />` 마운트 + 좌/우 사이 `<ResizeHandle />` 삽입
- [ ] `citationTarget === null` 일 때는 기존과 동일한 full-width 레이아웃
- [ ] 인용 버튼(`<CitationButton>`)이 ReactMarkdown 내부에 인라인 버튼으로 렌더
- [ ] 인용 버튼 키보드 포커스 가능 + `aria-label={t('citation.aria', { page: N })}`
- [ ] 인용 버튼 hover 시 `title="p.{N} 페이지 보기"` 툴팁
- [ ] 패널 열린 상태에서 `Esc` 키 → 패널 닫기
- [ ] 패널 너비 (`store.citationPanelWidth`) 가 `localStorage` 에 영속화되어 세션 간 복원

#### QaChat (수정)

- [ ] 기존 Q&A 메시지 렌더링 유지
- [ ] Q&A 답변 마크다운 내부의 `[p.N]` 도 동일 인용 버튼으로 렌더 (safe-markdown 전역 처리로 자동)
- [ ] 사용자 메시지(user)는 인용 변환 안 함 (text 유지) — safe-markdown 이 user 메시지에 적용되지 않으므로 자동

#### PdfViewer (신규)

- [ ] 상단바: 파일명 + 현재 페이지 / 총 페이지 표시 + 닫기 `×` 버튼
- [ ] 메인: 세로 스크롤 canvas 리스트 (전체 페이지 즉시 순차 렌더 — v0.18 가상 스크롤 예정)
- [ ] `targetPage` prop 변경 시 해당 페이지로 `scrollIntoView({ block: 'start' })`
- [ ] 로딩 스피너 (pdfjs getDocument 중)
- [ ] 에러 메시지 (pdf 로드 실패 시)
- [ ] 라이트 배경 강제 (PDF 는 white 가정)
- [ ] 모듈 캐시 `cachedDoc` 키잉: 동일 `pdfBytes` 참조면 재사용, 다른 bytes 시 stale 파기 후 재파싱 (DR-04). 언마운트 시 `pdf.destroy()` 는 호출하지 않고 `pdfDocRef.current = null` 만 해제

### 5.5 인용 버튼 시각 스펙

```css
/* CitationButton 기본 스타일 */
display: inline;
padding: 0 4px;
margin: 0 2px;
color: #2563eb;  /* blue-600 */
background: transparent;
border: 1px solid transparent;
border-radius: 3px;
font-size: 0.9em;
cursor: pointer;
font-weight: 500;
text-decoration: none;

/* hover */
background: #dbeafe;  /* blue-100 */
text-decoration: underline;

/* focus-visible */
outline: 2px solid #3b82f6;
outline-offset: 1px;

/* active (현재 클릭된 인용) */
background: #bfdbfe;  /* blue-200 */
```

### 5.6 사용자 피드백

- 인용 버튼 클릭 후 우측 패널 마운트에 수 초 걸릴 수 있음 (pdfjs getDocument)
  → 패널 슬롯에 로딩 스피너 즉시 표시
- 잘못된 페이지 번호(PDF 총 페이지 초과) → 인용 버튼은 여전히 렌더되지만 `disabled` + `title="유효하지 않은 페이지"` 로 표시

---

## 6. Error Handling

### 6.1 Error Code Definition

| Code | Message | Cause | Handling |
|------|---------|-------|----------|
| CITATION_INVALID_PAGE | 유효하지 않은 페이지 번호 | LLM 이 PDF 총 페이지 수를 초과한 인용 생성 | 버튼은 렌더하되 disabled + 툴팁 |
| PDFVIEWER_LOAD_FAIL | PDF 뷰어 로드 실패 | pdfjs.getDocument 실패 | 패널에 에러 메시지 + 닫기 버튼 |
| PDFVIEWER_RENDER_FAIL | 페이지 렌더 실패 | canvas 렌더 에러 | 해당 페이지만 "렌더 실패" 표시, 다른 페이지는 정상 |

### 6.2 Degraded Modes

| Condition | Behavior |
|---|---|
| LLM 이 인용 토큰을 하나도 생성 안 함 | `parseCitations` 가 전체를 `[{ type: 'text' }]` 로 반환 → 기존 렌더와 동일 (FR-12) |
| pdfjs getDocument 실패 | 에러 배너 표시, 요약/Q&A 영역은 정상 동작 |
| 인용 페이지가 PDF 범위 밖 | 버튼 disabled, 클릭 비활성, tooltip 안내 |
| PDF 가 OCR 모드로 파싱됨 | citation 동일하게 작동 (pageTexts[] 는 OCR 결과여도 페이지 단위 유지) |
| 인용 토큰이 코드블록 내부에 존재 | ReactMarkdown 이 code 블록 text 는 `components.code` 로 넘기므로 `p/li/td/th/em/strong` 오버라이드가 적용되지 않음 → 변환 없음 (의도) |

---

## 7. Security Considerations

- [x] 인용 버튼은 사용자 입력이 아닌 LLM 출력 기반 — XSS 여지 없음 (React 가 이미 text 이스케이프)
- [x] `CITATION_REGEX` 는 숫자 캡처만 — 정규식 인젝션 불가
- [x] `parseCitations` 는 순수 함수, side-effect 없음 — 재귀 깊이 제한 불필요
- [x] PdfViewer 는 이미 로드된 PDF ArrayBuffer 만 사용 — 외부 URL 접근 없음
- [x] pdfjs 워커는 기존 설정 재사용 (`pdf-parser.ts` 의 `GlobalWorkerOptions.workerSrc`)
- [x] citationTarget 상태는 page 번호(number)만 보관 — 임의 객체 주입 불가

---

## 8. Test Plan (v2.3.0)

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|------|--------|------|-------|
| L1: Unit (pure) | `parseCitations`, `formatPageLabel`, `chunkTextWithOverlapByPage`, `clampCitationPage` | vitest | Do |
| L2: Unit (store) | `setCitationTarget` + 초기화 동작 | vitest + zustand | Do |
| L3: Component | `CitationButton` 클릭 → store 상태 변경, `safe-markdown` text renderer 통합 | vitest + @testing-library/react | Do (부분) |
| L4: Manual smoke | 한국어 5p 샘플 PDF → 요약 → 인용 확인 → 클릭 → PdfViewer 스크롤 | 수동 | Check |

### 8.2 L1: Unit Test Scenarios

| # | 대상 | 케이스 | 기대 |
|---|------|--------|------|
| 1 | `parseCitations` | 단일 인용 `"text [p.12] tail"` | 3 segments (text, citation, text), citation.page = 12 |
| 2 | `parseCitations` | 다중 인용 `"a [p.1] b [p.2] c"` | 5 segments, pages [1, 2] |
| 3 | `parseCitations` | 공백 허용 `"[p. 12]"` | citation.page = 12 |
| 4 | `parseCitations` | 인용 없음 `"plain text"` | 1 text segment |
| 5 | `parseCitations` | 빈 문자열 | 빈 배열 |
| 6 | `parseCitations` | 잘못된 형식 `"[p.abc]"` | 전체가 text (not matched) |
| 7 | `parseCitations` | 0 또는 음수 페이지 `"[p.0]"`, `"[p.-1]"` | 0: text 그대로, 음수: text 그대로 |
| 8 | `formatPageLabel` | (5, 5) → `"[p.5]"`, (5, 7) → `"[p.5-7]"` | 두 케이스 모두 |
| 9 | `formatPageLabel` | undefined 처리 | `""` |
| 10 | `chunkTextWithOverlapByPage` | 3-page PDF, 짧은 청크 크기 | 각 청크의 pageStart/End 가 올바른 범위 |
| 11 | `chunkTextWithOverlapByPage` | overlap 경계 청크 | pageStart ≤ pageEnd, 범위 union |
| 12 | `chunkTextWithOverlapByPage` | 빈 pageTexts | 빈 배열 |
| 13 | `clampCitationPage` | (5, 3) → null, (2, 3) → 2, (-1, 3) → null | 세 케이스 |
| 14 | `VectorStore.addChunk` (확장) | pageStart/End 포함 addChunk + search | SearchResult 에 메타데이터 포함 |

### 8.3 L2: Store Test Scenarios

| # | 대상 | 시나리오 | 기대 |
|---|------|----------|------|
| 1 | `setCitationTarget` | 초기 상태 null | `citationTarget === null` |
| 2 | `setCitationTarget` | `{ page: 12 }` 세팅 | state 반영 |
| 3 | `setDocument(null)` | 기존 citationTarget 이 있었을 때 | citationTarget 초기화 (resetSummaryState 에 포함) |

### 8.4 L3: Component Test Scenarios

| # | 대상 | 시나리오 | 기대 |
|---|------|----------|------|
| 1 | `CitationButton` | 렌더 + 클릭 | store.setCitationTarget 호출, 인자 `{ page: 12 }` |
| 2 | `CitationButton` | `disabled` prop | 클릭 시 store 변경 없음 |
| 3 | `safeComponents.p` (또는 text) | `"text [p.5] tail"` | 3개 React child (text, button, text) |

### 8.5 L4: Manual Smoke (Check phase)

1. 한국어 5p 샘플 PDF 로드
2. 전체 요약 생성 → 응답에 `[p.N]` ≥ 1회 포함 확인
3. 인용 버튼 클릭 → 우측 패널 마운트 확인 (< 3s)
4. 해당 페이지로 스크롤 확인
5. 다른 인용 클릭 → 패널 유지, 스크롤만 변경
6. × 클릭 → 패널 닫기, SummaryViewer full-width 복귀
7. 같은 PDF 에서 Q&A 질문 → 답변에 인용 포함 확인 + 클릭 동작 확인
8. 새 PDF 드롭 → citationTarget 자동 초기화 확인

### 8.6 회귀 테스트

- 기존 `chunker.test.ts` 14 케이스 전부 pass
- 기존 `vector-store.test.ts` 9 케이스 전부 pass (addChunk 옵셔널 인자 추가로 기존 호출 호환)
- 기존 `pdf-parser.test.ts`, `ai-client.test.ts` 무변화
- 총 39 + 신규 L1/L2/L3 모두 pass

---

## 9. Clean Architecture

### 9.1 Layer Structure (This Feature)

Electron 앱의 전통적 레이어:

| Layer | Responsibility | Location |
|-------|---------------|----------|
| **Presentation** | React 컴포넌트, UI 상호작용 | `src/renderer/components/` |
| **Application** | React hooks, Zustand store, 워크플로 | `src/renderer/lib/use-*.ts`, `store.ts` |
| **Domain** | 순수 함수, 타입, 파싱 로직 | `src/renderer/lib/citation.ts`, `vector-store.ts`, `chunker.ts` |
| **Infrastructure** | IPC, pdfjs, 외부 의존성 | `src/main/ai-service.ts`, `src/preload/index.ts` |

### 9.4 This Feature's Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| `CitationButton` | Presentation | `src/renderer/components/CitationButton.tsx` |
| `PdfViewer` | Presentation | `src/renderer/components/PdfViewer.tsx` |
| `ResizeHandle` (DR-01) | Presentation | `src/renderer/components/ResizeHandle.tsx` |
| `SummaryViewer` (수정) | Presentation | `src/renderer/components/SummaryViewer.tsx` |
| `safeComponents.{p,li,td,th,em,strong}` (수정) | Presentation | `src/renderer/lib/safe-markdown.tsx` |
| `use-qa.ts` (수정) | Application | `src/renderer/lib/use-qa.ts` |
| `use-summarize.ts` (수정) | Application | `src/renderer/lib/use-summarize.ts` |
| `store.citationTarget` | Application | `src/renderer/lib/store.ts` |
| `citation.ts` | Domain (pure) | `src/renderer/lib/citation.ts` |
| `chunker.ts` (확장) | Domain (pure) | `src/renderer/lib/chunker.ts` |
| `vector-store.ts` (확장) | Domain (pure) | `src/renderer/lib/vector-store.ts` |
| `ai-service.ts` (프롬프트 수정) | Infrastructure | `src/main/ai-service.ts` |

---

## 10. Coding Convention Reference

### 10.1 Naming Conventions

프로젝트 기존 컨벤션 준수 (v0.16.2):

| Target | Rule | Example |
|--------|------|---------|
| Components | PascalCase | `PdfViewer`, `CitationButton` |
| Hooks | use prefix | `useT`, `useQa` |
| Functions | camelCase | `parseCitations`, `formatPageLabel` |
| Types/Interfaces | PascalCase | `CitationSegment`, `PageChunk` |
| Files (component) | PascalCase.tsx | `PdfViewer.tsx` |
| Files (utility) | camelCase.ts | `citation.ts` |
| Constants | UPPER_SNAKE_CASE | `CITATION_REGEX`, `MAX_VISIBLE_PAGES` |

### 10.2 This Feature's Conventions

| Item | Convention Applied |
|------|-------------------|
| Component naming | PascalCase, 1 component / 1 file |
| State management | Zustand (`useAppStore`) — 기존 패턴 |
| Error handling | React Error Boundary (기존 `AppErrorBoundary`) |
| i18n | `useT()` 훅 기반 반응형 번역 |
| Pure 함수 테스트 | vitest — 기존 `__tests__/` 패턴 |
| 인용 토큰 | 정규식 한 곳(`CITATION_REGEX`) — citation.ts 에만 정의 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
src/
├── renderer/
│   ├── components/
│   │   ├── PdfViewer.tsx          ← NEW
│   │   ├── CitationButton.tsx     ← NEW
│   │   ├── ResizeHandle.tsx       ← NEW (DR-01, v0.17.2)
│   │   └── SummaryViewer.tsx      ← MODIFIED (right panel slot + flexBasis + ResizeHandle)
│   │
│   ├── lib/
│   │   ├── citation.ts            ← NEW (pure functions + regex)
│   │   ├── chunker.ts             ← MODIFIED (+chunkTextWithOverlapByPage)
│   │   ├── vector-store.ts        ← MODIFIED (+pageStart/End on VectorChunk)
│   │   ├── use-qa.ts              ← MODIFIED (page-labeled context)
│   │   ├── use-summarize.ts       ← MODIFIED (page-labeled chunks)
│   │   ├── safe-markdown.tsx      ← MODIFIED (text renderer with parseCitations)
│   │   ├── store.ts               ← MODIFIED (+citationTarget, +citationPanelWidth)
│   │   ├── i18n.ts                ← MODIFIED (+citation.* keys)
│   │   └── __tests__/
│   │       ├── citation.test.ts   ← NEW
│   │       ├── chunker.test.ts    ← MODIFIED (+chunkTextWithOverlapByPage)
│   │       └── vector-store.test.ts ← MODIFIED (+page metadata)
│   │
└── main/
    └── ai-service.ts              ← MODIFIED (prompt instructions)
```

### 11.2 Implementation Order

1. [ ] **citation.ts** — 순수 함수 (parseCitations / formatPageLabel / clampCitationPage) + 정규식
2. [ ] **citation.test.ts** — 위 함수 단위 테스트 (13 케이스)
3. [ ] **chunker.ts** — `chunkTextWithOverlapByPage` 추가
4. [ ] **chunker.test.ts** — page-aware 청커 테스트 추가
5. [ ] **vector-store.ts** — VectorChunk/SearchResult 에 pageStart/End 필드
6. [ ] **vector-store.test.ts** — page 메타데이터 보존 테스트
7. [ ] **store.ts** — citationTarget 상태, setCitationTarget, resetSummaryState 통합
8. [ ] **i18n.ts** — KO/EN 신규 키 추가
9. [ ] **ai-service.ts** — 요약/Q&A 시스템 프롬프트에 인용 지시 추가
10. [ ] **use-qa.ts** — RAG 컨텍스트에 page 라벨 부착
11. [ ] **use-summarize.ts** — 청크 프롬프트에 page 라벨 부착
12. [ ] **safe-markdown.tsx** — p/li/td/th/em/strong 컴포넌트 오버라이드에서 `renderWithCitations` 헬퍼로 parseCitations 적용 (react-markdown 9 는 `text` 키 미제공)
13. [ ] **CitationButton.tsx** — 인라인 버튼 구현
14. [ ] **PdfViewer.tsx** — pdfjs 기반 뷰어 + 스크롤 로직 + ResizeObserver debounce 재렌더
15. [ ] **ResizeHandle.tsx** (DR-01, v0.17.2) — pointer capture / 키보드 Arrow·Home·End / ARIA slider, `store.citationPanelWidth` 구독·갱신 + `localStorage` 영속화
16. [ ] **SummaryViewer.tsx** — 우측 패널 슬롯 + citationTarget 구독 + ESC 닫기 + `flexBasis` 가변 분배 + `<ResizeHandle />` 통합
17. [ ] **전체 빌드 + 39 + 신규 테스트 pass**
18. [ ] **수동 smoke test (한국어 5p)**

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | Estimated Turns |
|--------|-----------|-------------|:---------------:|
| **Domain core** | `module-1` | citation.ts, chunker 확장, vector-store 확장, 테스트 | 12-15 |
| **App layer** | `module-2` | store.citationTarget, use-qa/use-summarize 컨텍스트, ai-service 프롬프트, i18n | 10-12 |
| **UI layer** | `module-3` | safe-markdown text renderer, CitationButton, PdfViewer, SummaryViewer 레이아웃 | 15-20 |
| **검증** | `module-4` | 단위/통합 테스트 실행, 회귀 확인, 수동 smoke | 5-8 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---------|-------|-------|:-----:|
| Session 1 | Plan + Design | 전체 | ✅ 완료 |
| Session 2 | Do | `--scope module-1` | 12-15 |
| Session 3 | Do | `--scope module-2` | 10-12 |
| Session 4 | Do | `--scope module-3` | 15-20 |
| Session 5 | Do + Check | `--scope module-4` | 10-15 |
| Session 6 | Report | 전체 | 5-8 |

> 단일 세션에서 전체 구현도 가능하나 (~45 turns), 세션 분할 시 각 세션이 완결적 모듈로 커밋 가능한 이점.

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-14 | 초안 작성 (PDCA Design phase, Option C 선택) | jjw |
| 0.2 | 2026-04-15 | DR-01 구현 반영 — §4.3 / §5.1 / §5.3 에 `ResizeHandle` · `citationPanelWidth` · `flexBasis` 기재. §5.4 가상화 표기를 실제 동작(전체 즉시 렌더)과 정합하도록 정정 | jjw |
| 0.3 | 2026-04-15 | 라운드 2 gap 제거 — §2.3 Dependencies 테이블에 `ResizeHandle` 행 추가 및 `PdfViewer` / `SummaryViewer` 의존성 갱신, §5.4 SummaryViewer 체크리스트의 "50% 고정" 잔존 표현을 `flexBasis` 가변 분배로 정정, §9.4 Layer Assignment 에 `ResizeHandle` 행 신설, §11.1 File Structure 에 `ResizeHandle.tsx` 및 store `citationPanelWidth` 반영, §11.2 Implementation Order 에 ResizeHandle 단계(#15) 삽입 | jjw |
