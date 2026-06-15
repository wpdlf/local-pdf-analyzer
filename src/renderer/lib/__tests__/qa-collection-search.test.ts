import { describe, it, expect, vi, beforeEach } from 'vitest';

// multi-doc Phase 2 module-1 — collectionRagSearch L2 통합 테스트.
// 활성(메모리)+비활성(세션 index.bin 복원) 혼합 검색, 재임베딩 0, 모델 불일치 제외,
// 멤버 로드 실패 시 부분 성공, 컨텍스트 출처(문서명) 라벨을 검증.

const mockEmbed = vi.fn();
const mockAbort = vi.fn(() => Promise.resolve());
const mockSessionLoad = vi.fn();
vi.stubGlobal('window', {
  electronAPI: {
    ai: { embed: mockEmbed, abort: mockAbort },
    session: { load: mockSessionLoad },
  },
});
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { collectionRagSearch } from '../use-qa';
import { useAppStore } from '../store';
import { VectorStore } from '../vector-store';
import type { ResolvedMember } from '../../types';

const MODEL = 'nomic-embed-text';

/** 활성 문서 메모리 인덱스를 store.ragIndex 에 세팅 (3차원 소형 벡터) */
function seedActiveIndex(): void {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  // 쿼리 [1,0,0] 에 대해 a-chunk0 이 최고 점수가 되도록 구성
  vs.addChunk('활성 문서 핵심 본문 alpha', [1, 0, 0], 0, { pageStart: 2, pageEnd: 2 });
  vs.addChunk('활성 문서 보조 내용', [0.6, 0.8, 0], 1, { pageStart: 5, pageEnd: 5 });
  useAppStore.getState().setRagIndex(vs);
}

/** 비활성 멤버 세션 응답 — VectorStore.serialize 로 실제 index.bin 블롭 생성 */
function memberSessionResponse(fileName: string, dim3 = true) {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  if (dim3) {
    vs.addChunk('비활성 멤버 관련 본문 beta', [0.9, 0.1, 0], 0, { pageStart: 7, pageEnd: 7 });
  } else {
    // 차원 불일치(5d) — 동질성 게이트를 통과시키더라도 search 가 [] 반환하는 2차 방어 검증용
    vs.addChunk('차원 다른 멤버', [1, 0, 0, 0, 0], 0);
  }
  const s = vs.serialize();
  return {
    session: {
      schemaVersion: 1,
      docHash: 'x'.repeat(64),
      fileName,
      filePath: `/d/${fileName}`,
      pageCount: 10,
      extractedText: 'text',
      pageTexts: ['p'],
      chapters: [],
      summaries: {},
      summaryType: 'full',
      qaMessages: [],
      embedModel: s.model,
      embedDim: s.dimension,
      chunkMeta: s.chunkMeta,
    },
    blob: s.buffer,
  };
}

function member(docHash: string, fileName: string, source: 'memory' | 'session'): ResolvedMember {
  return { docHash, fileName, source, status: 'ready' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0]], model: MODEL });
  useAppStore.getState().ragIndex.clear();
});

describe('collectionRagSearch', () => {
  it('ready 멤버 0개면 null (단일 문서 강등은 호출자가 처리)', async () => {
    const out = await collectionRagSearch('질문', [
      { docHash: 'b', fileName: 'B.pdf', source: 'session', status: 'model-mismatch' },
    ], 'a');
    expect(out).toBeNull();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('활성(메모리)+비활성(세션) 혼합 검색 → 두 문서 출처가 컨텍스트에 포함', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(memberSessionResponse('Beta.pdf'));

    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a');

    expect(out).not.toBeNull();
    expect(out).toContain('[Alpha.pdf p.2]'); // 활성 문서 출처 + 페이지
    expect(out).toContain('[Beta.pdf p.7]');  // 비활성 멤버 출처 + 페이지
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('질문 임베딩은 1회만 — 멤버 인덱스 재임베딩 0 (재사용)', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(memberSessionResponse('Beta.pdf'));
    await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a');
    expect(mockEmbed).toHaveBeenCalledTimes(1); // 멤버가 2개여도 질문 임베딩 1회
  });

  it('비활성 멤버 로드 실패 → 해당 멤버 skip, 활성으로 부분 성공', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(null); // 세션 부재
    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a');
    expect(out).toContain('[Alpha.pdf p.2]');
    expect(out).not.toContain('Beta.pdf');
  });

  it('차원 불일치 멤버는 search 가 빈 결과 → 자연 제외(2차 방어)', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(memberSessionResponse('Beta.pdf', false)); // 5차원 인덱스
    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a');
    expect(out).toContain('Alpha.pdf');
    expect(out).not.toContain('Beta.pdf'); // 차원 불일치로 검색 결과 없음
  });

  it('임베딩 실패 시 null', async () => {
    seedActiveIndex();
    mockEmbed.mockResolvedValue({ success: false, error: 'fail' });
    const out = await collectionRagSearch('질문', [member('a', 'Alpha.pdf', 'memory')], 'a');
    expect(out).toBeNull();
  });

  it('활성 멤버는 session.load 를 호출하지 않음 (메모리 인덱스 직접 사용)', async () => {
    seedActiveIndex();
    await collectionRagSearch('질문', [member('a', 'Alpha.pdf', 'memory')], 'a');
    expect(mockSessionLoad).not.toHaveBeenCalled();
  });
});
