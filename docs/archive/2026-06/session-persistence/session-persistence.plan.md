---
template: plan-plus
version: 1.0
feature: session-persistence
date: 2026-06-09
author: jjw
project: local-pdf-analyzer (summary-lecture-material)
version_project: 0.18.26
---

# Session Persistence + RAG Index Caching (A+B) Planning Document

> **Summary**: 문서별 요약·Q&A·임베딩 인덱스를 콘텐츠 해시 기준으로 영속화하여, 같은 문서를 다시 열면 재요약·재임베딩 없이 작업을 복원한다.
>
> **Project**: local-pdf-analyzer
> **Version**: 0.18.26
> **Author**: jjw
> **Date**: 2026-06-09
> **Status**: Draft
> **Method**: Plan Plus (Brainstorming-Enhanced PDCA)

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 앱이 단일 문서·휘발성 구조라, 문서를 전환하거나 앱을 다시 켜면 요약·Q&A 대화·RAG 인덱스가 전부 사라진다. 다시 열면 재요약·재임베딩이 강제되고, 클라우드 임베딩은 매번 토큰을 재과금한다. |
| **Solution** | main 프로세스에 `session-store`를 신설해 콘텐츠 해시(SHA-256 of extractedText)를 키로 요약·Q&A·파싱텍스트는 JSON, 임베딩은 Float32 바이너리 블롭으로 분리 저장한다. 문서 재오픈 시 해시 매칭으로 세션을 복원하고, 임베딩 모델/차원이 일치하면 인덱스를 역직렬화해 재임베딩을 건너뛴다. LRU로 용량을 자동 관리한다. |
| **Function/UX Effect** | "한 번 쓰고 버리는" 도구에서 "다시 돌아오는 도구"로 전환. 같은 PDF 재오픈 시 즉시 요약·Q&A 복원(체감 0ms), 클라우드 임베딩 토큰 재과금 제거, 최근 문서 목록에서 바로 이어하기. |
| **Core Value** | 작업 연속성(continuity) — 사용자의 분석 결과가 보존되어 학습/연구 흐름이 끊기지 않는다. 부수적으로 재임베딩 비용·시간 제거. |

---

## 1. User Intent Discovery

### 1.1 Core Problem

문서별 요약·Q&A·RAG 인덱스가 메모리에만 존재(`store`의 `document`/`summary`/`qaMessages`/`ragIndex: new VectorStore()`)하여 문서 전환·앱 종료 시 전부 리셋된다. 동일 PDF를 다시 열면 재요약·재임베딩이 강제되고, OpenAI `text-embedding-3-small` 같은 클라우드 임베딩은 열 때마다 토큰을 재과금한다.

### 1.2 Target Users

| User Type | Usage Context | Key Need |
|-----------|---------------|----------|
| 학습/연구용 End User | 같은 PDF(강의자료·논문)를 여러 세션에 걸쳐 반복 분석 | 이전 요약·Q&A를 다시 열어 이어서 작업 |
| 클라우드 임베딩 사용자 | OpenAI 임베딩으로 RAG 사용 | 재오픈 시 재임베딩 토큰 과금 회피 |

### 1.3 Success Criteria

- [ ] 동일 콘텐츠 문서 재오픈 시 요약·Q&A 대화가 재요약/재호출 없이 복원된다.
- [ ] 임베딩 모델·차원이 일치하면 RAG 인덱스가 재임베딩 없이 복원되고 `ragState.isAvailable=true`가 된다.
- [ ] 최근 문서 목록에서 항목을 선택해 세션을 이어갈 수 있다.
- [ ] 저장 용량이 LRU 상한을 초과하면 가장 오래된 세션부터 자동 제거된다.
- [ ] 임베딩 모델/차원/콘텐츠가 바뀌면 캐시가 무효화되어 stale 인덱스가 사용되지 않는다.

### 1.4 Constraints

