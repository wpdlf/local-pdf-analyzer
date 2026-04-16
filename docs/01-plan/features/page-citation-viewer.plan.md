---
template: plan
version: 1.3
feature: page-citation-viewer
date: 2026-04-14
author: jjw
project: local-pdf-analyzer (summary-lecture-material)
projectVersion: 0.16.2
status: Draft
---

# page-citation-viewer Planning Document

> **Summary**: AI 요약/Q&A 답변에 페이지 인용 토큰(`[p.N]`)을 자동 부여하고, 클릭 시 우측 패널에 pdfjs 뷰어를 온디맨드로 띄워 해당 페이지로 스크롤한다.
>
> **Project**: local-pdf-analyzer
> **Version**: 0.16.2
> **Author**: jjw
> **Date**: 2026-04-14
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | AI 요약/Q&A 답변이 PDF 의 어느 페이지에서 도출되었는지 표시되지 않아 사용자가 환각(hallucination) 여부를 검증할 수 없음 |
| **Solution** | 청크에 page 메타데이터 부착 + 프롬프트로 LLM 이 `[p.N]` 인용 자동 삽입 + 클릭 시 우측에 pdfjs 뷰어 패널 온디맨드 마운트 |
| **Function/UX Effect** | 요약/Q&A 신뢰도 검증 가능, 출처 페이지를 1-click 으로 확인, "AI 답변 → 원문 검증" 워크플로 단축 |
| **Core Value** | 학습/연구/검토 use case 의 핵심 페인포인트 해결 — "출처 검증 가능한 로컬 AI PDF 분석기" 포지셔닝 강화 |

---

## Context Anchor

> Auto-generated from Executive Summary. Propagated to Design/Do documents for context continuity.

| Key | Value |
|-----|-------|
| **WHY** | LLM 출력의 환각 여부를 사용자가 직접 검증할 수 없는 신뢰도 문제 해결 |
| **WHO** | 학생/연구자/검토자 — 요약 결과를 신뢰하기 위해 원문 확인이 필수인 사용자 |
| **RISK** | RAG 청커 변경이 기존 v0.16.2 검색 정확도에 회귀 영향, pdfjs 뷰어 마운트 시 메모리 spike |
| **SUCCESS** | (1) 요약/Q&A 답변에 ≥1개 인용 토큰 포함 (2) 인용 클릭 → 정확한 페이지 스크롤 (3) 기존 RAG 테스트 39/39 회귀 없음 |
| **SCOPE** | Phase 1: 청크 page 메타데이터 + 프롬프트 / Phase 2: 인용 마크다운 렌더링 / Phase 3: 온디맨드 PdfViewer 패널 |

---

## 1. Overview

### 1.1 Purpose

LLM 이 생성한 요약과 Q&A 답변에 출처 페이지 인용을 부착하고, 사용자가 1-click 으로 원문을 확인할 수 있도록 사이드 PDF 뷰어 패널을 통합한다. "AI 가 환각으로 만든 내용인가?" 를 사용자가 직접 검증할 수 있는 출처 추적(source attribution) 기능.

### 1.2 Background

v0.16.2 까지의 개선은 **안정성·UX·보안** 에 집중되었다. 핵심 가치 측면에서 사용자의 가장 큰 미해결 페인포인트는 "AI 답변을 신뢰할 수 없음 — 환각인지 확인 불가". 학습/연구 use case 에서 요약·Q&A 결과로 의사결정을 하기 어려운 근본 원인. 이번 기능은 이 신뢰도 격차를 해소한다.

### 1.3 Related Documents

- v0.16.2 릴리즈 노트: https://github.com/wpdlf/local-pdf-analyzer/releases/tag/v0.16.2
- 기존 청커: `src/renderer/lib/chunker.ts`
- 기존 RAG 검색: `src/renderer/lib/use-qa.ts`, `src/renderer/lib/vector-store.ts`
- 요약 hook: `src/renderer/lib/use-summarize.ts`

---

## 2. Scope

### 2.1 In Scope

