---
template: plan
version: 1.0 (retroactive backfill)
feature: qa-answer-verification
date: 2026-04-20
author: jjw
project: local-pdf-analyzer
projectVersion: 0.18.0 (shipped 2026-04-20)
phase: plan (retroactive)
status: shipped
---

# Plan — Q&A 답변 자동 검증 (Hallucination 감지)

> **주의**: v0.18.0 은 PDCA Plan/Design 경유 없이 릴리즈되었음. 본 문서는 2026-04-20 **소급 작성**(retroactive backfill) 으로, 코드(`use-qa.ts:326-413, 576-637`) 에서 역으로 의도를 문서화한 것.

## 1. Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | LLM 이 문서에 근거 없는 주장을 생성하는 hallucination 을 자동 감지·완화. 사용자가 신뢰할 수 없는 답변을 그대로 읽게 되는 UX 리스크. |
| **WHO** | 학생/연구자 — 요약·Q&A 의 정확성이 학습 결과에 직결. 인용 클릭으로 원문 검증은 v0.17 에서 추가되었으나 검증을 **자동화** 하는 레이어 필요. |
| **RISK** | (1) 추가 LLM/embedding 호출로 응답 지연 (2) OpenAI 사용자 토큰 과금 증가 (3) refine 프롬프트가 무시되어 동일 답변 재생성 (4) fail-safe 미흡 시 RAG 빈 상태에서 모든 답변이 차단됨 |
| **SUCCESS** | 근거 없는 문장이 포함된 답변이 자동으로 refine 되고, 근거 있는 답변은 기존 지연 없이 통과. UI 상 "한 번의 답변" 으로만 보여야 함. |
| **SCOPE** | v0.18.0: 문장 단위 검증 + 2-pass(draft→refine). 외부 요약 경로는 영향 없음. 토글 OFF 시 기존 단일-pass fast path. |

## 2. Goals & Non-Goals

**Goals**
- G1. Draft 답변의 각 문장을 RAG 인덱스와 cosine 유사도 대조.
- G2. weak 문장 1+ 또는 평균 < 임계 시 refine 프롬프트로 재호출.
- G3. UI 상 draft 는 사용자에게 노출하지 않음 (silent refine).
- G4. RAG 비활성/임베딩 실패/빈 draft 시 기존 단일-pass 로 fail-safe.

**Non-Goals**
- 요약(summarize) 경로의 hallucination 감지 (별도 feature).
- Hallucination 이 감지되었을 때 사용자에게 경고 표시 (UI 전환 비용 대비 효과 불확실).
- 인용([p.N]) 자동 삽입/수정 (v0.17 citation feature 가 커버).

## 3. Constraints

- **IPC 배치 한계**: `ai:embed` 한 번에 최대 200 sentences. → `VERIFY_MAX_SENTENCES=100` 으로 상한.
- **비용**: OpenAI text-embedding-3-small 이 질문당 최대 100 문장을 추가 임베딩. 비용 민감 사용자에게 토글 OFF 제공 필요.
- **지연**: draft 가 완전히 끝난 후에야 verify 시작 → 응답 체감 지연. 감수하되 스피너로 기대치 관리.

## 4. Definition of Done

- [x] `settings.enableAnswerVerification` 토글 추가 (기본 true)
- [x] `verifyAnswerSentences` 구현 + fail-safe 경로
- [x] `buildRefinePrompt` 구현
- [x] `qaVerifying` 스토어 플래그 + QaChat 스피너
- [x] 기존 단일-pass 경로 회귀 0
- [ ] ~~Plan/Design 문서 작성~~ → v0.18.1 에서 backfill (본 문서)
- [ ] ~~단위 테스트~~ → v0.18.1 에서 추가 (`qa-verify.test.ts` 11 케이스)
- [ ] ~~설정 키 main 측 저장 파이프라인~~ → v0.18.1 에서 수정 (Critical C1)
- [ ] ~~verify 경로 abort signal 연결~~ → v0.18.1 에서 수정 (High H1)

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 1.0 | 2026-04-20 | Retroactive backfill — v0.18.0 릴리즈 후 소급 작성 | jjw |
