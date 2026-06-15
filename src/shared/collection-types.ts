/**
 * 컬렉션 영속화 공유 타입 — Main/Renderer 공용 (multi-doc Phase 3 / module-1).
 *
 * Design Ref: docs/02-design/features/multi-doc-phase3.design.md §3.1
 * session-types.ts 와 동일하게 순수 값/타입만(런타임 API 참조 금지). Main 의 collections-store 와
 * Renderer 의 collections-client 가 계약을 공유해 drift 를 차단한다.
 *
 * 컬렉션은 본문을 저장하지 않고 멤버 docHash 참조 목록만 보관한다(본문/요약/인덱스는 기존 per-doc
 * 세션에 그대로 존재). userData/collections.json 단일 파일.
 */

export const COLLECTION_SCHEMA_VERSION = 1;

/** 저장 컬렉션 수 상한(LRU — 디스크/UI 무한 증가 차단) */
export const COLLECTION_MAX_COUNT = 50;
/** 컬렉션당 멤버 수 상한 */
export const COLLECTION_MAX_MEMBERS = 50;
/** 컬렉션 이름 길이 상한 */
export const COLLECTION_NAME_MAX = 200;

/** collections.json 의 한 항목 */
export interface SavedCollection {
  id: string;            // uuid
  name: string;
  docHashes: string[];   // 멤버 콘텐츠 해시(session manifest 와 교차 참조)
  createdAt: string;     // ISO
  lastAccessed: string;  // ISO — 목록 정렬/LRU 키
}

export interface CollectionStoreFile {
  schemaVersion: number;
  collections: SavedCollection[];
}

/** Renderer 가 저장 시 제공하는 입력(시간/ id 는 Main 이 계산/보정) */
export interface CollectionSaveInput {
  id?: string;           // 있으면 upsert, 없으면 신규 생성
  name: string;
  docHashes: string[];
}
