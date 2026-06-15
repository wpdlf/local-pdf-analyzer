---
template: design
version: 1.3
feature: multi-doc-phase3
date: 2026-06-15
author: jjw
project: local-pdf-analyzer (summary-lecture-material)
version_project: 0.23.2
---

# Multi-Document Phase 3 — Cross-Document Summary + Collection Persistence Design Document

> **Summary**: Phase 2(컬렉션 Q&A)가 "여러 문서에 걸쳐 *질문*"이라면, Phase 3 는 두 축을 추가한다.
> **(A) 교차 문서 요약/비교** — 선택한 문서들을 한데 묶어 통합 요약 또는 비교 분석을 생성(각 문서의
> 저장된 요약을 재사용하는 map-reduce, 재요약 최소화). **(B) 컬렉션 영속화** — 함께 본 문서 묶음을
> 이름과 함께 저장/복원해 탭 세트를 한 번에 다시 연다. 둘 다 Phase 2 의 멤버 해석·세션 인프라를 재사용한다.
>
> **Project**: local-pdf-analyzer
> **Version**: 0.23.2
> **Author**: jjw
> **Date**: 2026-06-15
> **Status**: Implemented (module-1~4 완료, v0.23.2 기준 — §11 Implementation Status 참조)
> **Depends on**: Phase 1(탭/세션-우선 복원), Phase 2(컬렉션 멤버 해석·collection.ts·collectionRagSearch),
> session-persistence(manifest/session.json/index.bin), use-summarize(요약 파이프라인)

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | Phase 2 로 교차 질문은 되지만, ① 여러 문서를 "한눈에 비교/통합 요약"하는 수단이 없고, ② 어떤 문서들을 묶어 봤는지가 앱을 닫으면 사라진다(매번 탭을 다시 열어야 함). |
| **WHO** | 강의 섹션·논문 묶음·매뉴얼 분권을 반복적으로 함께 보는 학습/연구 사용자(Phase 1/2 사용자의 자연 확장). |
| **RISK** | ① 교차 요약의 컨텍스트 폭발(문서 N개 전문 concat 시 토큰 한도 초과·비용), ② 멤버 간 임베딩/요약 모델 불일치, ③ 컬렉션 영속화의 stale docHash(파일 이동/세션 삭제), ④ Phase 1 "활성 1개만 메모리" 원칙과의 충돌. |
| **SUCCESS** | 선택 문서들의 통합 요약/비교를 1회 생성(각 문서 기존 요약 재사용 시 재요약 0), 출처 문서 표기. 컬렉션을 이름으로 저장→재오픈 시 탭 세트 복원(재파싱·재임베딩 0). 멤버 부재/불일치는 안전 제외+안내. |
| **SCOPE** | **In(A)**: 교차 요약/비교 생성(map-reduce, 캐시 요약 재사용), 전용 결과 표시, 출처 표기. **In(B)**: 컬렉션 저장/이름/목록/삭제·재오픈(탭 세트 복원). **Out**: 멤버 자동 추천, 중복 문단 제거, Vision 교차 분석, 컬렉션 단위 영속 RAG 인덱스(질의 시 온디맨드 유지), 협업/공유. |

---

## 1. Overview

### 1.1 Design Goals

- **A**: 선택 멤버들의 통합 요약 또는 비교를, 각 문서의 **저장된 단일-문서 요약을 재사용**하는 map-reduce 로 생성(재요약 최소화, 컨텍스트 폭발 회피).
- **B**: 함께 본 문서 묶음을 이름과 함께 영속화하고, 재오픈 시 **세션-우선 복원**으로 탭 세트를 재구성(재파싱·재임베딩 0).
- Phase 1/2 인프라 최대 재사용 — 새 무거운 상태·새 영속 인덱스 도입 금지(YAGNI).

### 1.2 Design Principles