- [ ] PDF 파서가 청크별 `pageStart`/`pageEnd` 메타데이터 산출 (chunkTextWithOverlapByPage)
- [ ] VectorStore 가 청크 텍스트와 함께 page 정보를 보관·반환
- [ ] RAG 검색 결과가 page 메타데이터 포함하여 use-qa 에 전달됨
- [ ] 요약 프롬프트에 "각 핵심 사실 끝에 `[p.N]` 표기" 명시 추가
- [ ] Q&A 프롬프트에 동일 인용 지시 추가, RAG 컨텍스트가 `[p.N]` 으로 라벨링
- [ ] safe-markdown 이 `[p.N]` 패턴을 인터랙티브 인용 컴포넌트로 변환
- [ ] 신규 `PdfViewer` 컴포넌트 (pdfjs-dist 기반, canvas 렌더링, 가상 스크롤)
- [ ] 인용 클릭 시 우측 패널 온디맨드 마운트 + 해당 페이지 스크롤
- [x] 패널 닫기/리사이즈 (v0.17.2 DR-01 구현)
- [ ] i18n KO/EN 키 추가
- [ ] 단위 테스트: chunkTextWithOverlapByPage, 인용 파싱, page 메타데이터 보존

### 2.2 Out of Scope

- 텍스트 조각 단위 하이라이트 (textLayer 매칭) — Phase 4 후속
- 페이지 범위 인용(`[p.12-15]`) / 다중 인용(`[p.12, p.18]`) — Phase 4 후속
- PDF 내 텍스트 검색·복사 기능
- PDF 주석 작성/저장
- 외부 PDF 뷰어 (Adobe, 내장 Chrome) 연동
- v0.15 이하 호환성

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | 청크 빌드 시 `pageStart`/`pageEnd` 메타데이터 부착 | High | Pending |
| FR-02 | VectorStore 가 page 메타데이터 보관·반환 | High | Pending |
| FR-03 | RAG 검색 결과가 use-qa 에 page 정보 전달 | High | Pending |
| FR-04 | 요약 프롬프트에 `[p.N]` 인용 지시 추가 + 컨텍스트 라벨링 | High | Pending |
| FR-05 | Q&A 프롬프트에 `[p.N]` 인용 지시 추가 + 컨텍스트 라벨링 | High | Pending |
| FR-06 | safe-markdown 이 `[p.N]` 을 클릭 가능한 `<button>` 으로 변환 | High | Pending |
| FR-07 | PdfViewer 컴포넌트 — pdfjs 기반 페이지 렌더링 + 스크롤 | High | Pending |
| FR-08 | 인용 클릭 → 우측 패널 마운트 → 해당 페이지로 스크롤 | High | Pending |
| FR-09a | 패널 닫기 버튼 (× / ESC) | Medium | ✅ Done |
| FR-09b | 가로 리사이즈 핸들 (pointer drag / Arrow·Home·End / localStorage 영속화) | Medium | ✅ Done (v0.17.2, DR-01 — ResizeHandle.tsx 신설, store.citationPanelWidth 20%~80% clamp) |
| FR-10 | i18n KO/EN: viewer.title, viewer.close, citation.tooltip 등 | Medium | Pending |
| FR-11 | 패널 마운트 시에만 pdfjs document 인스턴스 생성 (lazy) | Medium | Pending |
| FR-12 | 인용 토큰이 없는 답변(legacy/실패)은 기존 UI 그대로 표시 | High | Pending |

### 3.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | 인용 클릭 → 페이지 스크롤 < 500ms (50p 문서 기준) | 수동 측정 |
| Memory | PdfViewer 마운트 시 추가 사용량 < 200MB (100p 문서 기준) | DevTools heap snapshot |
| Backward Compat | 기존 39/39 단위 테스트 회귀 0 | `vitest run` |
| Accessibility | 인용 버튼 키보드 접근 가능 + aria-label, 패널 ESC 닫기 | 수동 + axe |
| i18n | KO/EN 모두 신규 키 누락 0 | dev-mode 누락 키 경고 |

---

## 4. Success Criteria

### 4.1 Definition of Done

- [ ] FR-01 ~ FR-12 모두 구현 + 검증
- [ ] 기존 39 테스트 회귀 0
- [ ] 신규 단위 테스트 ≥ 6 (chunker page-aware, 인용 파싱, vector store page metadata, safe-markdown citation render)
- [ ] TypeScript strict 모드 통과
- [ ] 프로덕션 빌드 성공
- [ ] 한국어 5p 샘플 PDF 로 manual smoke: 요약·Q&A 모두 인용 표시 + 클릭 동작 확인

### 4.2 Quality Criteria

- [ ] 인용 정확도(샘플 검수): 인용된 페이지에 실제 관련 내용 존재 ≥ 80%
- [ ] 빌드 시간 회귀 ≤ 10%
- [ ] 번들 크기 회귀 ≤ 5% (pdfjs 는 이미 의존성에 존재 — 신규 추가 거의 없음)

