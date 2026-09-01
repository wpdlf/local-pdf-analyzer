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
import { listSessions, readIndexMeta, readIndexBlob, readSessionMeta } from './session-store';
// QA29(C-4): 무캡 팬아웃 + 동기 코사인 루프가 main 을 초 단위로 잡던 것을 캡 + 양보로 바꾼다.
import { mapWithConcurrency, SESSION_FANOUT_LIMIT } from './async-pool';
// QA30(B-7): 임계값은 shared 단일 출처 — 종전엔 여기와 renderer/use-qa.ts 에 리터럴 0.3 이
// 각각 있었고 둘을 잇는 것은 "renderer 와 일치" 라는 주석뿐이었다(조용한 드리프트).
import { RAG_MIN_SCORE } from '../shared/constants';

const TOP_K_PER_DOC = 3;
const SNIPPET_MAX_CHARS = 180;
const MAX_RESULTS = 50;
const MAX_SNIPPETS = 2;

interface ChunkMetaLite {
  text: string;
  pageStart?: number;
}

interface ScoredChunk {
  text: string;
  score: number;
  pageStart?: number;
}

/**
 * 한 문서의 인덱스 검색 결과 — **"결과 없음" 과 "인덱스가 깨졌음" 을 구분한다**(QA30 C-1b).
 *
 * 종전에는 둘 다 빈 배열이었다. 그래서 manifest 는 인덱스를 정상 주장하는데 index.bin 이
 * 짧거나·비-4배수거나·부재하거나·chunkMeta 가 손상된 문서가 **집계 없이** 결과에서 빠졌고
 * (excludedCount 는 모델/차원 불일치만 센다), 사용자는 "그 문서에는 관련 내용이 없다" 로
 * 결론냈다. 손상은 재임베딩으로 회복 가능하므로 신호를 살려 둔다.
 */
interface IndexSearchOutcome {
  corrupted: boolean;
  hits: ScoredChunk[];
}

/**
 * 예산 절단으로 끝에 남은 **반쪽 인용 토큰**을 제거한다.
 *
 * QA29(A-5): `slice(0, SNIPPET_MAX_CHARS)` 는 임의 오프셋에서 자르는데, 대상은 문단마다
 * `[p.N]` 이 박힌 본문이라 토큰 한가운데가 잘릴 확률이 낮지 않다. `[p.123]` 이 `[p.12` 로
 * 남으면 렌더러 인용 파서에 안 걸려 평문이 되지만 — 지금은 표시 전용이라 Low 다 — 잘린 조각이
 * 그대로 노출되는 것 자체가 QA27(B-MED)/QA28/QA29 가 반복해서 잡아온 것과 **같은 모양**이다.
 *
 * main 은 src/renderer 를 import 할 수 없다(빌드 경계). 인용 정규식을 src/shared 로 옮기는
 * 선택지도 있었지만 그러려면 renderer/lib/citation.ts 를 손대야 하고, 이 라운드에서는 다른
 * 에이전트가 그 트리를 동시에 편집 중이라 충돌을 만든다. 여기서는 **닫히지 않은 `[` 꼬리만**
 * 지우는 최소 로컬 구현을 둔다 — renderer 의 stripTrailingPartialCitation 과 같은 계약이며
 * 상한 130(= doc 그룹 상한 120 + `p.N` 여유)도 같다. 완성된 토큰은 `]` 를 포함하므로 매칭되지
 * 않는다. (인용 문법이 바뀌면 shared 승격을 재검토한다.)
 */
function stripTrailingPartialCitation(text: string): string {
  return text.replace(/\[[^\]\n]{0,130}$/, '');
}

function chunkSnippet(text: string, pageStart?: number): SearchSnippet {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= SNIPPET_MAX_CHARS) return { page: pageStart ?? 0, text: t };
  return {
    page: pageStart ?? 0, // 0 = 페이지 메타 없음
    text: stripTrailingPartialCitation(t.slice(0, SNIPPET_MAX_CHARS)).trimEnd() + '…',
  };
}