- **map-reduce > concat**: 문서 전문을 모으지 않고 per-doc 요약(또는 청크 요약)을 reduce — 토큰·비용·정확도 균형.
- **재사용 우선**: 멤버의 기존 요약(session.summaries)·텍스트(session.json)를 그대로 사용, 없을 때만 생성.
- **세션 인프라 동형**: 컬렉션 영속화는 session-store 패턴(원자적 tmp→rename, manifest, docHash 검증)을 그대로 따른다.
- **Fail-safe**: 멤버/파일/세션 부재 시 그 멤버만 제외하고 진행(부분 성공 명시).

---

## 2. Architecture Options

### 2.A 교차 문서 요약/비교 — 생성 전략

| Criteria | A1: 전문 concat | A2: map-reduce(요약 재사용) | A3: 청크 RAG 합성 |
|----------|:-:|:-:|:-:|
| **Approach** | 멤버 전문을 이어붙여 1회 요약 | 멤버별 단일-문서 요약(캐시 재사용) → reduce 프롬프트로 통합/비교 | 멤버 인덱스에서 주제별 청크 검색 → 합성 |
| **토큰/비용** | 폭발(N×문서) | 낮음(요약은 짧음, 재사용 시 추가 0) | 중(쿼리 임베딩) |
| **재요약** | 매번 전체 | 캐시 hit 시 0 | 0(요약 안 함) |
| **정확도** | 높으나 한도 초과 시 잘림 | 요약 손실 일부, 비교엔 충분 | 주제 한정적 |
| **Phase 2 재사용** | 낮음 | 멤버 해석/세션 텍스트 | collectionRagSearch 그대로 |
| **Recommendation** | — | **Default(통합/비교 요약)** | 차기(주제 지정 비교) |

**Selected(A)**: **A2 map-reduce** — 멤버마다 저장된 단일-문서 요약을 재사용(없으면 1회 생성)하고, 그
요약들을 reduce 프롬프트(통합 요약 또는 항목별 비교 표)로 합성. 재요약 0(캐시 시) + 컨텍스트 안전.
출처는 각 요약 블록 머리에 `## 문서명` 으로 표기해 결과가 어느 문서에서 왔는지 추적.

### 2.B 컬렉션 영속화 — 저장 구조

| Criteria | B1: settings 에 끼워넣기 | B2: 전용 collections-store | B3: session manifest 확장 |
|----------|:-:|:-:|:-:|
| **Approach** | settings.json 에 collections 배열 | userData/collections.json + IPC collection:* | manifest 에 collection 필드 혼재 |
| **격리/확장** | 낮음(설정 오염) | 높음(session-store 동형) | 중(매니페스트 비대) |
| **신규 표면** | 적음 | 파일 1 + IPC 3 + client | 적음 |
| **Recommendation** | — | **Default** | — |

**Selected(B)**: **B2 전용 collections-store** — `userData/collections.json`(배열). 각 항목은
`{ id, name, docHashes[], createdAt, lastAccessed }`. session-store 와 동일한 원자적 쓰기·검증·LRU
패턴. 재오픈은 docHashes 를 순회하며 Phase 1 의 세션-우선 복원(restoreTabFromSession 경로)으로 탭 등록.

### 2.C Component Diagram

```
┌──────────────── Renderer ────────────────┐      ┌──────── Main ────────┐
│ CollectionBar(+) / CollectionsList(NEW)   │      │ collections-store.ts │
│  ├─ "통합 요약/비교" 버튼 → use-collection-│ IPC  │  (NEW): list/save/   │
│  │   summary.ts (A: map-reduce)           │─────▶│  delete + 검증/원자쓰기│
│  └─ "컬렉션 저장" → collections-client.ts │─────▶│ index.ts: collection:*│
│ collection.ts(재사용): resolveMembers     │      │ preload: electronAPI  │
│ tabs.ts(재사용): restoreTabFromSession    │      │   .collections.*      │
│ session.load(재사용): 멤버 요약/텍스트    │      └──────────────────────┘
└────────────────────────────────────────────┘   userData/collections.json
```

### 2.D Data Flow

