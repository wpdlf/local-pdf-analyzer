---
template: design
version: 1.0 (retroactive backfill)
feature: qa-answer-verification
date: 2026-04-20
author: jjw
project: local-pdf-analyzer
projectVersion: 0.18.0
phase: design (retroactive)
status: shipped
---

# Design — Q&A 답변 자동 검증

> **주의**: 소급 작성 문서. 실제 구현(`use-qa.ts`) 에서 역추출.

## 1. Architecture

```
 handleAsk(question)
   │
   ├─ useVerification 판정
   │   = settings.enableAnswerVerification !== false
   │   && ragState.isAvailable
   │   && ragIndex.size > 0
   │
   ├─ false → 기존 fast path (스트림을 qaStream 에 직접 append)
   │
   └─ true  → 2-pass pipeline
        │
        ├─ Step 1 Draft (qaVerifying=true, qaStream 미표시)
        │   └─ client.summarize() 의 토큰을 내부 draft 변수에만 수집
        │
        ├─ Step 2 Verify
        │   └─ verifyAnswerSentences(draft, verifyAbortRef.signal)
        │       ├─ splitIntoSentences → sentences (≤100)
        │       ├─ embedWithTimeout(sentences, signal) → embeddings
        │       └─ for each: ragIndex.search(emb, 1, 0) → max cosine
        │           └─ weakCount / avgScore 계산
        │
        └─ Step 3a (needsRefine=false) → appendQaStream(draft) + flush
           Step 3b (needsRefine=true)  → buildRefinePrompt → 2차 client.summarize 스트리밍
```

## 2. Key Data

### 2.1 파라미터 (`use-qa.ts:16-26`)

| Const | Value | Rationale |
|---|---:|---|
| `VERIFY_WEAK_SCORE` | 0.5 | cosine < 0.5 는 근거 거의 없음 — 보수적 threshold |
| `VERIFY_AVG_SCORE` | 0.65 | 전체 평균 < 0.65 면 답변 절반 이상이 약한 근거 |
| `VERIFY_MIN_SENTENCE_CHARS` | 15 | 15자 미만은 인용만 있는 라인/단일 키워드 noise |
| `VERIFY_MAX_SENTENCES` | 100 | ai:embed 배치 상한 200 의 절반, 비용/지연 보호 |

### 2.2 신규 Store 플래그

- `qaVerifying: boolean` — UI 가 "답변 준비 중" 스피너 표시용.
- `setQaVerifying(v)` — draft 진입 시 true, verify 완료 / refine 시작 / abort 시 false.

### 2.3 신규 Settings

- `enableAnswerVerification: boolean` (default true) — 사용자 토글.

## 3. Function Contracts

### `splitIntoSentences(text) → string[]`
- 연속 공백/개행 → 단일 공백 정규화 후 `(?<=[.!?。！？])\s+(?=\S)` 로 split.
- 길이 < `VERIFY_MIN_SENTENCE_CHARS` 필터링.

### `verifyAnswerSentences(answer, signal?) → { needsRefine, avgScore, weakCount, totalSentences }`
- Fail-safe: `ragIndex.size==0` 또는 `sentences.length==0` → `{ needsRefine: false, totalSentences: 0 }`.
- `embedWithTimeout(signal)` 실패 → 동일 fail-safe.
- `needsRefine = weakCount >= 1 || avgScore < VERIFY_AVG_SCORE`.

### `buildRefinePrompt(question, draft, context) → string`
- 초안 + 원문 컨텍스트 + refine 지시(근거 없는 주장 제거, 문체 유지, [p.N] 인용 처리 규칙).

## 4. Abort Semantics

| Scope | RequestId | Aborted by |
|---|---|---|
| Draft LLM 호출 | `qaRequestId` (prepareSummarize 반환) | `handleQaAbort` → `ai.abort(reqId)` |
| Verify embedding 배치 | `rag-*` (embedWithTimeout 내부) | `verifyAbortRef.signal` → embedWithTimeout 의 onAbort → `ai.abort(batchReqId)` |
| Refine LLM 호출 | 신규 `qaRequestId` | 동일 |

**v0.18.1 수정**: Design 최초 릴리즈 시 verifyAbortRef 미존재 → `handleAsk` 에서 `AbortController` 생성 + `verifyAnswerSentences(draft, verifyAbortRef.signal)` 전달로 보완.

## 5. Settings Pipeline

`enableAnswerVerification` 은 renderer `types/index.ts:105,181`, `settings` store, SettingsPanel 토글 UI 에 더해 **main 측 네 지점** 등록 필수:

1. `defaultSettings` (`main/index.ts:24`)
2. `VALID_SETTINGS_KEYS_SET` (loadSettings 필터, `:37`)
3. `VALID_SETTINGS_KEYS` (settings:set 화이트리스트, `:332`)
4. `switch(key)` 타입 검증 case (`:394-433`)

**v0.18.1 수정**: v0.18.0 최초 릴리즈 시 네 지점 모두 누락 → 토글 OFF 후 재시작 시 true 로 복원. v0.18.1 에서 모두 추가.

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 1.0 | 2026-04-20 | Retroactive backfill + v0.18.1 후속 수정 사항 반영 | jjw |
