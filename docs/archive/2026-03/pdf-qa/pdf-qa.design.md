# PDF Q&A Design Document

> **Feature**: pdf-qa
> **Architecture**: Option C (실용적 균형)
> **Plan**: [pdf-qa.plan.md](../../01-plan/features/pdf-qa.plan.md)
> **Date**: 2026-03-30

---

## Context Anchor

| Anchor | Content |
|--------|---------|
| **WHY** | 요약은 전체 윤곽만 제공, 세부 내용 확인에는 원문 탐색이 필요 → Q&A로 해소 |
| **WHO** | 시험 준비 중인 대학생 |
| **RISK** | 로컬 LLM 컨텍스트 윈도우 한계 (4K~8K), 긴 PDF에서 관련 텍스트 선별 정확도 |
| **SUCCESS** | PDF 내용 기반 질문에 정확한 답변, 10턴 대화 유지, 스트리밍 실시간 표시 |
| **SCOPE** | 채팅 UI + Q&A 프롬프트 + 대화 이력 관리 + 관련 텍스트 검색 |

---

## 1. Overview

### 1.1 Architecture Decision

**Option C: 실용적 균형** — 기존 `ai:generate` IPC를 `type: 'qa'`로 확장하고, Q&A 전용 훅(`use-qa.ts`)과 UI 컴포넌트(`QaChat.tsx`)를 신규 생성. Store에 Q&A 섹션을 추가하여 요약과 독립적으로 상태 관리.

### 1.2 Component Diagram

```
┌─────────────────────────────────────────────────┐
│                 SummaryViewer                     │
│  ┌─────────────────────────────────────────┐     │
│  │         요약 결과 (Markdown)              │     │
│  │         (기존 그대로)                      │     │
│  └─────────────────────────────────────────┘     │
│  ┌─────────────────────────────────────────┐     │
│  │         QaChat (신규)                     │     │
│  │  ┌─────────────────────────────────┐     │     │
│  │  │  대화 목록 (user/assistant)      │     │     │
│  │  │  스트리밍 답변 표시              │     │     │
│  │  └─────────────────────────────────┘     │     │
│  │  ┌──────────────────────┐ ┌────┐         │     │
│  │  │  질문 입력 (textarea) │ │전송│         │     │
│  │  └──────────────────────┘ └────┘         │     │
│  └─────────────────────────────────────────┘     │
└─────────────────────────────────────────────────┘
```

---

## 2. Data Model

### 2.1 새 타입 정의 (`types/index.ts`)

```typescript
// Q&A 메시지
export interface QaMessage {
  role: 'user' | 'assistant';
  content: string;
}
```

### 2.2 Store 확장 (`store.ts`)

```typescript
// AppState에 추가
qaMessages: QaMessage[];
qaStream: string;
isQaGenerating: boolean;
qaRequestId: string | null;
appendQaStream: (token: string) => void;
flushQaStream: () => void;
clearQaStream: () => void;
addQaMessage: (msg: QaMessage) => void;
clearQa: () => void;
```

**Q&A 스트림 버퍼**: 요약과 동일한 50ms 배치 패턴 사용하되, 별도 `qaStreamState` 객체로 격리.

---

## 3. IPC 확장

### 3.1 `ai:generate` type 확장

기존 `type: 'full' | 'chapter' | 'keywords'`에 `'qa'` 추가:

```typescript
// preload/index.ts, main/index.ts
type: 'full' | 'chapter' | 'keywords' | 'qa';
```

### 3.2 Q&A 프롬프트 빌더 (`ai-service.ts`)

`buildPrompt`에 `'qa'` case 추가:

```typescript
case 'qa':
  return `당신은 대학교 강의자료 Q&A 도우미입니다.
반드시 한국어로 답변하세요.

## 규칙
1. 다음 강의자료 내용만을 참고하여 질문에 답하세요
2. 자료에 없는 내용은 "자료에서 해당 내용을 찾을 수 없습니다"라고 답하세요
3. 수식/공식은 원문 그대로 인용하세요
4. 답변은 간결하고 정확하게, 마크다운 형식으로 작성하세요
5. 인사말, 감상평 없이 답변만 출력하세요

---

${text}`;
```

