---
template: design
version: 1.3
feature: session-persistence
date: 2026-06-09
author: jjw
project: local-pdf-analyzer (summary-lecture-material)
version_project: 0.18.26
---

# Session Persistence + RAG Index Caching Design Document

> **Summary**: 콘텐츠 해시 기준으로 요약·Q&A는 JSON, 임베딩은 Float32 바이너리 블롭으로 영속화해, 동일 문서 재오픈 시 재요약·재임베딩 없이 복원한다. (Architecture Option C — Pragmatic)
>
> **Project**: local-pdf-analyzer
> **Version**: 0.18.26
> **Author**: jjw
> **Date**: 2026-06-09
> **Status**: Draft
> **Planning Doc**: [session-persistence.plan.md](../../01-plan/features/session-persistence.plan.md)

---

## Context Anchor

> Plan 의 Executive Summary/Requirements/Risk 에서 합성 (Plan-plus 템플릿에 Context Anchor 표가 없어 Design 단계에서 생성).

| Key | Value |
|-----|-------|
| **WHY** | 단일 문서·휘발성 구조라 재오픈 시 재요약·재임베딩 강제 + 클라우드 임베딩 토큰 재과금. 작업 연속성 확보가 목표. |
| **WHO** | 같은 PDF를 여러 세션에 반복 분석하는 학습/연구 사용자, 클라우드 임베딩(OpenAI) 사용자. |
| **RISK** | stale 세션 복원(해시/모델/차원 불일치), 임베딩 블롭 포맷 회귀, 디스크 무한 증가, filePath 부재 시 뷰어. |
| **SUCCESS** | 동일 콘텐츠 재오픈 시 요약·Q&A·인덱스가 재호출 0으로 복원, 모델/차원 불일치 시 안전 무효화, LRU 자동 정리. |
| **SCOPE** | In: 세션 저장/복원·인덱스 캐싱·해시 식별/무효화·최근목록·LRU·수동삭제UI·토글·용량표시. Out: Vision 캐싱·멀티문서·암호화·SQLite. |

---

## 1. Overview

### 1.1 Design Goals

- 동일 콘텐츠 문서 재오픈 시 요약·Q&A·RAG 인덱스를 **재요약/재임베딩 0**으로 복원.
- 임베딩(무거움)과 텍스트(가벼움)를 성격에 맞는 매체로 분리 저장(바이너리 블롭 / JSON).
- 캐시 무효화를 콘텐츠 해시 + 임베딩 모델 + 차원의 복합 키로 정확히 보장.
- 기존 `settings-store`/`api-keys-store` 패턴(원자적 tmp→rename, 순수 헬퍼 분리, 검증)과 **네이티브 의존성 0** 유지.

### 1.2 Design Principles

- **기존 패턴 동형성**: `session-store.ts`는 기존 `*-store.ts`와 같은 구조·테스트 가능성.
- **순수 헬퍼 분리**: 해시·LRU·블롭 직렬화 등 native-dep 없는 로직은 별도 함수로 분리해 vitest 직접 검증.
- **Fail-safe**: 손상/부분 쓰기/포맷 불일치 시 세션을 무시하고 정상(재계산) 흐름으로 안전 폴백.
- **YAGNI**: 매니페스트+블롭 이상으로 추상화하지 않음(과분할·암호화·DB 금지).

---

## 2. Architecture Options (v1.7.0)

### 2.0 Architecture Comparison

| Criteria | Option A: Minimal | Option B: Clean | Option C: Pragmatic |
|----------|:-:|:-:|:-:|
| **Approach** | 통합 로직을 store.ts 직접 | manifest/blob/lru/service 완전 분리 | 단일 응집 store + 순수 헬퍼 분리 |
| **New Files** | ~3 | ~7-8 | ~4 |
| **Modified Files** | ~5 | ~5 | ~5 |
| **Complexity** | Low | High | Medium |
| **Maintainability** | Medium | High | High |
| **Effort** | Low | High | Medium |
| **Risk** | store.ts 비대화 | 추상화 과잉(YAGNI) | 균형 |
| **Recommendation** | 빠른 핫픽스 | 장기 대형 | **Default choice** |