| Constraint | Details | Impact |
|------------|---------|--------|
| Electron 저장 경계 | 저장 위치는 main의 `app.getPath('userData')/sessions/`. IPC 경계는 기존 `settings-store`/`api-keys-store` 패턴(원자적 tmp→rename, 입력 검증) 준수 | High |
| 네이티브 의존성 0 유지 | 현재 앱은 네이티브 모듈 0개 → electron 업글·패키징 단순. SQLite 등 네이티브 도입 금지 | High |
| 캐시 무효화 정확성 | 캐시 키 = 콘텐츠 해시 + 임베딩 모델 + 차원. 차원 불일치 가드는 `verifyAnswerSentences`에 이미 존재 — 동일 원칙 적용 | High |
| 데이터 평문 저장 | 세션에 PDF 본문 텍스트·임베딩 포함. userData 내 평문(앱 데이터 디렉토리 OS 권한에 의존), 암호화는 Out of Scope | Medium |

---

## 2. Alternatives Explored

### 2.1 Approach A: 문서별 단일 JSON

| Aspect | Details |
|--------|---------|
| **Summary** | 임베딩 포함 모든 세션 데이터를 문서별 JSON 하나로 저장 |
| **Pros** | 기존 `settings-store`/`api-keys-store` 패턴 그대로 재사용, 구현 최소 |
| **Cons** | 임베딩을 JSON 숫자배열로 저장 → 부피 ~2배 + 복원 시 파싱 비용(문서당 ~1MB JSON) |
| **Effort** | Low |
| **Best For** | 일단 동작하는 v1을 최소 노력으로 |

### 2.2 Approach B: JSON 매니페스트 + 바이너리 임베딩 블롭 — Selected

| Aspect | Details |
|--------|---------|
| **Summary** | 최근목록/메타는 단일 JSON 매니페스트, 요약·Q&A·파싱텍스트는 문서별 JSON, 임베딩만 Float32Array→Buffer 바이너리 블롭으로 분리 |
| **Pros** | 임베딩 부피 절반 + 파싱 비용 0(타입드 배열 직접 로드), LRU 쿼리는 매니페스트만 읽음, **네이티브 의존성 0 유지** |
| **Cons** | 파일 종류 3개(매니페스트/세션/블롭)로 약간의 moving parts |
| **Effort** | Medium |
| **Best For** | 가벼운 텍스트 + 무거운 임베딩이라는 데이터 성격에 정확히 부합, 재임베딩 제거 목적에 최적 |

### 2.3 Approach C: SQLite (better-sqlite3)

| Aspect | Details |
|--------|---------|
| **Summary** | 구조적 저장·트랜잭션·LRU 쿼리를 네이티브 DB로 |
| **Pros** | 구조적 쿼리, 트랜잭션, LRU 네이티브 지원 |
| **Cons** | 네이티브 모듈 도입 → "네이티브 의존성 0" 속성 파괴, electron-builder rebuild·패키징 복잡도 증가. 현 데이터 규모 대비 과도 |
| **Effort** | High |
| **Best For** | 수천 문서·복잡 쿼리(현재 YAGNI 밖) |

### 2.3 Decision Rationale

**Selected**: Approach B
**Reason**: 세션 데이터는 "가벼운 텍스트(요약·Q&A) + 무거운 임베딩(Float32 수만 개)"로 성격이 명확히 갈린다. B는 각 성격에 맞는 저장 매체(JSON vs 바이너리)를 써서 임베딩 부피·파싱 비용을 최소화하고, 재임베딩 제거라는 본 목적을 정확히 달성한다. 동시에 앱의 핵심 강점인 "네이티브 의존성 0"을 지켜 electron 업글·패키징 단순성을 유지한다. A는 임베딩 JSON 부피·파싱 비용이 본 목적(비용/속도 절감)과 상충하고, C는 네이티브 도입 비용이 현 규모 대비 과도하다.

---

## 3. YAGNI Review

### 3.1 Included (v1 Must-Have)

**고정 코어:**
- [ ] 세션 저장/복원 (파싱텍스트 + 요약 타입별 + Q&A 대화)
- [ ] RAG 인덱스 캐싱/복원 (VectorStore serialize/deserialize, 재임베딩 0)
- [ ] 콘텐츠 해시 식별 + 캐시 무효화 (콘텐츠/임베딩 모델/차원)
- [ ] 최근 문서 목록 (열기)
- [ ] LRU 자동 정리 (용량/개수 상한)
- [ ] 스키마 버전 필드 (마이그레이션 안전장치)