`text` 파라미터에는 renderer 측에서 조립한 `[컨텍스트] + [대화 이력] + [현재 질문]` 전체 문자열이 전달됨.

---

## 4. 관련 텍스트 선별 (Context Selection)

### 4.1 알고리즘 (`use-qa.ts` 내부)

```
function selectRelevantChunks(
  question: string,
  chunks: string[],
  maxChars: number
): string[]
```

1. **Short-circuit**: 전체 텍스트 ≤ `maxChars` → 전체 반환
2. **키워드 추출**: 질문에서 불용어(은/는/이/가/을/를/의/에/로 등) 제거 → 2자 이상 토큰 추출
3. **TF 스코어링**: 각 청크별 키워드 출현 빈도 합산
4. **상위 선택**: 스코어 높은 순으로 `maxChars` 이내까지 청크 추가
5. **Fallback**: 매칭 청크가 없으면 → 첫 번째 청크 + 마지막 청크 (서론 + 결론)

### 4.2 컨텍스트 윈도우 관리

```
총 컨텍스트 = 시스템 프롬프트 (~200자)
            + PDF 텍스트 컨텍스트 (maxChunkSize * charsPerToken 내)
            + 대화 이력 (10턴 × 평균 300자 = ~3000자)
            + 현재 질문 (~200자)
```

`maxChunkSize` 기본 4000토큰 = 한글 ~6000자. 대화 이력 + 프롬프트 오버헤드 ~3500자를 빼면, **PDF 컨텍스트에 ~6500자** 할당 가능 (충분).

---

## 5. UI 설계

### 5.1 QaChat 컴포넌트 (`QaChat.tsx`)

**위치**: `SummaryViewer` 하단, 요약 완료 후 (`!isGenerating && summaryStream`) 표시

**레이아웃**:
```
┌─────────────────────────────────────┐
│ 💬 강의자료에 대해 질문하세요        │  ← 헤더
├─────────────────────────────────────┤
│ [User] OLS 추정량의 분산 공식은?    │  ← 대화 목록
│ [AI]   OLS 추정량의 분산은...       │     (스크롤 가능)
│ [User] BLUE 조건은?                 │
│ [AI]   Gauss-Markov 정리에...       │
│ [AI streaming...] █                 │  ← 스트리밍 중
├─────────────────────────────────────┤
│ ┌─────────────────────────┐ ┌────┐ │  ← 입력 영역
│ │ 질문을 입력하세요...     │ │ → │ │
│ └─────────────────────────┘ └────┘ │
└─────────────────────────────────────┘
```

**키 인터랙션**:
- `Enter`: 전송
- `Shift+Enter`: 줄바꿈
- 전송 중: 입력 비활성화 + 중지 버튼 표시
- 대화 목록: 자동 스크롤 (하단 고정)

### 5.2 SummaryViewer 수정

기존 액션 버튼 영역 아래에 `<QaChat />` 조건부 렌더링:

```tsx
{/* 요약 완료 후 Q&A 채팅 */}
{summaryStream && !isGenerating && <QaChat />}
```

---

## 6. use-qa 훅 설계

```typescript
export function useQa() {
  // Store 상태
  const qaMessages = useAppStore((s) => s.qaMessages);
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);

  const handleAsk = async (question: string) => {
    // 1. 질문 유효성 검사
    // 2. 상호 배제: isGenerating 중이면 거부
    // 3. addQaMessage({ role: 'user', content: question })
    // 4. PDF 텍스트에서 관련 청크 선별
    // 5. 대화 이력 + 컨텍스트 + 질문 조립
    // 6. ai:generate(requestId, { text, type: 'qa', ... }) 호출
    // 7. 스트리밍 수신 → appendQaStream
    // 8. 완료 시 addQaMessage({ role: 'assistant', content })
    // 9. 10턴 FIFO 정리
  };

  const handleQaAbort = () => {
    // abort 요청 + 상태 정리
  };

  return { handleAsk, handleQaAbort, qaMessages, isQaGenerating };
}
```

---

## 7. 데이터 흐름

