/**
 * 전체 문서 의미(임베딩) 검색 — Main 측 코사인 계산.
 *
 * 이전엔 렌더러(semantic-search.ts)가 매칭 세션마다 session:load 로 전체 본문(pageTexts/요약)+
 * 벡터 blob 을 IPC 로 받아 VectorStore 복원·검색했다(라이브러리 규모 시 수십 MB 가 경계 횡단).
 * 본 모듈은 main 이 index.bin + chunkMeta 만 읽어 코사인 후 결과(docHash/score/snippets)만
 * 반환하게 한다 — 키워드 검색(session:search)이 이미 main 에서 처리하는 것과 대칭.
 *
 * 정규화/내적은 src/shared/vector-math 단일 출처(renderer VectorStore 와 동일 로직).
 * 세션 본문은 main 입장에서 opaque(disk) 이므로 chunkMeta 를 방어적으로 파싱한다.
 */

import { normalizeToFloat32, dotClamped } from '../shared/vector-math';
import type { GlobalSearchResult, SearchSnippet, SemanticSearchResponse } from '../shared/session-types';
import { listSessions, readSession } from './session-store';

const TOP_K_PER_DOC = 3;
const MIN_SCORE = 0.3; // RAG_MIN_SCORE 와 동일 — 약한 유사도 노이즈 컷 (renderer 와 일치)
const SNIPPET_MAX_CHARS = 180;
const MAX_RESULTS = 50;
const MAX_SNIPPETS = 2;

interface ChunkMetaLite {
  text: string;
  pageStart?: number;
}

function chunkSnippet(text: string, pageStart?: number): SearchSnippet {
  const t = text.replace(/\s+/g, ' ').trim();
  return {
    page: pageStart ?? 0, // 0 = 페이지 메타 없음
    text: t.length > SNIPPET_MAX_CHARS ? t.slice(0, SNIPPET_MAX_CHARS) + '…' : t,
  };
}

/**
 * opaque 세션 JSON 에서 chunkMeta 를 방어적으로 추출. text 가 문자열이 아니거나 구조가
 * 어긋나면 null(해당 문서 skip — 부분 성공). pageStart 만 코사인 결과 스니펫에 필요.
 */
function extractChunkMeta(session: unknown): ChunkMetaLite[] | null {
  if (typeof session !== 'object' || session === null) return null;
  const cm = (session as { chunkMeta?: unknown }).chunkMeta;
  if (!Array.isArray(cm)) return null;
  const out: ChunkMetaLite[] = [];
  for (const m of cm) {
    if (typeof m !== 'object' || m === null) return null;
    const text = (m as { text?: unknown }).text;
    if (typeof text !== 'string') return null;
    const ps = (m as { pageStart?: unknown }).pageStart;
    out.push({ text, pageStart: typeof ps === 'number' ? ps : undefined });
  }
  return out;
}

/**
 * 정규화 질의 벡터 vs index.bin(정규화 Float32, row-major) 코사인 top-K.
 * blob 크기가 (chunkMeta.length × dim) 와 불일치하면 손상으로 보고 빈 결과(fail-safe skip).
 * 저장 벡터는 VectorStore.serialize 가 이미 unit-normalized 로 내보내므로 재정규화 없이 dot.
 */
function searchIndexBlob(
  queryNorm: Float32Array,
  dim: number,
  chunkMeta: ChunkMetaLite[],
  blob: ArrayBuffer,
): { text: string; score: number; pageStart?: number }[] {
  if (dim <= 0 || chunkMeta.length === 0) return [];
  // byteLength 가 4의 배수가 아니면(외부 손상/트렁케이션) new Float32Array 가 RangeError 를
  // 던진다. 이 함수는 try/catch 밖에서 호출되므로 가드 없이는 손상 문서 하나가 Promise.all
  // 전체를 reject 시켜 의미검색이 통째로 빈 결과가 된다 → per-doc fail-safe skip 계약 위반.
  if (blob.byteLength % 4 !== 0) return []; // 비-4배수 손상 → skip
  const floats = new Float32Array(blob);
  if (floats.length !== chunkMeta.length * dim) return []; // 손상/차원 불일치 → skip
  const scored: { text: string; score: number; pageStart?: number }[] = [];
  for (let i = 0; i < chunkMeta.length; i++) {
    const vec = floats.subarray(i * dim, i * dim + dim);
    const score = dotClamped(queryNorm, vec);
    if (score >= MIN_SCORE && Number.isFinite(score)) {
      scored.push({ text: chunkMeta[i]!.text, score, pageStart: chunkMeta[i]!.pageStart });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, TOP_K_PER_DOC);
}

/**
 * 저장 세션 중 (model, dim) 이 일치하고 인덱스가 있는 것만 복원·검색.
 * - chunkCount<=0 또는 embedModel===null: 인덱스 없음 → skip(제외 아님).
 * - 모델/차원 불일치: 제외(excludedCount) — 렌더러가 사용자에게 개수만 알림.
 * model 은 렌더러의 checkEmbedModel.model(질의 임베딩 출처)이며, 이 값으로 비교해야 정상 문서가
 * ollama 태그 차이로 오제외되지 않는다(E2E 회귀 이력).
 */
export async function runSemanticSearch(
  sessionsDir: string,
  queryEmbedding: number[],
  model: string,
  dim: number,
): Promise<SemanticSearchResponse> {
  const entries = await listSessions(sessionsDir);
  const queryNorm = normalizeToFloat32(queryEmbedding);

  let excludedCount = 0;
  const candidates: typeof entries = [];
  for (const e of entries) {
    if (e.chunkCount <= 0 || e.embedModel === null) continue; // 인덱스 없음 → skip
    if (e.embedModel !== model || e.embedDim !== dim) {
      excludedCount += 1; // 모델/차원 불일치 → 제외
      continue;
    }
    candidates.push(e);
  }

  // perf: 후보 세션 read 병렬화(결과는 끝에서 점수 정렬이라 순서 무관). libuv fs 풀 자연 바운드.
  const perDoc = await Promise.all(
    candidates.map(async (e): Promise<GlobalSearchResult | null> => {
      let loaded: Awaited<ReturnType<typeof readSession>>;
      try {
        loaded = await readSession(sessionsDir, e.docHash);
      } catch {
        return null;
      }
      if (!loaded?.blob) return null;
      const chunkMeta = extractChunkMeta(loaded.session);
      if (!chunkMeta) return null;
      const hits = searchIndexBlob(queryNorm, dim, chunkMeta, loaded.blob);
      if (hits.length === 0) return null;
      return {
        docHash: e.docHash,
        fileName: e.fileName,
        filePath: e.filePath,
        pageCount: e.pageCount,
        score: hits[0]!.score, // 최상위 청크 코사인 유사도
        inSummary: false,
        snippets: hits.slice(0, MAX_SNIPPETS).map((h) => chunkSnippet(h.text, h.pageStart)),
      };
    }),
  );

  const results = perDoc.filter((r): r is GlobalSearchResult => r !== null);
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, MAX_RESULTS), excludedCount };
}
