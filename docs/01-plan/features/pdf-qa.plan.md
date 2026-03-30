# PDF Q&A (질문응답) 기능 Planning Document

> **Summary**: 업로드된 PDF 강의자료의 내용에 대해 사용자가 자연어로 질문하면, PDF 텍스트 범위 내에서 AI가 답변하는 대화형 Q&A 기능
>
> **Project**: summary-lecture-material
> **Feature**: pdf-qa
> **Version**: 0.10.0
> **Author**: jjw
> **Date**: 2026-03-30
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 요약만으로는 세부 개념이나 특정 내용을 확인하기 어려워, 결국 원문 PDF를 다시 찾아 읽어야 하는 비효율 발생 |
| **Solution** | 요약 결과 하단에 채팅 입력란을 제공하여, PDF 텍스트를 컨텍스트로 활용한 AI Q&A 대화 기능 구현 (Ollama/Claude/OpenAI 공용) |
| **Function/UX Effect** | 요약을 보며 궁금한 점을 바로 질문 → AI가 PDF 내용 기반으로 실시간 스트리밍 답변 → 최대 10턴 대화 유지 |
| **Core Value** | PDF를 다시 열지 않고 한 화면에서 요약 + 심화 학습 완결 — 학습 흐름 끊김 제거 |

---

## Context Anchor

| Anchor | Content |
|--------|---------|
| **WHY** | 요약은 전체 윤곽만 제공, 세부 내용 확인에는 원문 탐색이 필요 → Q&A로 해소 |
| **WHO** | 시험 준비 중인 대학생, 강의자료 복습 중 특정 개념을 빠르게 확인하고 싶은 사용자 |
| **RISK** | 로컬 LLM 컨텍스트 윈도우 한계 (4K~8K), 긴 PDF에서 관련 텍스트 선별 정확도 |
| **SUCCESS** | PDF 내용 기반 질문에 정확한 답변 제공, 10턴 대화 유지, 스트리밍 실시간 표시 |
| **SCOPE** | 채팅 UI + Q&A 프롬프트 + 대화 이력 관리 + 관련 텍스트 검색 (기존 AI 인프라 재사용) |

---

## 1. Overview

### 1.1 Purpose

PDF 요약 후 세부 내용에 대한 추가 질문을 같은 화면에서 해결할 수 있게 하여, 학습 효율을 극대화한다.

### 1.2 Background

- 요약은 전체 구조를 파악하는 데 유용하지만, "이 수식의 유도 과정은?", "A와 B의 차이는?" 같은 세부 질문에는 답할 수 없음
- 사용자가 원문 PDF를 다시 열어 해당 부분을 찾는 것은 비효율적
- 이미 추출된 PDF 텍스트(`extractedText`, `pageTexts`, `chapters`)와 AI 인프라(Ollama/Claude/OpenAI 스트리밍)가 있으므로 추가 구현 비용이 낮음

---

## 2. Scope

### 2.1 In Scope

- [ ] 요약 결과 하단에 질문 입력 UI (채팅 인터페이스)
- [ ] PDF 텍스트를 컨텍스트로 활용한 Q&A 프롬프트 생성
- [ ] 대화 이력 최대 10턴 유지 (컨텍스트 윈도우 내 관리)
- [ ] AI 스트리밍 답변 실시간 표시 (기존 인프라 재사용)
- [ ] 긴 PDF 대응: 질문 키워드 기반 관련 청크 선별
- [ ] 답변 중 중지 기능 (기존 abort 인프라 재사용)

### 2.2 Out of Scope

- 벡터 DB/임베딩 기반 검색 (RAG) — 로컬 환경 복잡도 증가
- Q&A 이력 영구 저장 — 세션 내 메모리만 사용
- 이미지 기반 질문 — 텍스트 Q&A만 지원
- 다중 PDF 교차 질문

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | 요약 결과 하단에 채팅 입력란 + 전송 버튼 표시 | High | Pending |
| FR-02 | 사용자 질문 입력 시 PDF 텍스트를 컨텍스트로 포함한 프롬프트 생성 | High | Pending |
| FR-03 | AI 답변을 실시간 스트리밍으로 표시 (마크다운 렌더링) | High | Pending |
| FR-04 | 대화 이력 최대 10턴 유지 (질문+답변 쌍, FIFO) | High | Pending |
| FR-05 | 대화 이력을 프롬프트에 포함하여 맥락 이해 | High | Pending |
| FR-06 | 긴 PDF(>maxChunkSize): 질문 키워드로 관련 청크 선별 | Medium | Pending |
| FR-07 | 답변 생성 중 "중지" 기능 (기존 abort 재사용) | Medium | Pending |
| FR-08 | Q&A 모드에서도 기존 요약 내용 스크롤 가능 | Medium | Pending |
| FR-09 | PDF 닫기 시 Q&A 대화 이력도 함께 초기화 | Medium | Pending |
| FR-10 | Enter 키로 전송, Shift+Enter로 줄바꿈 | Low | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement |
|----------|----------|-------------|
| Performance | 질문 전송 후 첫 토큰 표시 2초 이내 (로컬 Ollama) | 타이머 |
| UX | 요약 내용과 Q&A 영역이 시각적으로 명확히 구분 | 사용성 |
| Memory | 대화 이력 10턴 초과 시 자동 FIFO 정리 | 메모리 모니터링 |
| Compatibility | 기존 요약 기능에 영향 없음 (회귀 방지) | 빌드 + 테스트 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] PDF 업로드 → 요약 → Q&A 질문 → 답변 수신 전체 플로우 동작
- [ ] 대화 이력 10턴 유지 및 FIFO 정리 동작
- [ ] 긴 PDF에서 관련 청크 선별 후 답변 생성
- [ ] 답변 중 중지 기능 동작
- [ ] 기존 요약 기능 회귀 없음 (빌드 성공 + 기존 테스트 통과)