```
[사용자 질문 입력]
       │
       ▼
[use-qa: selectRelevantChunks(question, chunks)]
       │
       ▼
[프롬프트 조립: 시스템 + 컨텍스트 + 대화이력 + 질문]
       │
       ▼
[IPC: ai:generate(requestId, { text, type: 'qa' })]
       │
       ▼
[Main: buildPrompt(text, 'qa') → streamRequest]
       │
       ▼
[IPC: ai:token → appendQaStream (50ms 배치)]
       │
       ▼
[QaChat: 스트리밍 답변 실시간 표시]
       │
       ▼
[IPC: ai:done → flushQaStream → addQaMessage]
```

---

## 8. 파일 변경 목록

### 8.1 신규 파일

| 파일 | 역할 | 예상 줄 수 |
|------|------|-----------|
| `src/renderer/lib/use-qa.ts` | Q&A 훅 (질문 전송, 컨텍스트 선별, 대화 이력) | ~150줄 |
| `src/renderer/components/QaChat.tsx` | 채팅 UI (대화 목록 + 입력란) | ~120줄 |

### 8.2 수정 파일

| 파일 | 변경 내용 | 예상 변경 |
|------|-----------|----------|
| `src/renderer/types/index.ts` | `QaMessage` 인터페이스 추가 | +5줄 |
| `src/renderer/lib/store.ts` | Q&A 상태 + 액션 추가 (qaMessages, qaStream, etc) | +60줄 |
| `src/main/ai-service.ts` | `buildPrompt`에 `'qa'` case 추가 | +20줄 |
| `src/main/index.ts` | `ai:generate` type 검증에 `'qa'` 추가 | +1줄 |
| `src/preload/index.ts` | generate type에 `'qa'` 추가 | +1줄 |
| `src/renderer/components/SummaryViewer.tsx` | QaChat import + 조건부 렌더링 | +5줄 |
| `src/main/index.ts` | 윈도우 기본 크기 900x700 → 1000x800 확대 | ~2줄 |

### 8.3 총 예상

| 항목 | 수량 |
|------|------|
| 신규 파일 | 2개 |
| 수정 파일 | 6개 |
| 추가 코드 | ~360줄 |

---

## 9. 상호 배제 (Mutual Exclusion)

요약과 Q&A가 동시에 실행되지 않도록:

```typescript
// use-qa.ts
const handleAsk = async (question: string) => {
  const state = useAppStore.getState();
  if (state.isGenerating || state.isQaGenerating) return;
  // ...
};

// use-summarize.ts (기존)
const handleSummarize = async () => {
  const state = useAppStore.getState();
  if (!state.document || state.isGenerating || state.isQaGenerating) return;
  // ...
};
```

---

## 10. 엣지 케이스

| 케이스 | 처리 |
|--------|------|
| PDF 미업로드 상태에서 Q&A | QaChat 미렌더링 (summaryStream 없으면 표시 안 함) |
| 빈 질문 전송 | `trim()` 후 빈 문자열이면 무시 |
| 답변 중 PDF 닫기 | `handleClose`에서 qa abort + clearQa 호출 |
| 10턴 초과 | 가장 오래된 Q&A 쌍 제거 (FIFO) |
| 매우 긴 질문 | 1000자 상한 적용 |
| 키워드 매칭 실패 | 첫 번째 + 마지막 청크 fallback |

---

## 11. Implementation Guide

### 11.1 구현 순서

1. `types/index.ts` — `QaMessage` 타입 추가
2. `store.ts` — Q&A 상태 섹션 추가
3. `ai-service.ts` — `buildPrompt` qa case + `index.ts` type 검증
4. `preload/index.ts` — type 확장
5. `use-qa.ts` — Q&A 훅 구현 (핵심 로직)
6. `QaChat.tsx` — 채팅 UI 컴포넌트
7. `SummaryViewer.tsx` — QaChat 통합
8. 빌드 + 테스트

### 11.2 의존성

```
[1. types] → [2. store] → [3. ai-service + 4. preload]
                                    ↓
                             [5. use-qa] → [6. QaChat] → [7. SummaryViewer]
```

### 11.3 Session Guide

| Module | 파일 | 설명 |
|--------|------|------|
| module-1 | types, store, ai-service, preload, index.ts | 백엔드 + 상태 기반 |
| module-2 | use-qa, QaChat, SummaryViewer | 프론트엔드 훅 + UI |

단일 세션에서 전체 구현 가능 (~360줄).
