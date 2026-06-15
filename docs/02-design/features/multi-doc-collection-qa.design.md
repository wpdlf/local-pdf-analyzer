---
template: design
version: 1.3
feature: multi-doc-collection-qa
date: 2026-06-15
author: jjw
project: local-pdf-analyzer (summary-lecture-material)
version_project: 0.22.0
---

# Multi-Document Collection Q&A (멀티탭 Phase 2) Design Document

> **Summary**: Phase 1(다중 문서 탭)이 문서를 개별로 다룬다면, Phase 2는 열린 문서들을 하나의 컬렉션으로 묶어 **여러 PDF에 걸친 통합 Q&A(교차 문서 RAG 검색)**를 제공한다. 무거운 인덱스는 활성 1개만 메모리에 유지하던 Phase 1 전략을 유지하면서, 컬렉션 Q&A 시점에만 멤버 인덱스를 **온디맨드로 로드 → 멤버별 검색 → 전역 score 병합**한다. (Architecture Option C — Pragmatic)
>
> **Project**: local-pdf-analyzer
> **Version**: 0.22.0
> **Author**: jjw
> **Date**: 2026-06-15
> **Status**: Scope Confirmed (§12 Open Questions 전부 보수적 기본값으로 확정 — Do 착수 가능)
> **Depends on**: multi-doc Phase 1 (v0.22.0, openTabs/탭 전환), session-persistence (index.bin/PersistedSession)

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | Phase 1 에서 여러 PDF 를 탭으로 열 수 있게 됐지만 Q&A 는 여전히 활성 문서 1개에 갇혀 있다. "강의 자료 전체에서 ~는?"처럼 문서 경계를 넘는 질문에 답할 수 없다. |
| **WHO** | 한 주제를 여러 PDF(강의 섹션·논문 묶음·매뉴얼 분권)로 나눠 보는 학습/연구 사용자. Phase 1 의 탭 사용자가 자연 확장 대상. |
| **RISK** | ① 다중 인덱스 동시 로드로 인한 메모리 폭주, ② 멤버 간 임베딩 모델/차원 불일치로 통합 검색 불가, ③ 출처가 어느 문서인지 흐려지는 인용 혼란, ④ Phase 1 의 "활성 1개만 메모리" 전략과의 충돌. |
| **SUCCESS** | 선택한 N개 문서에 대해 단일 질문으로 교차 검색 답변 + 각 인용이 "문서명 p.N"으로 출처 명시. 멤버 추가 시 **재임베딩 0**(세션 index.bin 재사용). 모델 불일치 멤버는 안전 제외 + 안내. |
| **SCOPE** | **In**: 컬렉션 Q&A 모드, 멤버 선택 UI, 멤버별 온디맨드 인덱스 로드, 병합 검색, 문서명 인용, 동질성 게이트. **Out**: 교차 문서 *요약*/비교(별도 기능), 컬렉션 영속화(열린 탭 묶음 저장), 멤버 자동 추천, 멤버 간 중복 제거, Vision/이미지 교차 분석. |

---

## 1. Overview

### 1.1 Design Goals

- 열린 문서들(또는 사용자가 고른 부분집합)에 대해 **단일 질문 → 교차 문서 RAG 답변**.
- Phase 1 의 메모리 원칙(무거운 상태는 활성 1개) 유지 — 컬렉션 멤버 인덱스는 **질의 시점에만** 디스크(index.bin)에서 로드하고 즉시 해제.
- 멤버 추가/질의에 **재임베딩 0** — 이미 영속화된 인덱스를 재사용(session-persistence 계약 상속).
- 출처 추적성 — 답변의 모든 인용이 "어느 문서의 몇 페이지"인지 식별 가능.

### 1.2 Design Principles

- **Phase 1/세션 패턴 동형성**: 새 인덱스 매체를 만들지 않고 기존 `index.bin` + `PersistedSession.chunkMeta` 를 그대로 사용.
- **동질성 게이트**: 컬렉션 검색은 동일 (embedModel, embedDim) 멤버끼리만 — 불일치 멤버는 검색에서 제외하고 UI 로 사유 표시(재임베딩 강제하지 않음).
- **Fail-safe**: 멤버 인덱스 손상/부재 시 그 멤버만 건너뛰고 나머지로 답변(부분 성공 명시).
- **YAGNI**: 교차 요약·컬렉션 저장·중복 제거는 Out — Q&A 한 축에 집중.

---

## 2. Architecture Options

### 2.0 Architecture Comparison