### 4.3 Plan Success Criteria (PDCA Verification 용)

| ID | Criterion | Verification |
|----|-----------|--------------|
| SC-01 | 청크 메타데이터에 pageStart/pageEnd 포함 | `vector-store.test.ts` 신규 케이스 |
| SC-02 | 요약/Q&A 답변에 `[p.N]` 인용 ≥ 1개 (한국어 샘플 기준) | 수동 smoke + e2e |
| SC-03 | 인용 클릭 시 PdfViewer 패널 마운트 + 정확한 페이지 스크롤 | 수동 smoke |
| SC-04 | 기존 39 테스트 회귀 0 | `vitest run` |
| SC-05 | 인용 없는 답변(legacy/실패)도 정상 렌더 | 수동 smoke (인용 비활성 모드) |

---

## 5. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 청크 page 메타데이터 변경이 기존 RAG 검색 정확도에 회귀 | High | Medium | Backward-compatible 신규 함수(`chunkTextWithOverlapByPage`) 추가, 기존 `chunkTextWithOverlap` 유지. 회귀 테스트로 보호 |
| LLM 이 인용 토큰을 누락하거나 잘못된 페이지 표기 | High | High | (a) 프롬프트에 강한 지시 + 예시 (b) 후처리에서 인용 없는 응답도 정상 표시 (FR-12) (c) 인용 검증은 v0.17 후속 |
| pdfjs 뷰어 마운트 시 메모리 spike (대용량 PDF) | Medium | Medium | (a) 온디맨드 마운트 (FR-11) (b) 가시 페이지만 렌더 (가상 스크롤) (c) 패널 닫기 시 instance destroy |
| 인용 토큰이 마크다운 내 코드블록·인라인 코드와 충돌 | Low | Medium | safe-markdown 의 `text` renderer 에서만 변환 (코드 블록 제외) |
| 한국어 LLM 모델이 영문 표기 `[p.N]` 을 제대로 출력 안 함 | Medium | Low | 프롬프트에 한/영 양쪽 예시 제시, 후처리에서 `[페이지 N]` 같은 변형도 정규화 |
| pdfjs canvas 렌더링이 dark mode 와 충돌 | Low | Medium | viewer 패널은 light 배경 강제 (PDF 는 보통 white background 가정) |
| Tail-of-chunk page 경계 부정확 (overlap 영역) | Medium | Low | overlap 영역의 page 범위는 union 으로 처리 (시작 페이지 ~ 끝 페이지) |

---

## 6. Impact Analysis

### 6.1 Changed Resources

| Resource | Type | Change Description |
|----------|------|--------------------|
| `chunker.ts` | Lib | 신규 `chunkTextWithOverlapByPage(pageTexts, ...)` 추가, 기존 함수 유지 |
| `vector-store.ts` | Lib | `VectorChunk` 인터페이스에 `pageStart`/`pageEnd` 필드 추가 (선택적), `addChunk` 시그니처 확장 |
| `use-qa.ts` | Hook | RAG 검색 결과에서 page 정보 추출 → 컨텍스트 빌드 시 `[p.N]` 라벨 부착 |
| `use-summarize.ts` | Hook | 요약 프롬프트 컨텍스트에 page 라벨 부착 |
| `ai-service.ts` | Main | 요약/Q&A 프롬프트 시스템 메시지에 인용 지시 추가 |
| `safe-markdown.tsx` | Lib | `text` renderer 에 `[p.N]` 패턴 매칭 + `<button>` 변환 |
| `store.ts` | Store | 인용 클릭 핸들러 / `citationTarget` 상태 (page number) |
| `PdfViewer.tsx` (신규) | Component | pdfjs 기반 PDF 뷰어 + 스크롤 로직 |
| `SummaryViewer.tsx` | Component | 우측 패널 영역 추가 — citationTarget 존재 시 PdfViewer 마운트 |
| `i18n.ts` | i18n | 신규 키: viewer.title, viewer.close, citation.tooltip, citation.invalid |

### 6.2 Current Consumers