**선택 포함 (Phase 3 투표):**
- [ ] 수동 삭제 / 전체 비우기 UI
- [ ] 영속화 on/off 설정 토글
- [ ] 저장 용량/위치 표시 (설정)

### 3.2 Deferred (v2+ Maybe)

| Feature | Reason for Deferral | Revisit When |
|---------|---------------------|--------------|
| Vision 이미지분석 결과 캐싱 | 가장 무겁고(이미지 base64·분석 텍스트) 저장 복잡도·용량 증가. 핵심 연속성 가치와 직결 아님 | 세션 영속화 토대 안정화 후, Vision 재호출 비용이 사용자 페인으로 확인될 때 |
| 멀티 문서 / 코퍼스 Q&A (C) | 본 토대(세션·인덱스 영속화) 위에 얹는 후속. 선행 토대 없이는 대수술 | A+B 출시·안정화 후 다음 기능 사이클 |

### 3.3 Removed (Won't Do)

| Feature | Reason for Removal |
|---------|-------------------|
| 클라우드 동기화 | 로컬 데스크톱 앱 범위 밖, 과설계 |
| 세션 데이터 암호화 | userData OS 권한에 의존, EV/키체인급 보안 요구 없음. 과설계 |
| SQLite 저장소 | 네이티브 의존성 0 원칙 위반, 현 규모 대비 과도 (Approach C) |

---

## 4. Scope

### 4.1 In Scope

- [ ] main: `session-store.ts` (저장/로드/목록/삭제/비우기/통계, 원자적 tmp→rename, LRU)
- [ ] main: `index.ts` IPC 핸들러 `session:save/load/list/delete/clear/stats` + preload `electronAPI.session.*`
- [ ] renderer: `VectorStore.serialize()/deserialize()` (Float32 버퍼 export/import)
- [ ] renderer: `session-client.ts` + store 통합 (해시 계산, load-on-open, debounced save)
- [ ] renderer: 최근 문서 목록 UI 컴포넌트 + SettingsPanel(토글/용량/전체비우기)
- [ ] 단위 테스트 (session-store I/O·LRU·무효화, VectorStore serialize 라운드트립, IPC 핸들러 행위)

### 4.2 Out of Scope

- Vision 이미지분석 결과 캐싱 — (YAGNI Deferred)
- 멀티 문서 / 코퍼스 Q&A — (YAGNI Deferred)
- 클라우드 동기화, 세션 암호화, SQLite — (YAGNI Removed)

---

## 5. Requirements

### 5.1 Functional Requirements

| ID | Requirement | Priority | Status |
|----|-------------|----------|--------|
| FR-01 | 문서 오픈 시 `extractedText` 기준 SHA-256 해시를 계산해 세션 키로 사용 | High | Pending |
| FR-02 | `session:load(hash)` 가 hit + 임베딩 모델/차원 일치 시 요약·Q&A·인덱스를 복원하고 재요약/재임베딩을 건너뛴다 | High | Pending |
| FR-03 | miss 또는 모델/차원 불일치 시 기존 흐름(요약+인덱싱) 후 `session:save`로 영속화 | High | Pending |
| FR-04 | 새 요약/새 Q&A/인덱스 완료 시 debounced `session:save` + manifest `lastAccessed` 갱신 | High | Pending |
| FR-05 | 매니페스트가 LRU 상한(개수/용량) 초과 시 가장 오래된 세션부터 디렉토리 삭제 | High | Pending |
| FR-06 | 최근 문서 목록에서 항목 선택 시 `filePath`로 파일 재오픈 + 세션 복원, 파일 부재 시 분석은 복원하되 뷰어는 graceful degradation | Medium | Pending |
| FR-07 | 설정 토글 off 시 save/load 전체 skip | Medium | Pending |
| FR-08 | 설정에서 개별 세션 삭제 / 전체 비우기 / 총 용량·문서 수 표시 | Medium | Pending |
| FR-09 | 매니페스트/세션 파일에 schemaVersion 필드 — 미래 포맷 변경 시 안전한 무시/마이그레이션 | Medium | Pending |