다중 인덱스 검색을 **어떻게/언제 메모리에 올리는가**가 핵심 축이다.

| Criteria | Option A: All-in-memory | Option B: Server-side merge | Option C: On-demand load + merge |
|----------|:-:|:-:|:-:|
| **Approach** | 멤버 전 인덱스를 상시 메모리 유지 | main 프로세스에 멤버 검색 위임 | 질의 시 멤버 index.bin 로드 → 멤버별 search → 병합 → 해제 |
| **메모리** | N×인덱스 상시(폭주 위험) | 낮음(main 일시) | 낮음(질의 동안만) |
| **Phase 1 정합** | 충돌(활성 1개 원칙 깨짐) | 중립 | **일치** |
| **재임베딩** | 0 | 0 | 0 |
| **신규 표면** | store 대수술 | IPC 검색 핸들러 신설 + 임베딩 로직 main 이전 | 렌더러 병합 유틸 1개 |
| **Complexity** | High | High | Medium |
| **Risk** | OOM | 임베딩/벡터 로직 이중화 | 질의당 디스크 I/O(수십 MB) |
| **Recommendation** | — | 대규모 컬렉션 후일 | **Default choice** |

**Selected**: Option C — **Rationale**: Phase 1 이 이미 "활성 문서만 메모리, 나머지는 세션에서 복원"을 확립했고, 세션은 멤버별 `index.bin`(정규화 Float32)을 이미 갖고 있다. C 는 질의 시점에만 그 블롭들을 `VectorStore.restore` 로 올려 멤버별 `search()` 후 score 로 병합하고 해제하므로, 메모리 원칙을 깨지 않고 재임베딩도 0이다. A 는 OOM 위험으로 Phase 1 설계와 정면 충돌, B 는 임베딩/벡터 검색 로직을 main 으로 이중화해 YAGNI 위반.

> **트레이드오프(명시)**: C 는 질의마다 비활성 멤버의 index.bin 을 디스크에서 읽는다(문서당 보통 수십 KB~수 MB). 일반 컬렉션(2~10개 문서)에서는 무시 가능하나, 대규모(수십 개)로 커지면 B 로 진화. 활성 문서 인덱스는 이미 메모리에 있으므로 재로드 없이 사용.

### 2.1 Component Diagram

```
┌──────────────────────── Renderer ────────────────────────┐
│ QaChat.tsx ── 컬렉션 모드 토글 + 멤버 선택(체크박스)        │
│   │                                                        │
│   ▼ (컬렉션 모드)                                          │
│ use-qa.ts: collectionRagSearch(question, members, signal)  │
│   ├─ 활성 멤버 → in-memory ragIndex.search()               │
│   ├─ 비활성 멤버 → session.load(docHash).blob              │
│   │                 → VectorStore.restore() → search()      │
│   ├─ mergeSearchResults([...perMember]) → 전역 topK         │
│   └─ buildContext(+문서명 라벨) → LLM 프롬프트              │
│ collection.ts (NEW): 멤버 해석/동질성 게이트/병합 순수 헬퍼  │
│ store.ts: collectionMode, collectionMembers(docHash[])      │
└────────────────────────────────────────────────────────────┘
        │ session.load (기존 IPC 재사용 — 신규 채널 없음)
        ▼
  userData/sessions/<docHash>/{session.json, index.bin}
```

### 2.2 Data Flow

```
[컬렉션 모드 ON] → 멤버 후보 = openTabs(+docHash 있는 것) → 사용자가 부분집합 선택
[질문 전송]
  → 멤버 동질성 게이트: 활성 문서의 (embedModel,embedDim) 기준
     ├─ 일치 멤버 → 검색 대상
     └─ 불일치/인덱스 없음 → 제외(사유 배지)
  → 질문 임베딩 1회 (embedWithTimeout, 활성 모델)
  → 멤버별 search(queryEmb, TOP_K_PER_DOC):
     ├─ 활성: in-memory ragIndex
     └─ 비활성: session.load(docHash) → VectorStore.restore(blob) → search → 해제
  → mergeSearchResults: 결과에 {docHash, fileName} 부착 → 전역 score desc → 컬렉션 topK
  → context = 멤버 그룹별 "[문서명 p.N] 청크" → MAX_QA_CONTEXT_CHARS 컷
  → LLM 답변 (인용 형식 [문서명 p.N]) → 답변 검증도 컬렉션 인덱스로 수행
[멤버 0개 또는 전원 제외] → 단일 문서 Q&A 로 graceful fallback + 안내
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| use-qa.collectionRagSearch | collection.ts, session-client, vector-store | 멤버 검색·병합·컨텍스트 |
| collection.ts | vector-store(SearchResult 타입) | 동질성 게이트·병합(순수 함수) |
| store.ts | openTabs(Phase 1), settings | 컬렉션 모드/멤버 상태 |
| QaChat.tsx | store, collection.ts | 모드 토글·멤버 선택·출처 렌더 |

---

## 3. Data Model

### 3.1 신규/확장 타입

```typescript
// store 상태 (렌더러)
interface CollectionState {
  enabled: boolean;                 // 컬렉션 Q&A 모드 on/off
  memberHashes: string[];           // 질의 대상 docHash 부분집합 (openTabs ⊇ members)
}