**Selected**: Option C — **Rationale**: 기존 `settings-store`/`api-keys-store`가 이미 "단일 응집 모듈 + 순수 헬퍼 분리"이고 렌더러는 `*-client.ts` + store 액션 패턴이다. C는 이 컨벤션과 정확히 일치하면서 YAGNI를 지킨다. A는 이미 큰 `store.ts`를 비대화시키고, B는 파일 단위 저장 규모 대비 manifest/blob 분리가 과잉이다.

### 2.1 Component Diagram

```
┌──────────────── Renderer ────────────────┐      ┌──────────── Main ────────────┐
│ store.ts (Zustand)                        │      │ session-store.ts             │
│  ├─ loadDocument() → hashDoc()            │ IPC  │  ├─ loadManifest / save      │
│  ├─ tryRestoreSession() ──────────────────┼─────▶│  ├─ readSession / writeSession│
│  └─ debouncedPersist() ───────────────────┼─────▶│  ├─ readBlob / writeBlob     │
│ session-client.ts (electronAPI.session.*) │      │  ├─ enforceLru (순수 헬퍼)    │
│ vector-store.ts                            │      │  └─ deleteSession / clearAll │
│  ├─ serialize() → {meta, buffer}          │      │ index.ts: ipcMain.handle     │
│  └─ static restore(meta, buffer)          │      │   session:save/load/list/    │
│ session-hash.ts (SHA-256 순수 헬퍼)        │      │   delete/clear/stats         │
│ components/RecentDocuments.tsx            │      │ preload: electronAPI.session  │
│ components/SettingsPanel.tsx (+섹션)       │      └──────────────────────────────┘
└────────────────────────────────────────────┘      userData/sessions/{manifest.json, <hash>/session.json, <hash>/index.bin}
```

### 2.2 Data Flow

```
[PDF 열기] → parse → docHash = SHA-256(extractedText)
   ↓ session.load(docHash)
   ├─ HIT + embedModel·embedDim == 현재 임베딩 설정
   │     → summary/qaMessages 복원 + VectorStore.restore(meta, blob)
   │     → ragState.isAvailable = true   (재요약 0, 재임베딩 0)
   └─ MISS | 모델·차원 불일치 | 손상
         → 기존 흐름(요약 + buildRagIndex)
         → debounced session.save(...) + manifest 갱신 + enforceLru()
[요약/Q&A/인덱스 변경] → debounced session.save + lastAccessed=now + enforceLru()
[최근목록 클릭] → file:open-pdf(filePath) → 세션 복원 (파일 부재 시 분석만 복원, 뷰어 graceful)
[토글 off] → save/load 전체 skip
```

### 2.3 Dependencies

| Component | Depends On | Purpose |
|-----------|-----------|---------|
| store.ts | session-client, session-hash, vector-store | 오픈 시 복원 / 변경 시 저장 |
| session-client.ts | preload electronAPI.session | IPC 래퍼 |
| index.ts (main) | session-store.ts | IPC 핸들러 위임 |
| session-store.ts | fs/promises, app.getPath('userData') | 파일 I/O, LRU |
| RecentDocuments.tsx | session-client, store | 목록 표시·열기·삭제 |

---

## 3. Data Model

### 3.1 Entity Definition

```typescript
// userData/sessions/manifest.json
interface SessionManifest {
  schemaVersion: number;            // 현재 1
  entries: SessionManifestEntry[];
}

interface SessionManifestEntry {
  docHash: string;                  // SHA-256(extractedText) hex
  fileName: string;
  filePath: string;
  pageCount: number;
  embedModel: string | null;        // index.bin 을 만든 임베딩 모델
  embedDim: number | null;          // 임베딩 차원
  chunkCount: number;
  byteSize: number;                 // session.json + index.bin 합계
  createdAt: string;                // ISO
  lastAccessed: string;             // ISO — LRU 정렬 키
}

// userData/sessions/<docHash>/session.json
interface PersistedSession {
  schemaVersion: number;            // 현재 1
  docHash: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  // 파싱 텍스트 (재파싱 없이 Q&A 컨텍스트 복원). images 는 미저장(용량·Vision 캐싱은 Out of Scope)
  extractedText: string;
  pageTexts: string[];
  chapters: Chapter[];
  isOcr?: boolean;
  // 분석 결과
  summaries: Partial<Record<DefaultSummaryType, PersistedSummary>>;  // 타입별 요약
  summaryType: DefaultSummaryType;
  qaMessages: QaMessage[];
  // 인덱스 메타 (벡터 본체는 index.bin)
  embedModel: string | null;
  embedDim: number | null;
  chunkMeta: PersistedChunkMeta[];  // 벡터 순서와 1:1 평행
}

interface PersistedSummary { content: string; model: string; provider: AiProviderType; }
interface PersistedChunkMeta { text: string; index: number; pageStart?: number; pageEnd?: number; }

// userData/sessions/<docHash>/index.bin
// 순수 Float32 little-endian 버퍼. chunkCount × embedDim floats, row-major.
// chunk i 의 (unit-normalized) 벡터 = floats[i*dim .. i*dim+dim]. 헤더 없음(메타는 session.json).
```

