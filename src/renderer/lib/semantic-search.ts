import { VectorStore } from './vector-store';
import type { GlobalSearchResult, SearchSnippet } from '../../shared/session-types';
import type { PersistedSession } from '../types';

/**
 * 의미(임베딩) 기반 전체 문서 검색 — 키워드 검색(session:search)의 상위 모드.
 *
 * 키워드는 정확한 문자열만 찾지만, 의미 검색은 질의를 임베딩해 각 문서의 저장된 RAG 인덱스
 * (index.bin)와 코사인 유사도로 비교한다(동의어·개념 매칭). 컬렉션 교차 검색(use-qa)과 동일하게
 * **활성 임베딩 모델·차원이 일치하는 문서만** 검색 대상 — 모델이 다른 문서는 제외하고 개수만 알린다.
 *
 * 렌더러에서 동작(임베딩·VectorStore·세션 로드 모두 renderer 자산). 제출 시 1회 호출.
 */

const TOP_K_PER_DOC = 3;
const MIN_SCORE = 0.3;       // RAG_MIN_SCORE 와 동일 — 약한 유사도 노이즈 컷
const SNIPPET_MAX_CHARS = 180;
const MAX_RESULTS = 50;

export type SemanticSearchStatus = 'ok' | 'no-embed-model' | 'embed-failed';

export interface SemanticSearchOutcome {
  status: SemanticSearchStatus;
  results: GlobalSearchResult[];
  excludedCount: number; // 임베딩 모델 불일치로 제외된 문서 수
}

function chunkSnippet(text: string, pageStart?: number): SearchSnippet {
  const t = text.replace(/\s+/g, ' ').trim();
  return {
    page: pageStart ?? 0, // 0 = 페이지 메타 없음
    text: t.length > SNIPPET_MAX_CHARS ? t.slice(0, SNIPPET_MAX_CHARS) + '…' : t,
  };
}

export async function searchSessionsSemantic(query: string): Promise<SemanticSearchOutcome> {
  const empty: SemanticSearchOutcome = { status: 'ok', results: [], excludedCount: 0 };
  const q = query.trim();
  if (q.length < 2) return empty;

  // 1. 활성 임베딩 모델 확인 — 없으면 의미 검색 불가(호출자가 키워드로 안내).
  const check = await window.electronAPI.ai.checkEmbedModel();
  if (!check.available || !check.model) return { status: 'no-embed-model', results: [], excludedCount: 0 };

  // 2. 질의 임베딩.
  const embRes = await window.electronAPI.ai.embed([q]);
  const queryEmbedding = embRes.success ? embRes.embeddings?.[0] : undefined;
  if (!queryEmbedding || queryEmbedding.length === 0) return { status: 'embed-failed', results: [], excludedCount: 0 };
  // 인덱스의 embedModel 은 빌드 시 checkEmbedModel.model 로 기록된다(use-qa buildRagIndex). embed IPC
  // 반환 model 은 ollama 태그(:latest 등) 차이가 있을 수 있어, 동일 출처인 check.model 로 비교해야
  // 정상 문서가 "모델 불일치"로 오제외되지 않는다. (E2E 발견 버그)
  const model = check.model;
  const dim = queryEmbedding.length;

  // 3. 저장 세션 중 (model, dim) 이 일치하고 인덱스가 있는 것만 복원·검색.
  const entries = await window.electronAPI.session.list();
  const results: GlobalSearchResult[] = [];
  let excludedCount = 0;

  for (const e of entries) {
    if (e.chunkCount <= 0 || e.embedModel === null) continue; // 인덱스 없음 → skip(제외 아님)
    if (e.embedModel !== model || e.embedDim !== dim) { excludedCount += 1; continue; } // 모델 불일치 → 제외

    let vs: VectorStore;
    try {
      const loaded = await window.electronAPI.session.load(e.docHash);
      const session = loaded?.session as PersistedSession | undefined;
      if (!loaded?.blob || !session?.embedModel || !session?.embedDim) continue;
      vs = VectorStore.restore({
        model: session.embedModel,
        dimension: session.embedDim,
        chunkMeta: session.chunkMeta ?? [],
        buffer: loaded.blob,
      });
    } catch {
      continue; // 손상/IO/블롭 크기 불일치 → 해당 문서 skip(부분 성공)
    }
    if (vs.size === 0) continue;

    const hits = vs.search(queryEmbedding, TOP_K_PER_DOC, MIN_SCORE);
    if (hits.length === 0) continue;
    results.push({
      docHash: e.docHash,
      fileName: e.fileName,
      filePath: e.filePath,
      pageCount: e.pageCount,
      score: hits[0]!.score, // 최상위 청크의 코사인 유사도
      inSummary: false,
      snippets: hits.slice(0, 2).map((h) => chunkSnippet(h.text, h.pageStart)),
    });
  }

  results.sort((a, b) => b.score - a.score);
  return { status: 'ok', results: results.slice(0, MAX_RESULTS), excludedCount };
}