// 멤버 검색 결과 (병합 입력)
interface CollectionSearchResult extends SearchResult { // SearchResult: {text,score,index,pageStart,pageEnd}
  docHash: string;
  fileName: string;
}

// 멤버 해석 결과 (동질성 게이트 산출)
interface ResolvedMember {
  docHash: string;
  fileName: string;
  source: 'memory' | 'session';     // 활성(메모리) vs 비활성(세션 로드)
  status: 'ready' | 'no-index' | 'model-mismatch' | 'missing';
}
```

> 신규 영속 매체·신규 IPC 채널 없음. 멤버 인덱스 로드는 기존 `session:load`(blob 포함) 재사용. `OpenTab.docHash`(Phase 1 에 이미 존재)가 멤버 식별 키.

### 3.2 병합 계약 (collection.ts 순수 헬퍼)

```typescript
// 멤버별 search 결과를 전역 점수로 병합 → 컬렉션 topK
function mergeSearchResults(
  perMember: CollectionSearchResult[][],
  topK: number,
): CollectionSearchResult[];        // score desc, 동점은 docHash·index 안정 정렬

// 활성 문서의 (model,dim) 기준 멤버 동질성 판정
function resolveMembers(
  memberHashes: string[],
  active: { docHash: string; model: string; dim: number },
  manifest: SessionManifestEntry[],
): ResolvedMember[];
```

---

## 4. IPC Specification

> **신규 IPC 없음.** 기존 `session:load`(PersistedSession + index.bin blob 반환)와 `session:list`(manifest)로 충분. 멤버 인덱스는 렌더러에서 `VectorStore.restore` 로 복원해 검색.

| 재사용 채널 | 용도 (Phase 2) |
|-------------|----------------|
| `session:load` | 비활성 멤버의 chunkMeta + index.bin 로드 → VectorStore.restore |
| `session:list` | 멤버 후보의 embedModel/embedDim 조회(동질성 게이트, 로드 전 사전 필터) |

---

## 5. UI/UX Design

### 5.1 화면 배치 (QaChat 확장)

```
┌──────────── Q&A 패널 ────────────┐
│ [◻ 컬렉션 모드]  ← 토글            │
│ (ON 시) 대상 문서:                 │
│   ☑ Section 0 소개      (ready)    │
│   ☑ Section 2 게이트웨이 (ready)   │
│   ☐ Section 5          (모델 불일치)│  ← 비활성·사유 배지
│ ─────────────────────────────────│
│ 질문 입력 …                        │
│ 답변: … 핵심 내용 [Section 2 p.12] │  ← 출처에 문서명
└───────────────────────────────────┘
```

### 5.2 User Flow

```
컬렉션 모드 OFF(기본) → 기존 단일 문서 Q&A 그대로
컬렉션 모드 ON → 멤버 후보(열린 탭) 표시 → 체크로 대상 선택
질문 → 교차 검색 답변(출처=문서명 p.N)
일부 멤버 모델 불일치 → 해당 멤버 비활성 표시 + "동일 임베딩 모델 문서만 검색됨" 안내
선택 0개 → 단일 문서 Q&A 로 자동 강등 + 안내
```

### 5.3 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| QaChat (확장) | src/renderer/components/QaChat.tsx | 컬렉션 토글·멤버 체크·출처 렌더 |
| collection.ts (NEW) | src/renderer/lib/collection.ts | 멤버 해석·병합 순수 헬퍼 |

### 5.4 Page UI Checklist

- [ ] Toggle: "컬렉션 모드" on/off (기본 off — 기존 동작 보존)
- [ ] List: 멤버 후보(열린 탭) 체크박스 + 상태 배지(ready/모델 불일치/인덱스 없음/원본 없음)
- [ ] Citation: 답변·근거 인용을 `[문서명 p.N]` 으로 렌더(클릭 시 해당 문서 탭 전환 + 페이지 이동 — Phase 1 탭 전환 + page-citation 연계)
- [ ] Empty/Degraded: 선택 0개 / 전원 제외 시 단일 문서 강등 안내
- [ ] i18n: 모든 신규 라벨 Ko/En

---

## 6. Error Handling

| 상황 | 원인 | 처리 |
|------|------|------|
| 멤버 index.bin 부재/손상 | 요약·인덱싱 전 문서, 파일 손상 | 그 멤버 제외(no-index 배지), 나머지로 답변 |
| 멤버 임베딩 모델/차원 불일치 | 멤버마다 다른 시점·provider 로 인덱싱 | 동질성 게이트에서 제외 + 사유 표시(재임베딩 강제 안 함) |
| 선택 멤버 전원 제외 | 위 사유 누적 | 단일 활성 문서 Q&A 로 graceful fallback |
| 세션 로드 실패 | IO/권한 | 해당 멤버 skip + console.warn, 작업 비차단 |
| 컬렉션 검색 0 hit | 질문이 어느 문서와도 무관 | 키워드 검색 폴백(기존 경로) 또는 "관련 내용 없음" |

---

## 7. Security Considerations

- [x] 신규 신뢰 표면 없음 — `session:load`(docHash `/^[a-f0-9]{64}$/` 검증) 재사용, 멤버는 openTabs/manifest 의 기존 항목으로 한정.
- [x] 메모리 상한 — 멤버 인덱스는 질의 중에만 복원·검색 후 해제(C 전략). 동시 로드 멤버 수 상한(예: 20) 가드로 OOM 차단.
- [x] 민감정보 — 컬렉션 상태는 docHash 목록일 뿐 API 키·원문 추가 노출 없음.
- [x] 출처 무결성 — 인용 라벨의 문서명은 표시용 메타(tab.fileName), 검색 대상은 콘텐츠 해시로 식별(라벨 스푸핑이 검색을 오염시키지 않음).

---

## 8. Test Plan (vitest)

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|------|--------|------|-------|
| L1: 순수 헬퍼 | collection.ts(mergeSearchResults, resolveMembers) | vitest | Do |
| L2: 검색 통합 | collectionRagSearch (session.load·VectorStore 모킹) | vitest | Do |
| L3: 행위 | QaChat 컬렉션 모드 흐름(멤버 선택→검색→출처 렌더) | vitest + happy-dom | Do |

### 8.2 L1 — 순수 헬퍼 시나리오

| # | 대상 | 검증 |
|---|------|------|
| 1 | mergeSearchResults | 멤버별 결과를 전역 score desc 병합, topK 컷, 동점 안정 정렬, docHash/fileName 보존 |
| 2 | resolveMembers | 활성 (model,dim) 기준 일치 멤버만 ready, 불일치→model-mismatch, manifest 부재→missing/no-index |
| 3 | 경계 | 멤버 0개 / 전원 제외 / 단일 멤버 → 올바른 상태 배열 |

### 8.3 L2 — collectionRagSearch (모킹)

| # | 시나리오 | 검증 |
|---|----------|------|
| 1 | 활성+비활성 혼합 | 활성은 in-memory, 비활성은 session.load→restore→search, 결과 병합 |
| 2 | 재임베딩 0 | 멤버 추가 질의 시 embed 호출은 질문 1회뿐(멤버 인덱스 재임베딩 없음) |
| 3 | 모델 불일치 멤버 | 검색 대상에서 제외, 나머지로 컨텍스트 구성 |
| 4 | 멤버 로드 실패 | 해당 멤버 skip, 부분 결과 반환 |
| 5 | 컨텍스트 컷 | MAX_QA_CONTEXT_CHARS 초과 시 절단, 문서명 라벨 유지 |

### 8.4 L3 — QaChat 행위

| # | 시나리오 | 검증 |
|---|----------|------|
| 1 | 컬렉션 토글 off→on | 멤버 후보(openTabs) 노출, 기본 전체 체크 |
| 2 | 멤버 부분 선택 후 질문 | collectionRagSearch 가 선택 부분집합으로 호출 |
| 3 | 출처 렌더 | 답변 인용이 `[문서명 p.N]` 으로 표시, 클릭 시 탭 전환 액션 호출 |
| 4 | 선택 0개 | 단일 문서 Q&A 강등 + 안내 |

### 8.5 Seed/Fixture

| Fixture | 최소 | 필드 |
|---------|:---:|------|
| 멤버 PersistedSession+blob | 3 | 동일 dim 2개 + 다른 dim 1개(불일치 케이스) |
| 멤버별 SearchResult 배열 | 3 | score 교차(병합 정렬 검증용) |

---

## 9. Clean Architecture

| Component | Layer | Location |
|-----------|-------|----------|
| QaChat(컬렉션 UI) | Presentation | src/renderer/components/ |
| collectionRagSearch, store 컬렉션 액션 | Application | src/renderer/lib/ |
| collection.ts(병합·게이트), CollectionState 타입 | Domain | src/renderer/lib/, src/renderer/types/ |
| session-store(기존, index.bin I/O) | Infrastructure | src/main/ (재사용, 변경 없음) |

> 의존 방향: Presentation → Application → Domain. Infrastructure(main 세션 I/O)는 기존 IPC 경계 재사용 — 신규 main 코드 0.

---

## 10. Coding Convention Reference

| Item | Convention Applied |
|------|-------------------|
| 순수 헬퍼 분리 | merge/resolve 를 native-dep 0 함수로 → vitest 직접 import (session-hash/enforceLru 동형) |
| 인덱스 재사용 | VectorStore.serialize/restore 계약 그대로 — 재정규화 0 |
| Fallback | 단일 문서 Q&A 로 graceful 강등(기존 keyword fallback 패턴과 동일 철학) |
| i18n | 신규 UI 라벨 Ko/En 동시 |
| 상태 | Zustand store 액션(setCollectionMode/setCollectionMembers), Phase 1 openTabs 파생 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
src/renderer/
├── lib/
│   ├── collection.ts          # NEW: resolveMembers, mergeSearchResults (순수)
│   ├── use-qa.ts              # MOD: collectionRagSearch + 검증 경로 확장
│   └── store.ts              # MOD: collectionMode/collectionMembers 상태·액션
├── components/
│   └── QaChat.tsx            # MOD: 컬렉션 토글·멤버 선택·문서명 출처 렌더
└── types/index.ts            # MOD: CollectionState/CollectionSearchResult/ResolvedMember
```