| Resource | Operation | Code Path | Impact |
|----------|-----------|-----------|--------|
| `chunker.chunkTextWithOverlap` | READ | `use-qa.ts:buildRagIndex` | None (기존 함수 유지) |
| `chunker.chunkText` | READ | `use-summarize.ts` | None |
| `VectorStore.addChunk` | WRITE | `use-qa.ts:buildRagIndex` | 시그니처 확장 (옵셔널 인자) — 기존 호출자 호환 |
| `VectorStore.search` | READ | `use-qa.ts:handleAsk` | 반환 타입 확장 — 새 필드 처리 |
| `safe-markdown.safeComponents` | READ | `SummaryViewer`, `QaChat`, `MarkdownErrorBoundary` | text renderer 추가 — 기존 a/img 호환 |
| `use-summarize` 프롬프트 | READ | Main `ai-service.ts:summaryPrompts` | 시스템 메시지 변경, 인용 없는 결과도 호환 |
| `useAppStore` | READ/WRITE | 다수 컴포넌트 | `citationTarget` 신규 필드 추가 — 기존 selector 호환 |

### 6.3 Verification

- [ ] 기존 `vector-store.test.ts` (9 케이스) 통과 — 옵셔널 필드 추가만 했으므로 회귀 0
- [ ] 기존 `chunker.test.ts` (14 케이스) 통과 — 기존 함수 무변경
- [ ] 기존 `pdf-parser.test.ts` 통과
- [ ] 인용 비활성 시(legacy 응답) SummaryViewer/QaChat 정상 렌더
- [ ] PdfViewer 미마운트 상태에서 메모리 baseline 변화 없음

---

## 7. Architecture Considerations

### 7.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| **Starter** | 단순 구조 | 정적 사이트 | ☐ |
| **Dynamic** | feature-based, 기존 Electron + React 풀스택 | 데스크톱/웹 앱 | ☑ |
| **Enterprise** | DI, 마이크로서비스 | 대규모 시스템 | ☐ |

> 기존 프로젝트의 Dynamic 구조를 그대로 따른다 (`src/main`, `src/preload`, `src/renderer`).

### 7.2 Key Architectural Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| PDF Viewer | pdfjs-dist 직접 / react-pdf / Electron webview | **pdfjs-dist 직접** | 이미 의존성 보유, 가벼움, full control. textLayer 는 후속 확장 여지 |
| 인용 생성 | LLM 프롬프트 / 후처리 매칭 / 혼합 | **프롬프트 + LLM 생성** | RAG 컨텍스트가 page 라벨 포함 → LLM 이 자연스럽게 사용. 후처리는 v0.17 보강 |
| RAG 마이그레이션 | 전면 교체 / Backward-compat 확장 / 토글 | **Backward-compat 확장** | 기존 함수 유지, 신규 함수 추가. 회귀 위험 최소 |
| 인용 포맷 | 단일 / 범위 / 다중 | **단일 [p.N]** | 구현 단순, LLM 생성 안정성 ↑. 범위/다중은 후속 |
| 뷰어 마운트 시점 | 항상 / 온디맨드 / 토글 | **온디맨드 (인용 클릭 시)** | 메모리 절약, 요약-only 사용자 영향 0 |
| 클릭 동작 | 페이지 스크롤만 / 텍스트 하이라이트 | **페이지 스크롤만** | B 범위 기본값. 하이라이트는 textLayer 후속 |
| 패널 위치 | 우측 분할 / 하단 / 모달 | **우측 50% 분할** | side-by-side 검증 워크플로에 최적 |
| 상태 관리 | Zustand 신규 필드 / 로컬 state | **Zustand `citationTarget`** | 인용 클릭이 SummaryViewer/QaChat 어디서든 발생 가능 → 중앙 관리 |

### 7.3 Clean Architecture Approach

```
Selected Level: Dynamic

├─ src/renderer/lib/
│   ├─ chunker.ts                # +chunkTextWithOverlapByPage
│   ├─ vector-store.ts           # +pageStart/pageEnd in VectorChunk
│   ├─ safe-markdown.tsx         # +citation text renderer
│   ├─ use-qa.ts                 # build context with [p.N] labels
│   └─ use-summarize.ts          # build context with [p.N] labels
├─ src/renderer/components/
│   ├─ PdfViewer.tsx             # NEW — pdfjs canvas viewer
│   ├─ SummaryViewer.tsx         # +right panel slot
│   └─ QaChat.tsx                # citation render verified
├─ src/renderer/lib/store.ts     # +citationTarget: { page: number } | null
└─ src/renderer/lib/__tests__/
    ├─ chunker.test.ts           # +chunkTextWithOverlapByPage tests
    ├─ vector-store.test.ts      # +page metadata tests
    └─ citation-parser.test.ts   # NEW — [p.N] regex/edge cases
```

---

## 8. Convention Prerequisites

### 8.1 Existing Project Conventions

