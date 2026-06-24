import type { GlobalSearchResult } from '../../shared/session-types';

/**
 * 의미(임베딩) 기반 전체 문서 검색 — 키워드 검색(session:search)의 상위 모드.
 *
 * 키워드는 정확한 문자열만 찾지만, 의미 검색은 질의를 임베딩해 각 문서의 저장된 RAG 인덱스
 * (index.bin)와 코사인 유사도로 비교한다(동의어·개념 매칭). 활성 임베딩 모델·차원이 일치하는
 * 문서만 검색 대상 — 모델이 다른 문서는 제외하고 개수만 알린다.
 *
 * 렌더러는 질의 임베딩만 담당(checkEmbedModel + embed). 코사인 검색·세션 복원은 main 으로 위임한다
 * (session:searchSemantic) — 이전엔 매칭 세션마다 session:load 로 전체 본문+벡터 blob 을 IPC 로 받아
 * 렌더러에서 VectorStore 복원·검색했으나(라이브러리 규모 시 수십 MB 횡단), 무거운 페이로드가 경계를
 * 넘지 않도록 main 이전. 제출 시 1회 호출.
 */

export type SemanticSearchStatus = 'ok' | 'no-embed-model' | 'embed-failed';

export interface SemanticSearchOutcome {
  status: SemanticSearchStatus;
  results: GlobalSearchResult[];
  excludedCount: number; // 임베딩 모델 불일치로 제외된 문서 수
}

export async function searchSessionsSemantic(query: string): Promise<SemanticSearchOutcome> {
  const q = query.trim();
  if (q.length < 2) return { status: 'ok', results: [], excludedCount: 0 };

  // 1. 활성 임베딩 모델 확인 — 없으면 의미 검색 불가(호출자가 키워드로 안내).
  const check = await window.electronAPI.ai.checkEmbedModel();
  if (!check.available || !check.model) return { status: 'no-embed-model', results: [], excludedCount: 0 };

  // 2. 질의 임베딩.
  const embRes = await window.electronAPI.ai.embed([q]);
  const queryEmbedding = embRes.success ? embRes.embeddings?.[0] : undefined;
  if (!queryEmbedding || queryEmbedding.length === 0) return { status: 'embed-failed', results: [], excludedCount: 0 };

  // 3. 코사인 검색은 main 위임. 인덱스의 embedModel 은 빌드 시 checkEmbedModel.model 로 기록되므로
  //    embed IPC 반환 model(ollama 태그 :latest 차이 가능) 대신 동일 출처인 check.model 로 비교해야
  //    정상 문서가 "모델 불일치"로 오제외되지 않는다(E2E 발견 버그). 차원은 질의 임베딩 길이.
  const outcome = await window.electronAPI.session.searchSemantic(queryEmbedding, check.model, queryEmbedding.length);
  return { status: 'ok', results: outcome.results, excludedCount: outcome.excludedCount };
}