### 5.2 Non-Functional Requirements

| Category | Criteria | Measurement Method |
|----------|----------|-------------------|
| Performance | 세션 복원(요약+Q&A+인덱스 역직렬화) 체감 지연 < 500ms (재임베딩 대비 극적 단축) | 수동 측정 + 임베딩 호출 0 단언 |
| Performance | 임베딩 블롭 쓰기/읽기 O(n) 바이너리, JSON 파싱 비용 0 | VectorStore serialize 라운드트립 테스트 |
| Security | 저장은 userData 내부, 경로 traversal·심볼릭링크 거부(기존 file:open 패턴), 입력 검증 IPC 경계 | 단위 테스트 + 코드 리뷰 |
| Reliability | 원자적 tmp→rename, 부분 쓰기/손상 JSON 시 안전 폴백(세션 무시, 정상 흐름) | 손상 입력 테스트 |
| Maintainability | 네이티브 의존성 0 유지, 커버리지 게이트 충족 | npm ls 확인 + CI coverage |

---

## 6. Success Criteria

### 6.1 Definition of Done

- [ ] FR-01 ~ FR-09 구현
- [ ] 단위 테스트 작성·통과 (session-store, VectorStore serialize, IPC 핸들러)
- [ ] gap 분석 ≥ 90%
- [ ] README(한/영) 기능 반영 (배치 의례에 따라 차기 묶음 가능)

### 6.2 Quality Criteria

- [ ] 커버리지 게이트 충족 (현 52/46/52/54 기준 유지/상향)
- [ ] `tsc --noEmit` strict 통과, lint 0
- [ ] `npm run build` 성공, 네이티브 의존성 0 유지

---

## 7. Risks and Mitigation

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| 콘텐츠 해시 충돌/불일치로 stale 세션 복원 | High | Low | SHA-256 + 임베딩 모델/차원 복합 키, 불일치 시 무효화. 차원 가드(verifyAnswerSentences) 패턴 재사용 |
| 임베딩 블롭 포맷 회귀(차원/엔디안) | Medium | Medium | serialize/deserialize 라운드트립 테스트 + schemaVersion 가드. 불일치 시 캐시 무시하고 재임베딩 |
| LRU 정리 중 동시 쓰기 race | Medium | Low | settingsWriteChain 류 직렬화 mutex로 매니페스트 쓰기 보호 |
| 디스크 무한 증가 | Medium | Low | LRU 상한(개수+용량) 강제, 설정 용량 표시 + 전체 비우기 |
| filePath 부재 시 뷰어 깨짐 | Low | Medium | graceful degradation — 분석 복원, 뷰어만 비활성 + 안내 |
| 손상/부분 쓰기 파일 | Medium | Low | 원자적 tmp→rename + 로드 시 try/catch → 세션 무시하고 정상 흐름 |

---

## 8. Architecture Considerations

### 8.1 Project Level Selection

| Level | Characteristics | Recommended For | Selected |
|-------|-----------------|-----------------|:--------:|
| **Starter** | Simple structure | Static sites | |
| **Dynamic** | Feature-based modules | Web/desktop apps | ✅ |
| **Enterprise** | Strict layers, DI | Microservices | |

### 8.2 Key Decisions

| Decision | Options | Selected | Rationale |
|----------|---------|----------|-----------|
| 저장 아키텍처 | A 단일JSON / B 매니페스트+블롭 / C SQLite | **B** | 데이터 성격(가벼운 텍스트+무거운 임베딩)에 부합, 네이티브 의존성 0 유지 |
| 문서 식별 | 콘텐츠 해시 / 파일 경로 | **콘텐츠 해시** | 이동/이름변경에도 캐시 재사용, 중복 파일 수렴 |
| 보존 정책 | LRU 자동 / 무제한 수동 / 둘 다 | **LRU 자동** (+ 수동 삭제 UI 포함) | 사용자 무신경 + 디스크 안전 |
| 해시 계산 위치 | renderer(extractedText) / main(bytes) | **renderer (extractedText)** | 이미 파싱된 텍스트 재사용, bytes 재전달 회피 |