### 3.2 VectorStore 직렬화 계약

```typescript
// vector-store.ts 에 추가
interface SerializedIndex {
  model: string | null;
  dimension: number | null;
  chunkMeta: PersistedChunkMeta[];   // text/index/pageStart/pageEnd
  buffer: ArrayBuffer;               // Float32 정규화 벡터 연결 (count × dim)
}

class VectorStore {
  serialize(): SerializedIndex;                       // 이미 정규화된 embedding 을 그대로 export
  static restore(s: SerializedIndex): VectorStore;    // 재정규화 없이 chunks 직접 복원
}
```

> `addChunk` 는 입력을 재정규화하지만, `restore` 는 이미 정규화된 블롭을 **재정규화 없이** 직접 push 한다(정확성·성능). dimension/model 도 메타에서 복원.

### 3.3 저장 레이아웃

```
userData/sessions/
├── manifest.json                 # SessionManifest
├── <docHash-1>/
│   ├── session.json              # PersistedSession
│   └── index.bin                 # Float32 blob
└── <docHash-2>/ ...
```

---

## 4. IPC Specification (REST 대체 — Electron IPC)

> 이 앱은 BaaS/REST 가 아니라 Electron IPC 경계를 쓴다. 기존 `settings:*`/`apikey:*` 핸들러와 동형.

### 4.1 채널 목록

| Channel | 인자 | 반환 | 설명 |
|---------|------|------|------|
| `session:load` | `docHash: string` | `PersistedSession \| null` + blob | 해시로 세션+블롭 로드. 없으면 null |
| `session:save` | `PersistedSession`, `ArrayBuffer(blob)` | `{ ok: boolean }` | 세션+블롭 저장 + manifest 갱신 + LRU |
| `session:list` | — | `SessionManifestEntry[]` | 최근목록(lastAccessed desc) |
| `session:delete` | `docHash: string` | `{ ok: boolean }` | 단일 세션 디렉토리 삭제 + manifest 제거 |
| `session:clear` | — | `{ ok: boolean }` | 전체 세션 비우기 |
| `session:stats` | — | `{ count: number; totalBytes: number; dir: string }` | 용량/위치 표시용 |

### 4.2 세부 동작

- **session:save**: `docHash` 검증(hex 64자) → `<userData>/sessions/<docHash>/` 보장 → `index.bin`·`session.json` 각각 원자적 tmp→rename → manifest 항목 upsert(lastAccessed=now, byteSize 재계산) → `enforceLru(manifest)` → manifest 원자적 저장. write 직렬화 mutex(기존 settingsWriteChain 패턴)로 동시 호출 race 차단.
- **session:load**: docHash 검증 → session.json 읽기(파싱 실패 시 null) → index.bin 읽어 ArrayBuffer 반환. manifest lastAccessed 갱신은 호출자(store)가 save 시 처리하거나 load 시 touch. blob 미존재/크기 불일치(chunkCount×dim×4)면 인덱스 부분만 null 처리.
- **검증/보안**: docHash 는 `/^[a-f0-9]{64}$/` 만 허용(경로 traversal 차단). filePath 는 저장값(표시용)일 뿐 main 이 직접 열지 않음 — 최근목록 열기는 기존 `file:open-pdf`(심볼릭링크/확장자/크기 가드) 재사용.