```
[A 교차 요약]
 컬렉션 모드 + 멤버 선택 → "통합 요약/비교" 클릭
   → resolveMembers(ready 만) → 멤버별 session.load
       ├─ summaries[현재 타입] 있으면 재사용(재요약 0)
       └─ 없으면 단일-문서 요약 1회 생성(use-summarize 재사용) → 세션 저장
   → reduce: "## 문서명\n{요약}" 블록들 + 통합/비교 지시 프롬프트 → AiClient.summarize('collection')
   → 결과를 전용 뷰(또는 요약 영역 컬렉션 모드)로 스트리밍 표시(출처 문서 표기)

[B 컬렉션 영속화]
 "컬렉션 저장" → 이름 입력 → collections:save({name, docHashes=현재 멤버})
 업로드 화면 → CollectionsList → 항목 "열기"
   → docHashes 순회 → 각 session.load → restoreTabFromSession 경로로 탭 등록(첫 항목 활성)
   → 재파싱·재임베딩 0 (세션-우선)
 항목 "삭제" → collections:delete(id)
```

---

## 3. Data Model

### 3.1 컬렉션 영속 엔티티 (B)

```typescript
// userData/collections.json
interface CollectionStoreFile { schemaVersion: number; collections: SavedCollection[]; }
interface SavedCollection {
  id: string;            // uuid
  name: string;          // 사용자 지정(기본: 멤버 파일명 요약 예 "Section 0 외 2개")
  docHashes: string[];   // 멤버 콘텐츠 해시 (session manifest 와 교차 참조)
  createdAt: string;     // ISO
  lastAccessed: string;  // ISO — 목록 정렬/LRU
}
```

> 본문(텍스트/요약/인덱스)은 기존 per-doc 세션에 그대로 있고, 컬렉션은 **docHash 참조 목록**일 뿐이다
> (중복 저장 없음). 멤버 세션이 LRU 로 삭제됐으면 재오픈 시 그 멤버만 "세션 없음"으로 제외.

### 3.2 교차 요약 결과 (A)

```typescript
// 영속화 여부는 Open Question(Q-A3). 우선 휘발성(메모리)으로 시작.
interface CollectionSummary {
  kind: 'unified' | 'comparison';
  content: string;            // 마크다운(문서별 출처 헤더 포함)
  memberHashes: string[];     // 기여 문서
  model: string; provider: AiProviderType;
  createdAt: Date;
}
```

---

## 4. IPC Specification

> A(교차 요약)는 신규 IPC 0 — 기존 `session:load`(멤버 요약/텍스트) + `ai:*`(생성) 재사용.
> B(영속화)만 신규 채널 추가(session:* 와 동형).

| Channel | 인자 | 반환 | 설명 |
|---------|------|------|------|
| `collections:list` | — | `SavedCollection[]` | lastAccessed desc |
| `collections:save` | `{ id?, name, docHashes }` | `{ ok, id }` | upsert(id 없으면 생성) + 원자적 쓰기 |
| `collections:delete` | `id: string` | `{ ok }` | 항목 제거 |

- 검증: docHashes 각 항목 `/^[a-f0-9]{64}$/`, name 길이 캡(예 200), 항목 수 캡(LRU). 경로 traversal 없음(단일 파일).
- 저장 실패는 best-effort(`{ ok:false }` + warn). 로드 실패 → 빈 목록(fail-safe).

---

## 5. UI/UX Design

### 5.1 화면 배치

```
[A] QaChat/CollectionBar 영역:
  [✔ 컬렉션 모드]  대상 문서: ☑A ☑B ☑C
  [📑 통합 요약]  [⚖ 비교 분석]   ← 신규 버튼(ready 멤버 2개+ 일 때 활성)
  → 결과: 요약 영역에 "컬렉션 요약" 헤더 + 문서별 출처 블록 스트리밍

[B] 업로드 화면(문서 없음):
  최근 문서 | 저장된 컬렉션 (CollectionsList)
            - "Section 0 외 2개" (3개 문서)  [열기][삭제]
  헤더/CollectionBar: [💾 컬렉션 저장] → 이름 입력 다이얼로그
```

