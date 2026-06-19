/**
 * 세션 영속화 공유 타입 — Main/Renderer 공용.
 *
 * Design Ref: §3 — 콘텐츠 해시 기준 세션·인덱스 캐싱.
 * constants.ts 와 동일하게 순수 값/타입만 포함(런타임 API 참조 금지). Main 의 session-store 와
 * Renderer 의 session-client 가 manifest/stats 계약을 공유해 drift 를 차단한다.
 *
 * 세션 본문(PersistedSession)은 Chapter/QaMessage 등 renderer 도메인 타입을 참조하므로
 * renderer/types 에 두고, Main 의 session-store 는 본문을 opaque(JSON) 로 저장한다.
 * 여기에는 Main 이 LRU/목록을 위해 직접 다루는 primitive-only 메타만 둔다.
 */

export const SESSION_SCHEMA_VERSION = 1;

/** LRU 정리 상한 — 디스크 무한 증가 차단 (Plan Risk: 디스크 증가) */
export const SESSION_MAX_COUNT = 30;
export const SESSION_MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200MB

/** docHash 형식 — SHA-256 hex 64자. 경로 traversal 차단용 화이트리스트. */
export const DOC_HASH_RE = /^[a-f0-9]{64}$/;

/** manifest.json 의 한 항목 — 최근목록 표시 + LRU 정렬(lastAccessed) */
export interface SessionManifestEntry {
  docHash: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  embedModel: string | null; // index.bin 을 만든 임베딩 모델 (없으면 인덱스 미저장)
  embedDim: number | null;   // 임베딩 차원
  chunkCount: number;
  byteSize: number;          // session.json + index.bin 합계
  createdAt: string;         // ISO
  lastAccessed: string;      // ISO — LRU 정렬 키
}

export interface SessionManifest {
  schemaVersion: number;
  entries: SessionManifestEntry[];
}

/** session:stats 반환 — 설정의 용량/위치 표시용 */
export interface SessionStats {
  count: number;
  totalBytes: number;
  dir: string;
}

/** 전체 문서 검색(session:search) — 매칭 페이지 스니펫. Main 의 순수 검색과 Renderer UI 공유. */
export interface SearchSnippet {
  page: number;   // 1-base 페이지 번호
  text: string;   // 매칭 주변 발췌(plain text — 렌더러가 하이라이트)
}

/** 전체 문서 검색 결과 1건 — 점수 내림차순 정렬. */
export interface GlobalSearchResult {
  docHash: string;
  fileName: string;
  filePath: string;
  pageCount: number;
  score: number;        // 매칭 가중 합(파일명 5 / 페이지 발생수 / 요약 2)
  inSummary: boolean;   // 요약 본문에도 매칭됐는지
  snippets: SearchSnippet[];
}

/**
 * Renderer 가 저장 시 제공하는 manifest 메타(byteSize/createdAt/lastAccessed 는 Main 이 계산).
 * Main 은 세션 본문을 파싱하지 않고 이 메타만으로 manifest 항목을 구성한다.
 */
export type SessionSaveMeta = Pick<
  SessionManifestEntry,
  'docHash' | 'fileName' | 'filePath' | 'pageCount' | 'embedModel' | 'embedDim' | 'chunkCount'
>;