### 4.3 에러 응답

- 로드 실패(손상 JSON/IO) → `null` 반환(throw 아님) → 렌더러는 정상 재계산 흐름.
- 저장 실패(디스크 풀/권한) → `{ ok: false }` + console.warn. 사용자 작업 비차단(세션 저장은 best-effort).

---

## 5. UI/UX Design

### 5.1 화면 배치

```
┌──────────────────────────────────────────────┐
│ Header                                         │
├───────────────┬────────────────────────────────┤
│ (문서 없음 시)  │  Main: 업로드 영역              │
│ 최근 문서 목록   │   └ RecentDocuments 카드 리스트 │
│  - 파일명/날짜   │                                │
│  - [열기][삭제]  │                                │
├───────────────┴────────────────────────────────┤
│ Settings Panel ▸ 데이터 섹션                    │
│  - [토글] 세션·캐시 저장                         │
│  - 저장 용량: N개 문서, X MB  (위치: …/sessions) │
│  - [전체 비우기]                                 │
└──────────────────────────────────────────────┘
```

### 5.2 User Flow

```
앱 시작(문서 없음) → 최근 문서 목록 표시 → 항목 [열기] → 파일 재오픈 + 세션 복원
PDF 새로 열기 → (해시 hit) 즉시 복원 / (miss) 분석 후 자동 저장
설정 → 토글 off → 이후 저장/복원 중지 ; [전체 비우기] → 확인 → clear
```

### 5.3 Component List

| Component | Location | Responsibility |
|-----------|----------|----------------|
| RecentDocuments | src/renderer/components/RecentDocuments.tsx | 최근목록 표시·열기·개별 삭제 |
| SettingsPanel (확장) | src/renderer/components/SettingsPanel.tsx | 영속화 토글·용량 표시·전체 비우기 |

### 5.4 Page UI Checklist

#### RecentDocuments (문서 미선택 화면)
- [ ] List: 최근 문서 카드 (fileName, 페이지수, lastAccessed 상대시간, chunkCount/임베딩 모델 배지)
- [ ] Button: 각 카드 "열기" (filePath 재오픈 + 세션 복원)
- [ ] Button: 각 카드 "삭제" (session:delete + 목록 갱신)
- [ ] Empty state: 목록 비었을 때 안내 문구 (Ko/En)
- [ ] Degraded badge: filePath 파일 부재 추정 시 "원본 없음 — 분석만 복원" 표시(열기 시 확정)

#### SettingsPanel — 데이터 섹션 (신규)
- [ ] Toggle: "세션·캐시 저장" on/off (기본 on)
- [ ] Text: "저장: N개 문서 · X MB" + 위치 경로(session:stats)
- [ ] Button: "전체 비우기" → 확인 다이얼로그 → session:clear
- [ ] i18n: 위 모든 라벨 Ko/En 키 추가

---

## 6. Error Handling

### 6.1 에러/엣지 처리

| 상황 | 원인 | 처리 |
|------|------|------|
| 손상/부분 쓰기 session.json | IO 중단 | 로드 시 try/catch → null → 정상 재계산 |
| index.bin 크기 불일치 | 포맷 회귀/중단 | chunkCount×dim×4 검증 실패 시 인덱스 무시 → 재임베딩 |
| 임베딩 모델/차원 불일치 | 사용자가 임베딩 모델 변경 | manifest.embedModel/Dim ≠ 현재 설정 → 인덱스 무효화(요약·Q&A 텍스트는 복원 가능) |
| docHash 형식 위반 | 비정상 IPC 입력 | `/^[a-f0-9]{64}$/` 불통과 시 거부 |
| filePath 파일 부재 | 이동/삭제 | file:open-pdf 실패 → 분석 복원 유지, 뷰어 비활성 + 안내 |
| 디스크 풀/권한 | 저장 실패 | `{ ok:false }` + warn, 작업 비차단 |

### 6.2 에러 응답 형식

```typescript
// 저장류
{ ok: false }   // + console.warn(`[session] save failed: ${msg}`)
// 로드류
null            // 호출자(store)가 정상 재계산 분기
```

---

## 7. Security Considerations