### 5.2 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| CollectionsList (NEW) | src/renderer/components/CollectionsList.tsx | 저장된 컬렉션 목록·열기·삭제 |
| CollectionBar (확장) | components/CollectionBar.tsx | 통합요약/비교 버튼 + 저장 버튼 |
| use-collection-summary.ts (NEW) | src/renderer/lib | A: map-reduce 합성 오케스트레이션 |
| collections-client.ts (NEW) | src/renderer/lib | electronAPI.collections 래퍼 |

### 5.3 Page UI Checklist
- [ ] 통합 요약/비교 버튼(ready 멤버 2개+ 조건), 진행률/취소
- [ ] 결과 출처 표기(문서별 헤더), 빈/부분 멤버 안내
- [ ] 컬렉션 저장 다이얼로그(이름, 기본값 제안)
- [ ] CollectionsList: 항목·문서 수·상대시간·열기·삭제·empty state
- [ ] 재오픈 시 멤버 일부 세션 부재 → "N개 중 M개만 복원" 안내
- [ ] i18n Ko/En 전체

---

## 6. Error Handling

| 상황 | 처리 |
|------|------|
| 멤버 요약/텍스트 부재 | 그 멤버 제외, 나머지로 합성(부분 성공 안내) |
| 멤버 전원 부재/1개뿐 | 교차 요약 불가 안내(단일 요약 권유) |
| 컨텍스트 한도 초과 | 멤버 요약을 추가 축약(2차 reduce) 또는 멤버 수 상한 안내 |
| collections.json 손상 | 빈 목록 fail-safe |
| 재오픈 시 멤버 세션 삭제됨(LRU) | 해당 멤버 skip + "일부 복원" 안내 |
| docHash 형식 위반 | 거부 |

---

## 7. Security Considerations

- [ ] collections.json 입력 검증(docHash 64-hex, name 길이 캡, 항목 수 캡) — 신규 신뢰 표면 최소.
- [ ] 재오픈은 기존 file:open-path/session-first 가드 재사용(심볼릭링크/확장자/크기 캡).
- [ ] 교차 요약 프롬프트: 문서명·요약이 LLM 입력에 들어가므로 sanitizePromptInput 적용(구조 마커 오염 방지).
- [ ] 민감정보: 컬렉션은 docHash·name 만 저장(원문 중복 없음).

---

## 8. Test Plan (vitest)

| Type | Target | Phase |
|------|--------|-------|
| L1 | collections-store(저장/로드/삭제/LRU/검증, fs 모킹) | Do |
| L1 | use-collection-summary 의 reduce 프롬프트 빌더(순수) + 멤버 요약 재사용/생성 분기 | Do |
| L2 | collections:* IPC 핸들러(검증·계약, electron 모킹) | Do |
| L2 | 교차 요약 오케스트레이션(session.load·AiClient 모킹: 캐시 재사용 시 재요약 0, 부분 멤버) | Do |
| L3 | CollectionsList(목록·열기→탭 복원 호출·삭제) happy-dom | Do |
| L3 | CollectionBar 통합요약/비교 버튼(ready<2 비활성, 클릭→오케스트레이션 호출) | Do |
| E2E(로컬) | 컬렉션 저장→재오픈 탭 복원 / 통합 요약 생성(실 Ollama) | Check |

---

## 9. Implementation Guide

### 9.1 Module Map

| Module | Scope Key | Description | Est. Turns |
|--------|-----------|-------------|:----------:|
| B 영속화 코어 | `module-1` | collections-store + IPC + preload + collections-client + L1/L2 | 25-30 |
| B UI | `module-2` | CollectionsList + 저장 다이얼로그 + 재오픈(탭 복원) + i18n + L3 | 20-25 |
| A 교차 요약 | `module-3` | use-collection-summary(map-reduce) + CollectionBar 버튼 + 결과 표시 + L1/L2/L3 | 30-35 |
| 검증 | `module-4` | gap + E2E(로컬) + Report | 15-20 |

> 권장 순서: **B(영속화) 먼저** — 독립적이고 위험이 낮으며 즉시 가치(탭 세트 복원). 그 다음 A(교차 요약).
> A 는 토큰/비용·결과 표시 UX 결정이 더 무겁다.

---