- [x] `CLAUDE.md` 존재 (release procedure 등 정의됨)
- [x] TypeScript strict mode (`tsconfig.json`)
- [x] 기존 i18n 패턴 (`src/renderer/lib/i18n.ts`, useT 훅)
- [x] safe-markdown XSS 방어 패턴 확립
- [x] 단위 테스트 패턴 (vitest)

### 8.2 Conventions to Define/Verify

| Category | Current State | To Define | Priority |
|----------|---------------|-----------|:--------:|
| **인용 토큰 형식** | 없음 | `[p.N]` 단일 페이지, 정규식 `/\[p\.(\d+)\]/g` | High |
| **PdfViewer prop API** | 없음 | `{ pdfUrl, targetPage, onClose }` | High |
| **Citation 컴포넌트 스타일** | 없음 | 인라인 `<button>`, 파란색, hover underline | Medium |
| **i18n 키 prefix** | `viewer.*`, `qa.*` 등 | `pdfviewer.*`, `citation.*` 신규 prefix | Medium |

### 8.3 Environment Variables Needed

신규 환경변수 없음. 기존 settings store 에 옵션 추가도 없음(Phase 1 은 항상 활성).

### 8.4 Pipeline Integration

이 프로젝트는 9-phase Development Pipeline 을 사용하지 않음. PDCA 만 사용.

---

## 9. Next Steps

1. [x] `/pdca design page-citation-viewer` — Option C (Pragmatic) 선택 완료
2. [x] Design 문서에 구체적 인터페이스/API 정의
3. [x] `/pdca do page-citation-viewer` — module-1 ~ module-3 구현 완료
4. [x] `/pdca analyze page-citation-viewer` — gap detection (Match Rate 88.8%)
5. [ ] Smoke test (한국어 5p PDF) 및 v0.17.0 릴리즈
6. [ ] `/pdca report page-citation-viewer` — v0.17.0 릴리즈 노트로 수렴

### Decision Record — v0.17.0 Deferrals

| ID | 항목 | 결정 | 이유 |
|---|---|---|---|
| DR-01 | FR-09b 가로 리사이즈 핸들 | ✅ 구현 완료 (v0.17.2) | v0.17.0 출시 후 사용자 피드백으로 Medium → Done 승격. `ResizeHandle.tsx` 신설 (pointer capture + 키보드 Arrow / Home / End + ARIA slider), `store.citationPanelWidth` (20%~80% clamp) + `localStorage` 영속화, `SummaryViewer` 의 `flexBasis` 분배. PdfViewer 는 `ResizeObserver` 기반 debounce 재렌더로 너비 변경 시 캔버스 재계산. |
| DR-02 | 페이지 범위/다중 인용 (`[p.5-7]`, `[p.5, p.18]`) | v0.17.x 후속 (Plan §2.2 명시) | LLM 안정성 + UI 단순화 우선. 단일 페이지 인용으로 핵심 가치 제공. |
| DR-03 | 텍스트 조각 단위 하이라이트 (textLayer 매칭) | v0.17.x 후속 (Plan §2.2 명시) | 페이지 스크롤만으로 충분. textLayer 매칭은 fuzzy/정확도 트레이드오프 + 성능 비용. |
| DR-04 | 언마운트 전반 `PDFDocumentProxy` 캐시 | ✅ 구현 완료 (v0.17.5, v0.17.6 refinement) | `PdfViewer.tsx` 모듈 레벨 `cachedDoc = { bytes, doc }` 도입. `pdfBytes` 참조로 키잉 — 동일 문서 재클릭 시 `getDocument` 재실행 없이 즉시 재사용, 다른 bytes 시 stale 파기. Design §1.1#3/§2.2/§5.2/§5.3/§5.4 의 "언마운트 시 destroy" 불변식을 완화. **이유**: 100+ 페이지 PDF 에서 citation 재클릭 시 수 초간 full re-parse 로 UX 저하. **v0.17.6 개선**: `store.pdfBytes=null` (문서 close / resetSummaryState) 전환을 모듈 레벨 zustand 구독으로 감지해 cache 즉시 해제 — 50MB PDF 기준 close 후 미개봉 잔류(~2× 크기) 제거. HMR dispose 훅으로 리로드 시 리스너/캐시 정리. |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-04-14 | 초안 작성 (PDCA Plan phase) | jjw |
| 0.2 | 2026-04-15 | DR-01 Done 승격 — FR-09b 상태 `Deferred` → `✅ Done (v0.17.2)`, §2.1 In Scope 체크, Decision Record 갱신 | jjw |
