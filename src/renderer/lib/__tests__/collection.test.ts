import { describe, it, expect } from 'vitest';

// multi-doc Phase 2 module-1 — collection.ts 순수 헬퍼 L1 테스트.
// resolveMembers(동질성 게이트) + mergeSearchResults(전역 병합) 의 결정 로직 가드.

import { resolveMembers, mergeSearchResults } from '../collection';
import type { CollectionSearchResult, OpenTab } from '../../types';
import type { SessionManifestEntry } from '../../../shared/session-types';

function entry(over: Partial<SessionManifestEntry> & { docHash: string }): SessionManifestEntry {
  return {
    docHash: over.docHash,
    fileName: over.fileName ?? `${over.docHash}.pdf`,
    filePath: over.filePath ?? `/d/${over.docHash}.pdf`,
    pageCount: over.pageCount ?? 10,
    // 명시적 null 을 보존해야 'embedModel null → no-index' 케이스가 검증된다.
    // 키 미존재 시에만 기본값, 존재 시 값 유지(undefined 만 null 로 정규화 — 타입 string|null 충족).
    embedModel: 'embedModel' in over ? (over.embedModel ?? null) : 'nomic-embed-text',
    embedDim: 'embedDim' in over ? (over.embedDim ?? null) : 768,
    chunkCount: over.chunkCount ?? 5,
    byteSize: over.byteSize ?? 1000,
    createdAt: over.createdAt ?? '2026-06-15T00:00:00.000Z',
    lastAccessed: over.lastAccessed ?? '2026-06-15T00:00:00.000Z',
  };
}

function tab(docHash: string, fileName: string): OpenTab {
  return { filePath: `/d/${fileName}`, fileName, pageCount: 10, docHash };
}

function hit(over: Partial<CollectionSearchResult> & { docHash: string; score: number; index: number }): CollectionSearchResult {
  return {
    text: over.text ?? `chunk ${over.index}`,
    score: over.score,
    index: over.index,
    pageStart: over.pageStart,
    pageEnd: over.pageEnd,
    docHash: over.docHash,
    fileName: over.fileName ?? `${over.docHash}.pdf`,
  };
}

describe('resolveMembers (동질성 게이트)', () => {
  const active = { docHash: 'a', model: 'nomic-embed-text', dim: 768 };

  it('활성 문서는 항상 memory source — 인덱스 있으면 ready', () => {
    const out = resolveMembers(['a'], active, [], [tab('a', 'A.pdf')]);
    expect(out).toEqual([{ docHash: 'a', fileName: 'A.pdf', source: 'memory', status: 'ready' }]);
  });

  it('동일 (모델,차원) 비활성 멤버는 ready (session source)', () => {
    const out = resolveMembers(['b'], active, [entry({ docHash: 'b', fileName: 'B.pdf' })], [tab('b', 'B.pdf')]);
    expect(out[0]).toMatchObject({ docHash: 'b', source: 'session', status: 'ready' });
  });

  it('모델 불일치 → model-mismatch', () => {
    const out = resolveMembers(['b'], active, [entry({ docHash: 'b', embedModel: 'text-embedding-3-small', embedDim: 1536 })], []);
    expect(out[0]?.status).toBe('model-mismatch');
  });

  it('차원 불일치 → model-mismatch', () => {
    const out = resolveMembers(['b'], active, [entry({ docHash: 'b', embedModel: 'nomic-embed-text', embedDim: 512 })], []);
    expect(out[0]?.status).toBe('model-mismatch');
  });

  it('manifest 항목 없음 → missing', () => {
    const out = resolveMembers(['z'], active, [], []);
    expect(out[0]?.status).toBe('missing');
  });

  it('인덱스 없는 멤버(chunkCount=0/embedModel null) → no-index', () => {
    const out = resolveMembers(
      ['b', 'c'],
      active,
      [entry({ docHash: 'b', chunkCount: 0 }), entry({ docHash: 'c', embedModel: null, embedDim: null })],
      [],
    );
    expect(out.map((m) => m.status)).toEqual(['no-index', 'no-index']);
  });

  it('활성 문서에 인덱스 없으면(model/dim null) 모든 멤버 no-index (컬렉션 기준 차원 부재)', () => {
    const noIdxActive = { docHash: 'a', model: null, dim: null };
    const out = resolveMembers(['a', 'b'], noIdxActive, [entry({ docHash: 'b' })], [tab('a', 'A.pdf')]);
    expect(out.map((m) => m.status)).toEqual(['no-index', 'no-index']);
  });

  it('중복 멤버는 첫 등장만 유지', () => {
    const out = resolveMembers(['b', 'b', 'a'], active, [entry({ docHash: 'b' })], [tab('a', 'A.pdf'), tab('b', 'B.pdf')]);
    expect(out.map((m) => m.docHash)).toEqual(['b', 'a']);
  });

  it('fileName 은 탭 우선 → manifest → docHash 순으로 해석', () => {
    const out = resolveMembers(
      ['t', 'm', 'h'],
      active,
      [entry({ docHash: 'm', fileName: 'fromManifest.pdf' })],
      [tab('t', 'fromTab.pdf')],
    );
    expect(out[0]?.fileName).toBe('fromTab.pdf');      // 탭
    expect(out[1]?.fileName).toBe('fromManifest.pdf'); // manifest
    expect(out[2]?.fileName).toBe('h');                // fallback: docHash
  });
});

describe('mergeSearchResults (전역 병합)', () => {
  it('멤버별 결과를 score 내림차순으로 병합 후 topK 컷', () => {
    const m1 = [hit({ docHash: 'a', score: 0.9, index: 0 }), hit({ docHash: 'a', score: 0.5, index: 1 })];
    const m2 = [hit({ docHash: 'b', score: 0.7, index: 0 }), hit({ docHash: 'b', score: 0.4, index: 1 })];
    const out = mergeSearchResults([m1, m2], 3);
    expect(out.map((r) => r.score)).toEqual([0.9, 0.7, 0.5]);
    expect(out[0]?.docHash).toBe('a');
    expect(out[1]?.docHash).toBe('b');
  });

  it('동점은 (docHash, index) 안정 정렬 — 결정적 출력', () => {
    const out = mergeSearchResults([
      [hit({ docHash: 'b', score: 0.8, index: 2 })],
      [hit({ docHash: 'a', score: 0.8, index: 5 }), hit({ docHash: 'a', score: 0.8, index: 1 })],
    ], 10);
    // 동점 0.8 → docHash 'a' 먼저, 그 안에서 index 오름차순
    expect(out.map((r) => `${r.docHash}:${r.index}`)).toEqual(['a:1', 'a:5', 'b:2']);
  });

  it('topK<=0 이면 전체 반환', () => {
    const out = mergeSearchResults([[hit({ docHash: 'a', score: 0.5, index: 0 })]], 0);
    expect(out).toHaveLength(1);
  });

  it('빈 입력 → 빈 배열', () => {
    expect(mergeSearchResults([], 5)).toEqual([]);
    expect(mergeSearchResults([[], []], 5)).toEqual([]);
  });

  it('출처(docHash/fileName)와 page 메타를 보존', () => {
    const out = mergeSearchResults([[hit({ docHash: 'a', fileName: 'A.pdf', score: 0.9, index: 0, pageStart: 3, pageEnd: 4 })]], 5);
    expect(out[0]).toMatchObject({ docHash: 'a', fileName: 'A.pdf', pageStart: 3, pageEnd: 4 });
  });
});