### 4.2 Quality Criteria

- [ ] TypeScript 컴파일 에러 없음
- [ ] 빌드 성공
- [ ] Q&A 답변이 PDF 내용 범위 내에서만 생성됨 (프롬프트 제약)

---

## 5. Technical Approach

### 5.1 기존 인프라 재사용

| 기존 컴포넌트 | Q&A에서의 역할 |
|---------------|---------------|
| `ai-service.ts` (streamRequest) | Q&A 답변 스트리밍 생성 |
| `ai-client.ts` (AiClient.summarize) | Q&A용 generator로 확장 또는 별도 메서드 |
| `store.ts` (appendStream, flushStream) | 답변 스트리밍 버퍼링 |
| `chunker.ts` (chunkText) | 관련 텍스트 선별 시 청크 재사용 |
| `SummaryViewer.tsx` | Q&A 채팅 UI 추가 영역 |
| `use-summarize.ts` (abort 흐름) | Q&A abort 패턴 재사용 |

### 5.2 Q&A 프롬프트 전략

```
[시스템]
당신은 강의자료 Q&A 도우미입니다.
다음 강의자료 내용만을 참고하여 질문에 답하세요.
자료에 없는 내용은 "자료에서 해당 내용을 찾을 수 없습니다"라고 답하세요.

[컨텍스트]
{관련 PDF 텍스트 (청크 선별 결과)}

[대화 이력]
Q: {이전 질문 1}
A: {이전 답변 1}
...

[현재 질문]
{사용자 질문}
```

### 5.3 관련 텍스트 선별 (키워드 매칭)

1. 전체 텍스트가 maxChunkSize 이내면 → 전체 전달
2. 초과 시 → 질문에서 키워드 추출 → 각 청크별 키워드 출현 빈도 계산 → 상위 N개 청크 선택
3. 벡터 DB 불필요 — 단순 TF 기반 키워드 매칭으로 충분 (학술 자료는 전문 용어가 명확)

### 5.4 새로 추가할 파일

| 파일 | 역할 |
|------|------|
| `src/renderer/lib/use-qa.ts` | Q&A 훅 (질문 전송, 대화 이력 관리, 관련 텍스트 선별) |
| `src/renderer/components/QaChat.tsx` | 채팅 UI 컴포넌트 (입력란 + 대화 목록) |
| `src/main/ai-service.ts` (수정) | Q&A용 프롬프트 빌더 (`buildQaPrompt`) 추가 |

### 5.5 Store 확장

```typescript
// store.ts에 추가
qaMessages: QaMessage[];       // { role: 'user'|'assistant', content: string }[]
qaStream: string;              // 현재 답변 스트리밍 버퍼
isQaGenerating: boolean;
appendQaStream: (token: string) => void;
clearQa: () => void;
addQaMessage: (msg: QaMessage) => void;
```

---

## 6. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 컨텍스트 윈도우 초과 (긴 PDF + 대화 이력) | High | Medium | 관련 청크만 선별 + 대화 이력 10턴 FIFO + 이전 답변 축약 |
| 키워드 매칭으로 관련 텍스트 못 찾음 | Medium | Low | 챕터 기반 fallback (질문과 가장 관련 높은 챕터 전달) |
| 로컬 LLM 답변 품질 한계 | Medium | Medium | 프롬프트에 "자료에 없으면 없다고 답하라" 제약 + 유료 API 전환 지원 |
| 요약과 Q&A 동시 실행 충돌 | High | Low | isGenerating/isQaGenerating 상호 배제 가드 |
| UI 복잡도 증가 | Low | Medium | SummaryViewer 하단에 최소한의 채팅 UI만 추가 |

---

## 7. Estimation

| Item | Estimate |
|------|----------|
| 새 파일 | 2개 (`use-qa.ts`, `QaChat.tsx`) |
| 수정 파일 | ~5개 (`ai-service.ts`, `store.ts`, `types/index.ts`, `SummaryViewer.tsx`, `preload/index.ts`) |
| 예상 추가 코드 | ~400줄 |
| 복잡도 | Medium (기존 인프라 재사용으로 핵심 로직은 적음) |
