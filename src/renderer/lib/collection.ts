import type { ResolvedMember, CollectionSearchResult, OpenTab } from '../types';
import type { SessionManifestEntry } from '../../shared/session-types';

/**
 * 다중 문서 컬렉션 Q&A — 순수 헬퍼 (multi-doc Phase 2, module-1).
 *
 * Design Ref: docs/02-design/features/multi-doc-collection-qa.design.md §2.2, §3.2
 *
 * 여기에는 네이티브/스토어 의존이 없는 두 가지 결정 로직만 둔다(vitest 직접 검증):
 *  - resolveMembers: 활성 문서의 (embedModel, embedDim) 기준 멤버 동질성 게이트
 *  - mergeSearchResults: 멤버별 검색 결과를 전역 점수로 병합 → 컬렉션 topK
 *
 * 인덱스 로드/검색/임베딩(부수효과)은 use-qa 의 collectionRagSearch 가 담당한다.
 */

/** 동시 로드 멤버 상한 — 비활성 멤버 index.bin 동시 복원으로 인한 메모리 폭주 차단(설계 §7) */
export const MAX_COLLECTION_MEMBERS = 20;

/**
 * 컬렉션 멤버 후보를 활성 문서 기준으로 해석해 검색 가능 여부를 판정.
 *
 * 규칙(설계 §6 동질성 게이트):
 *  - 활성 문서(activeDocHash)는 메모리 인덱스를 그대로 쓰므로 항상 source='memory'.
 *  - 비활성 멤버는 manifest 항목이 있어야 하고(없으면 missing),
 *    embedModel/embedDim 이 활성과 일치해야 ready(불일치 model-mismatch, 인덱스 없으면 no-index).
 *  - 활성 문서가 인덱스 없음(model/dim null)이면 컬렉션 검색의 기준 차원이 없으므로
 *    모든 멤버를 no-index 로 처리(호출자가 단일 문서 Q&A 로 강등).
 *
 * @param memberHashes 사용자가 선택한 멤버 docHash 목록(중복/순서 무관)
 * @param active 활성 문서의 기준값. model/dim 이 null 이면 컬렉션 검색 불가 기준.
 * @param manifest 세션 매니페스트(비활성 멤버의 embedModel/embedDim/chunkCount 조회)
 * @param tabs 표시명(fileName) 조회용 열린 탭 목록
 */
export function resolveMembers(
  memberHashes: string[],
  active: { docHash: string; model: string | null; dim: number | null },
  manifest: SessionManifestEntry[],
  tabs: OpenTab[],
): ResolvedMember[] {
  const manifestByHash = new Map(manifest.map((e) => [e.docHash, e]));
  const tabByHash = new Map(tabs.filter((t) => t.docHash).map((t) => [t.docHash as string, t]));
  const seen = new Set<string>();
  const out: ResolvedMember[] = [];

  for (const docHash of memberHashes) {
    if (seen.has(docHash)) continue; // 중복 멤버 제거(순서는 첫 등장 유지)
    seen.add(docHash);

    const fileName = tabByHash.get(docHash)?.fileName
      ?? manifestByHash.get(docHash)?.fileName
      ?? docHash;

    // 활성 문서: 메모리 인덱스 사용. 단 활성이 인덱스가 없으면 컬렉션 기준 차원 부재.
    if (docHash === active.docHash) {
      const ready = active.model !== null && active.dim !== null;
      out.push({ docHash, fileName, source: 'memory', status: ready ? 'ready' : 'no-index' });
      continue;
    }

    // 활성 문서에 기준 차원이 없으면 어떤 멤버도 통합 검색 불가
    if (active.model === null || active.dim === null) {
      out.push({ docHash, fileName, source: 'session', status: 'no-index' });
      continue;
    }

    const entry = manifestByHash.get(docHash);
    if (!entry) {
      out.push({ docHash, fileName, source: 'session', status: 'missing' });
      continue;
    }
    if (entry.embedModel === null || entry.embedDim === null || entry.chunkCount <= 0) {
      out.push({ docHash, fileName, source: 'session', status: 'no-index' });
      continue;
    }
    const homogeneous = entry.embedModel === active.model && entry.embedDim === active.dim;
    out.push({
      docHash,
      fileName,
      source: 'session',
      status: homogeneous ? 'ready' : 'model-mismatch',
    });
  }

  return out;
}

/**
 * 멤버별 검색 결과 배열들을 전역 score 로 병합해 컬렉션 topK 반환.
 *
 * 정렬: score 내림차순. 동점은 (docHash, index) 사전식 안정 정렬 — 결정적 출력 보장
 * (동일 입력 → 동일 순서, 테스트 가능성·재현성).
 *
 * @param perMember 멤버별 CollectionSearchResult[] (각 멤버 VectorStore.search 결과에 출처 부착)
 * @param topK 병합 후 상위 K개
 */
export function mergeSearchResults(
  perMember: CollectionSearchResult[][],
  topK: number,
): CollectionSearchResult[] {
  const all: CollectionSearchResult[] = [];
  for (const member of perMember) {
    for (const r of member) all.push(r);
  }
  all.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.docHash !== b.docHash) return a.docHash < b.docHash ? -1 : 1;
    return a.index - b.index;
  });
  return topK > 0 ? all.slice(0, topK) : all;
}
