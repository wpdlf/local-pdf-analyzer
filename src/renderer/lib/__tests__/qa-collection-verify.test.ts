import { describe, it, expect, vi, beforeEach } from 'vitest';

// multi-doc Phase 2 module-2 — 컬렉션 답변 검증(RagVerifier) 단위 테스트.
// verifyAnswerSentences 가 verifier 주입 시 멤버 인덱스 전역 최대 점수로 검증함을 가드.

const mockEmbed = vi.fn();
vi.stubGlobal('window', {
  electronAPI: { ai: { embed: mockEmbed, abort: vi.fn(() => Promise.resolve()) } },
});
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { verifyAnswerSentences, storeVerifier, collectionVerifier } from '../use-qa';
import { VectorStore } from '../vector-store';

function store(vec: number[], model = 'm'): VectorStore {
  const vs = new VectorStore();
  vs.setModel(model);
  vs.addChunk('근거 본문', vec, 0);
  return vs;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('storeVerifier / collectionVerifier', () => {
  it('storeVerifier: 단일 인덱스 top-1 점수', () => {
    const v = storeVerifier(store([1, 0, 0]));
    expect(v.size).toBe(1);
    expect(v.dimension).toBe(3);
    expect(v.maxScore([1, 0, 0])).toBeCloseTo(1, 5);
    expect(v.maxScore([0, 1, 0])).toBeCloseTo(0, 5);
  });

  it('collectionVerifier: 여러 멤버 중 전역 최대 점수', () => {
    const v = collectionVerifier([store([1, 0, 0]), store([0, 1, 0])]);
    expect(v.size).toBe(2);
    expect(v.dimension).toBe(3);
    // [0,1,0] 은 두 번째 멤버와 완전 일치 → 전역 최대 1
    expect(v.maxScore([0, 1, 0])).toBeCloseTo(1, 5);
  });

  it('collectionVerifier: 빈 배열은 size 0', () => {
    expect(collectionVerifier([]).size).toBe(0);
  });
});

describe('verifyAnswerSentences (verifier 주입)', () => {
  it('컬렉션 verifier 로 검증 — 멤버 인덱스에 근거가 있으면 refine 불필요', async () => {
    // 두 문장 모두 멤버 인덱스와 정합(점수 높음) → weak 0 → needsRefine false
    mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0], [0, 1, 0]] });
    const verifier = collectionVerifier([store([1, 0, 0]), store([0, 1, 0])]);
    const out = await verifyAnswerSentences(
      '첫 번째 문장은 충분히 깁니다 근거 있음. 두 번째 문장도 충분히 깁니다 근거 있음.',
      undefined,
      verifier,
    );
    expect(out.totalSentences).toBe(2);
    expect(out.weakCount).toBe(0);
    expect(out.needsRefine).toBe(false);
  });

  it('verifier.size 0 이면 검증 skip (needsRefine false)', async () => {
    const out = await verifyAnswerSentences('아무 문장이나 충분히 길게 작성합니다.', undefined, collectionVerifier([]));
    expect(out.needsRefine).toBe(false);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('차원 불일치(verify 임베딩 ≠ 멤버 인덱스 차원)면 fail-safe (refine 안 함)', async () => {
    mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0, 0, 0]] }); // 5차원
    const verifier = collectionVerifier([store([1, 0, 0])]); // 3차원
    const out = await verifyAnswerSentences('충분히 긴 단일 검증 문장입니다 여기.', undefined, verifier);
    expect(out.needsRefine).toBe(false);
  });
});