### 8.3 Component Overview

```
main/
  session-store.ts        # userData/sessions/ I/O, LRU, 검증 (settings-store 패턴)
  index.ts                # IPC: session:save/load/list/delete/clear/stats
preload/
  index.ts                # electronAPI.session.* 노출
renderer/
  lib/
    vector-store.ts        # + serialize()/deserialize() (Float32 버퍼)
    session-client.ts       # electronAPI.session 래퍼
    store.ts                # 통합: 해시 계산, load-on-open, debounced save
  components/
    RecentDocuments.tsx     # 최근 문서 목록 (열기/삭제)
    SettingsPanel.tsx       # + 영속화 토글 / 용량 표시 / 전체 비우기

userData/sessions/
  manifest.json             # [{docHash, fileName, filePath, pageCount,
                            #   embedModel, embedDim, chunkCount,
                            #   lastAccessed, byteSize, schemaVersion}]
  <docHash>/
    session.json            # extractedText, pageTexts, chapters,
                            #   summaries{type→content}, qaMessages, provider/model
    index.bin               # Float32 임베딩 블롭 (청크 벡터 연결)
```

### 8.4 Data Flow

```
[PDF 열기]
   ↓ parse → docHash = SHA-256(extractedText)
[session:load(docHash)]
   ├─ HIT + embedModel/dim 일치
   │     → 요약·Q&A 복원 + ragIndex.deserialize(index.bin)
   │     → ragState.isAvailable=true  (재요약 0, 재임베딩 0)
   └─ MISS or 모델/차원 불일치
         → 기존 흐름(요약 + buildRagIndex)
         → session:save(docHash, {...}) + manifest 갱신
[요약/Q&A/인덱스 변경]
   → debounced session:save + lastAccessed=now + LRU 정리
[최근목록 클릭]
   → filePath 재오픈(뷰어 bytes) + 세션 복원
   → 파일 부재: 분석 복원 / 뷰어 비활성(graceful)
[설정 토글 off] → save/load 전체 skip
```

---

## 9. Convention Prerequisites

### 9.1 Applicable Conventions

- [x] 기존 프로젝트 컨벤션 확인 — settings-store/api-keys-store 영속화 패턴(원자적 tmp→rename, pure 모듈 분리, 검증)
- [x] 네이밍 규칙 — `*-store.ts`(main), `*-client.ts`(renderer lib), PascalCase 컴포넌트
- [x] 폴더 구조 — main/preload/renderer 경계, 순수 모듈은 별도 파일로 분리해 vitest 직접 테스트

---

## 10. Next Steps

1. [ ] 설계 문서 작성 (`/pdca design session-persistence`)
2. [ ] 팀 리뷰·승인
3. [ ] 구현 시작 (`/pdca do session-persistence`)

---

## Appendix: Brainstorming Log

| Phase | Question | Answer | Decision |
|-------|----------|--------|----------|
| Intent | 핵심 가치 우선순위 | 작업 연속성 우선(A 중심) | 세션 복원을 1순위로, 인덱스 캐싱은 토대 |
| Intent | 문서 식별 방식 | 콘텐츠 해시 기준 | 이동/이름변경 내성 + 중복 수렴 |
| Intent | 보존 정책 | 자동 정리(LRU) | LRU + 수동 삭제 UI 병행 |
| Alternatives | A 단일JSON / B 매니페스트+블롭 / C SQLite | B 선택 | 데이터 성격 부합 + 네이티브 의존성 0 |
| YAGNI | 선택 항목 4종 | 수동삭제UI·on/off토글·용량표시 포함, Vision캐싱 제외 | Vision 캐싱·멀티문서 Deferred |
| Design | ①아키텍처/②컴포넌트/③데이터흐름 | 전체 승인 | Plan 문서 생성 |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-09 | Initial draft (Plan Plus) | jjw |