/**
 * chunkMeta 배열을 방어적으로 검증. text 가 문자열이 아니거나 구조가 어긋나면 null
 * (해당 문서 skip — 부분 성공). pageStart 만 코사인 결과 스니펫에 필요.
 */
function validateChunkMeta(cm: unknown): ChunkMetaLite[] | null {
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
 * 의미검색용 인덱스 로드 — chunkMeta(사이드카) + 벡터 blob 만 읽어 session.json(extractedText/
 * pageTexts 등 멀티MB) 파싱을 회피한다(메모리 M2). 신규 세션은 index.meta.json 에서 chunkMeta 를
 * 얻고, 사이드카가 없는 구버전 세션만 session.json 으로 fallback(그 문서 1건만 본문 파싱).
 */
async function loadSearchIndex(
  sessionsDir: string,
  docHash: string,
): Promise<{ chunkMeta: ChunkMetaLite[]; blob: ArrayBuffer } | null> {
  const blob = await readIndexBlob(sessionsDir, docHash);
  if (!blob) return null;
  const indexMeta = await readIndexMeta(sessionsDir, docHash);
  if (indexMeta) {
    const cm = validateChunkMeta(indexMeta.chunkMeta);
    if (cm) return { chunkMeta: cm, blob };
    return null;
  }
  // 구버전 fallback: 사이드카 없음 → session.json 의 chunkMeta. readSessionMeta(index.bin 미독)로
  // chunkMeta 만 파싱하고 위에서 읽은 blob 을 재사용한다 — readSession 을 쓰면 index.bin 을 한 번 더
  // 읽어 변경 전보다 오히려 손해이므로(레거시 라이브러리 회귀) 경량 경로로 처리.
  const loaded = await readSessionMeta(sessionsDir, docHash);
  const cm = validateChunkMeta((loaded?.session as { chunkMeta?: unknown } | undefined)?.chunkMeta);
  if (cm) return { chunkMeta: cm, blob };
  return null;
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
): IndexSearchOutcome {
  if (dim <= 0 || chunkMeta.length === 0) return { corrupted: true, hits: [] };
  // byteLength 가 4의 배수가 아니면(외부 손상/트렁케이션) new Float32Array 가 RangeError 를
  // 던진다. 이 함수는 try/catch 밖에서 호출되므로 가드 없이는 손상 문서 하나가 Promise.all
  // 전체를 reject 시켜 의미검색이 통째로 빈 결과가 된다 → per-doc fail-safe skip 계약 위반.
  if (blob.byteLength % 4 !== 0) return { corrupted: true, hits: [] }; // 비-4배수 손상
  const floats = new Float32Array(blob);
  if (floats.length !== chunkMeta.length * dim) return { corrupted: true, hits: [] }; // 길이 불일치
  const scored: ScoredChunk[] = [];
  for (let i = 0; i < chunkMeta.length; i++) {
    const vec = floats.subarray(i * dim, i * dim + dim);
    const score = dotClamped(queryNorm, vec);
    if (score >= RAG_MIN_SCORE && Number.isFinite(score)) {
      scored.push({ text: chunkMeta[i]!.text, score, pageStart: chunkMeta[i]!.pageStart });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  // 여기까지 왔으면 인덱스는 온전하다 — 결과가 비어도 그건 "이 질의와 관련이 없다" 이지
  // 손상이 아니다. 두 경우를 같은 `[]` 로 뭉개던 것이 아래 corruptedCount 가 없던 이유다.
  return { corrupted: false, hits: scored.slice(0, TOP_K_PER_DOC) };
}

/**
 * 저장 세션 중 (model, dim) 이 일치하고 인덱스가 있는 것만 복원·검색.
 * - chunkCount<=0 또는 embedModel===null: 인덱스 없음 → skip(제외 아님).
 * - 모델/차원 불일치: 제외(excludedCount) — 렌더러가 사용자에게 개수만 알림.
 * - 인덱스를 주장하는데 실제로 못 쓰는 문서(부재·손상·길이 불일치·일시 I/O 오류):
 *   corruptedCount (QA30 C-1b). 종전엔 **아무 데도 집계되지 않고 사라져** 사용자가 "그 문서엔
 *   관련 내용이 없다" 로 읽었다. 재임베딩(문서를 다시 열기)으로 회복 가능한 부류이므로 신호를
 *   남긴다. session-store 의 keepIndex 주석이 이미 이 상태 클래스를 인지하고 있었지만
 *   (QA21/QA26/QA27) 검색 쪽 표면은 열려 있었다.
 * model 은 렌더러의 checkEmbedModel.model(질의 임베딩 출처)이며, 이 값으로 비교해야 정상 문서가
 * ollama 태그 차이로 오제외되지 않는다(E2E 회귀 이력).
 */
export async function runSemanticSearch(
  sessionsDir: string,
  queryEmbedding: number[],
  model: string,
  dim: number,
): Promise<SemanticSearchResponse> {
  // QA24(C-M2): 종전 동작 보존 — 의미검색도 이전에는 흡수형이었다(session:search 주석 참조).
  const entries = (await listSessions(sessionsDir)) ?? [];
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

  // perf: 후보 세션 read 병렬화(결과는 끝에서 점수 정렬이라 순서 무관).
  //
  // QA29(C-4): 종전 주석은 "libuv fs 풀이 자연 바운드한다" 고 했으나 그건 **디스크 읽기**만이다.
  // 읽고 난 뒤의 JSON.parse / Float32Array 할당 / 코사인 루프는 전부 main 스레드의 동기 작업이고,
  // 무캡 Promise.all 은 그것을 한 덩어리로 밀어넣는다. 후보 수만큼 캡을 두고 문서 사이마다
  // 이벤트 루프에 양보한다 — 그 사이 종료 flush handshake(2s)·업데이터 이벤트·IPC 가 돈다.
  const perDoc = await mapWithConcurrency(
    candidates,
    SESSION_FANOUT_LIMIT,
    async (e): Promise<{ result: GlobalSearchResult | null; corrupted: boolean }> => {
      let idx: Awaited<ReturnType<typeof loadSearchIndex>>;
      try {
        idx = await loadSearchIndex(sessionsDir, e.docHash);
      } catch {
        // 일시 I/O 오류 → 해당 문서만 skip(부분 성공). 집계에는 넣는다 — 결과에서 빠졌다는
        // 사실 자체는 사용자에게 보여야 한다(무음 누락 금지).
        return { result: null, corrupted: true };
      }
      // 이 문서는 manifest 가 인덱스를 **주장해서** 후보가 됐다. 여기서 null 이면 그 주장이
      // 거짓이라는 뜻이다(index.bin 부재, chunkMeta 부재·손상) — 조용히 버리지 않는다.
      if (!idx) return { result: null, corrupted: true };
      const outcome = searchIndexBlob(queryNorm, dim, idx.chunkMeta, idx.blob);
      if (outcome.corrupted) return { result: null, corrupted: true };
      const hits = outcome.hits;
      if (hits.length === 0) return { result: null, corrupted: false }; // 정상 인덱스, 관련 없음
      return {
        result: {
          docHash: e.docHash,
          fileName: e.fileName,
          filePath: e.filePath,
          pageCount: e.pageCount,
          score: hits[0]!.score, // 최상위 청크 코사인 유사도
          inSummary: false,
          snippets: hits.slice(0, MAX_SNIPPETS).map((h) => chunkSnippet(h.text, h.pageStart)),
        },
        corrupted: false,
      };
    },
  );

  const corruptedCount = perDoc.filter((r) => r.corrupted).length;
  const results = perDoc
    .map((r) => r.result)
    .filter((r): r is GlobalSearchResult => r !== null);
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, MAX_RESULTS), excludedCount, corruptedCount };
}