- [x] 입력 검증: docHash `/^[a-f0-9]{64}$/` (경로 traversal 차단), 저장 루트는 userData 하위로 고정.
- [x] 경로 안전: 세션 디렉토리 경로는 `path.join(userData, 'sessions', docHash)` — docHash 화이트리스트로 `..` 불가.
- [x] 파일 열기는 기존 `file:open-pdf`(lstat 심볼릭링크 거부·확장자·100MB 캡) 재사용 — 신규 경로 신뢰 표면 없음.
- [x] 민감정보: 세션에 API 키 미포함(요약·Q&A·텍스트·임베딩만). 평문 저장은 userData OS 권한 의존(암호화는 Out of Scope, Plan 명시).
- [x] DoS: LRU 상한(개수+용량)으로 디스크 무한 증가 차단. blob 크기 상한(문서당) 검증.
- [x] write race: manifest 쓰기 직렬화 mutex.

---

## 8. Test Plan (vitest 적응)

> 이 앱은 Playwright/REST 가 아니라 **vitest 단위/행위 테스트**로 검증한다(기존 36파일 708 테스트와 동일 체계). 아래 L1-L3 를 vitest 레벨로 매핑.

### 8.1 Test Scope

| Type | Target | Tool | Phase |
|------|--------|------|-------|
| L1: 순수 헬퍼 | session-hash, enforceLru, blob 직렬화 | vitest | Do |
| L2: 모듈 I/O | session-store 저장/로드/삭제/clear/stats (fs 모킹) | vitest | Do |
| L3: 통합 행위 | IPC 핸들러(session:*) + store 복원 흐름 (electron 모킹 하니스) | vitest | Do |

### 8.2 L1 — 순수 헬퍼 시나리오

| # | 대상 | 검증 |
|---|------|------|
| 1 | session-hash | 동일 extractedText → 동일 64자 hex, 다른 텍스트 → 다른 해시 |
| 2 | VectorStore.serialize/restore | 라운드트립: restore 후 search 결과가 원본과 동일(벡터·page·text 보존), dimension/model 복원 |
| 3 | restore 차원 검증 | buffer.byteLength ≠ count×dim×4 → 무효(null/throw) 처리 |
| 4 | enforceLru | 개수/용량 초과 시 lastAccessed 오래된 것부터 제거, 경계값(정확히 상한) |

### 8.3 L2 — session-store I/O 시나리오 (fs/promises 모킹)

| # | 동작 | 검증 |
|---|------|------|
| 1 | writeSession | tmp→rename 원자적 호출, session.json+index.bin 양쪽 기록, manifest upsert |
| 2 | readSession | 정상 라운드트립, 손상 JSON → null |
| 3 | readSession blob 불일치 | 크기 검증 실패 시 인덱스 부분 null |
| 4 | deleteSession | 디렉토리 삭제 + manifest 항목 제거 |
| 5 | clearAll | sessions 디렉토리 비우기 + manifest 리셋 |
| 6 | stats | count/totalBytes/dir 정확 |
| 7 | LRU 통합 | save 누적 시 상한 초과분 자동 제거 |

### 8.4 L3 — IPC + store 복원 행위 (electron 모킹)

| # | 시나리오 | 검증 |
|---|----------|------|
| 1 | session:save/load 핸들러 | docHash 검증, store-store 위임, ok/null 계약 |
| 2 | docHash 형식 위반 | 거부, 파일 접근 미발생 |
| 3 | store 복원 흐름(hit, 모델 일치) | embed/summarize 호출 0, ragState.isAvailable=true |
| 4 | store 복원 흐름(모델 불일치) | 인덱스 무효화, 재임베딩 트리거, 요약·Q&A 텍스트는 복원 |
| 5 | 토글 off | save/load 호출 자체 skip |

### 8.5 Seed/Fixture 요구

| Fixture | 최소 | 필수 필드 |
|---------|:---:|-----------|
| PersistedSession 샘플 | 2 | docHash, extractedText, summaries, qaMessages, chunkMeta |
| 임베딩 블롭 | 1 | dim=3 소형 Float32 (라운드트립용) |

---

## 9. Clean Architecture

### 9.4 This Feature's Layer Assignment