## 10. Resolved Decisions (2026-06-15 확정 — 전부 보수적 권고값)

| # | 질문 | **확정** |
|---|------|----------|
| Q-B1 | 자동 vs 명시 저장 | **명시 저장**(버튼+이름) |
| Q-B2 | 시작 시 자동 복원 | **아니오** — 목록에서 수동 열기 |
| Q-B3 | 멤버 일부 세션 삭제 | **부분 복원 + 안내**, 컬렉션 항목은 유지 |
| Q-A1 | 교차 요약 종류 | **통합 요약 + 비교 분석** 2종 |
| Q-A2 | 멤버 요약 부재 | **그 자리에서 1회 생성** 후 세션 저장 |
| Q-A3 | 결과 영속화 | **휘발성 시작**(차기 영속화) |
| Q-A4 | 멤버 수 상한 | **10**(초과 시 안내) |
| Q-A5 | 결과 표시 위치 | **요약 영역의 컬렉션 모드** 재사용 |

> 위 확정으로 SCOPE 고정. Plan 문서를 따로 만들지 않고 본 설계를 Do 의 단일 기준으로 사용한다.
> module-1(B 영속화 코어)부터 착수.

---

## 11. Implementation Status (module-4 gap 분석)

구현 완료. SCOPE In 항목과 결정 매핑:

| 요구 (SCOPE In / 결정) | 구현 위치 | 테스트 |
|------------------------|-----------|--------|
| B: 컬렉션 저장/이름(명시) | CollectionBar 저장 버튼 + collections-client | CollectionBar L3, store L1 |
| B: 영속 저장소(전용) | shared/collection-types + main/collections-store + collections:* IPC | collections-store L1(11) + IPC L2(5) |
| B: 목록/삭제 | CollectionsList | CollectionsList L3(5) |
| B: 재오픈(탭 세트 복원) | tabs.openCollection(세션-우선) | tabs L3(3) + collection-phase3 E2E |
| B: 멤버 일부 부재 → 부분 복원 | openCollection skip + notice | tabs L3, CollectionsList L3 |
| A: 교차 요약/비교(map-reduce) | use-collection-summary | L1(3) + L2(3) |
| A: 저장 요약 재사용(재요약 0) | gatherMemberBlocks(pickSummary) | L2 |
| A: 통합/비교 2종 | CollectionBar 버튼 + buildCollectionSummaryPrompt | L1/L2 |
| A: 멤버 수 상한(10) | COLLECTION_SUMMARY_MAX_MEMBERS | (slice) |
| A: 결과 표시(요약 영역 재사용) | QaChat 스레드(요청+결과 메시지) — 새 패널 없음 | collection-phase3 E2E |
| 전체 통합 | — | collection-phase3.spec.ts(통합 요약 + 저장→재오픈, 로컬) |

**Gap / 의도적 단순화 (차단 아님)**:
- **Q-A2 변경**: 요약 부재 멤버는 인라인 생성·영속화(타 문서 세션 cross-write 위험) 대신 본문
  발췌(1500자)로 대체. 인라인 생성+세션 저장은 차기 refinement.
- **A 결과 표시**: Q-A5의 "요약 영역 재사용"을 QaChat 스레드(기존 영역, 새 패널 없음) 재사용으로
  구현 — 활성 문서 요약 영역을 덮어쓰지 않아 더 안전(취지 동일).
- 교차 요약의 `[문서명 p.N]` 인용은 LLM 준수에 의존(멤버 요약의 기존 `[p.N]`은 활성 문서 인용으로
  렌더될 수 있음 — 정확도 한정적, 휘발성 결과라 영향 작음).
- 컬렉션 영속 RAG 인덱스는 Out(질의 시 온디맨드 — Phase 2 정책 유지).

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-15 | Initial draft (A: map-reduce / B: 전용 collections-store 선택) | jjw |
| 0.2 | 2026-06-15 | §10 Open Questions 8건 보수적 권고값 확정 → Status: Scope Confirmed | jjw |
| 0.3 | 2026-06-15 | module-1~4 구현 완료 + §11 gap 분석 → Status: Implemented | jjw |