### 11.2 Implementation Order

1. [ ] 타입 + collection.ts 순수 헬퍼(resolveMembers/mergeSearchResults) (+L1)
2. [ ] store 컬렉션 상태·액션 (openTabs 파생 멤버 후보)
3. [ ] use-qa: collectionRagSearch(멤버별 검색·병합·문서명 컨텍스트) + 답변 검증 확장 (+L2)
4. [ ] QaChat: 토글·멤버 체크·출처 렌더·탭 전환 연계 + i18n (+L3)
5. [ ] 통합 검증(tsc/test/build) + gap 분석 + 사용자 실파일 컬렉션 E2E(로컬, 실 Ollama)

### 11.3 Session Guide

| Module | Scope Key | Description | Est. Turns |
|--------|-----------|-------------|:----------:|
| 검색 코어 | `module-1` | 타입 + collection.ts + collectionRagSearch + L1/L2 | 25-30 |
| UI 통합 | `module-2` | store 상태 + QaChat 확장 + i18n + L3 | 20-25 |
| 검증 | `module-3` | gap/E2E(실파일 컬렉션) + Report | 15-20 |

---

## 12. Resolved Decisions (2026-06-15 확정 — 전부 보수적 기본값)

| # | 질문 | **확정** |
|---|------|----------|
| 1 | 멤버 후보 범위 | **열린 탭만** (openTabs 中 docHash 보유) — Phase 1 정합. 최근 문서 전체 선택은 차기. |
| 2 | 동질성 미충족 시 UX | **제외 + 사유 배지** 만. "재임베딩하기" 액션은 차기 Phase. |
| 3 | 출처 인용 렌더 | `[문서명 p.N]` 클릭 시 **탭 전환 + 페이지 점프 자동** (Phase 1 탭 전환 × page-citation-viewer 연계). |
| 4 | 컬렉션 영속화 | **Out of Scope** — 열린 탭 묶음 저장/복원은 차기 Phase. |
| 5 | 답변 검증 범위 | **컬렉션 인덱스로 검증**, 단 1질의 내 멤버 인덱스를 캐시 재사용해 로드 빈도 억제. |

> 위 확정으로 SCOPE 가 고정됐다. Plan 문서를 따로 만들지 않고 본 설계를 Do 의 단일 기준으로 사용한다.

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-15 | Initial draft (Option C selected) — Plan 선행 없이 범위 합의용 초안 | jjw |
| 0.2 | 2026-06-15 | §12 Open Questions 전부 보수적 기본값으로 확정 → Status: Scope Confirmed | jjw |