| Component | Layer | Location |
|-----------|-------|----------|
| RecentDocuments / SettingsPanel | Presentation | src/renderer/components/ |
| store.ts 복원/저장 액션, session-client | Application | src/renderer/lib/ |
| PersistedSession/Manifest 타입, session-hash, VectorStore.serialize | Domain | src/renderer/types/, src/renderer/lib/ |
| session-store.ts (fs I/O), preload | Infrastructure | src/main/, src/preload/ |

> 의존 방향: Presentation → Application → Domain ← Infrastructure(main session-store). 렌더러는 Infrastructure(main fs)를 IPC 경계 너머로만 접근.

---

## 10. Coding Convention Reference

### 10.4 This Feature's Conventions

| Item | Convention Applied |
|------|-------------------|
| Component naming | PascalCase (`RecentDocuments.tsx`) |
| 모듈 파일 | main `session-store.ts`, 렌더러 `session-client.ts`/`session-hash.ts` (기존 `*-store`/`*-client` 패턴) |
| 순수 헬퍼 분리 | hash/LRU/serialize 를 native-dep 없는 함수로 → vitest 직접 import |
| 영속화 I/O | 원자적 tmp→rename + write 직렬화 mutex (settings-store 동형) |
| 에러 처리 | 저장 best-effort(`{ok}`), 로드 fail-safe(`null` → 재계산) |
| i18n | 신규 UI 라벨 Ko/En 키 동시 추가 |

---

## 11. Implementation Guide

### 11.1 File Structure

```
src/
├── main/
│   ├── session-store.ts          # NEW: userData/sessions I/O, LRU, 검증
│   └── index.ts                  # MOD: session:* IPC 핸들러
├── preload/
│   └── index.ts                  # MOD: electronAPI.session.* + 타입
├── renderer/
│   ├── lib/
│   │   ├── session-client.ts     # NEW: electronAPI.session 래퍼
│   │   ├── session-hash.ts       # NEW: SHA-256(extractedText) 순수 헬퍼
│   │   ├── vector-store.ts       # MOD: serialize()/restore()
│   │   └── store.ts              # MOD: 오픈 시 복원, 변경 시 debounced 저장
│   ├── components/
│   │   ├── RecentDocuments.tsx   # NEW
│   │   └── SettingsPanel.tsx     # MOD: 데이터 섹션
│   └── types/index.ts            # MOD: PersistedSession/Manifest/Serialized 타입
```

### 11.2 Implementation Order

1. [ ] 타입 정의 (PersistedSession/Manifest/SerializedIndex) + session-hash 순수 헬퍼 (+L1 테스트)
2. [ ] VectorStore.serialize()/restore() (+L1 라운드트립 테스트)
3. [ ] main session-store.ts (I/O·LRU·검증) (+L2 테스트)
4. [ ] IPC 핸들러 session:* + preload 노출 (+L3 행위 테스트)
5. [ ] renderer session-client + store 복원/저장 통합 (+L3 store 흐름 테스트)
6. [ ] RecentDocuments + SettingsPanel 데이터 섹션 + i18n
7. [ ] 통합 검증(tsc/test/build) + gap 분석

### 11.3 Session Guide

#### Module Map

| Module | Scope Key | Description | Estimated Turns |
|--------|-----------|-------------|:---------------:|
| 영속화 코어 | `module-1` | 타입 + session-hash + VectorStore serialize/restore + L1 | 15-20 |
| main 저장소 | `module-2` | session-store.ts + IPC + preload + L2/L3 | 20-25 |
| 렌더러 통합 | `module-3` | session-client + store 복원/저장 흐름 + L3 | 20-25 |
| UI | `module-4` | RecentDocuments + SettingsPanel + i18n | 15-20 |

#### Recommended Session Plan

| Session | Phase | Scope | Turns |
|---------|-------|-------|:-----:|
| 1 | Plan + Design | 전체 | 완료 |
| 2 | Do | `--scope module-1,module-2` | 40-50 |
| 3 | Do | `--scope module-3,module-4` | 40-50 |
| 4 | Check + Report | 전체 | 30-40 |

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 0.1 | 2026-06-09 | Initial draft (Option C selected) | jjw |
