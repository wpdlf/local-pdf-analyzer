import { describe, it, expect } from 'vitest';
import { VectorStore } from '../vector-store';

describe('VectorStore', () => {
  describe('addChunk', () => {
    it('첫 청크에서 차원을 고정한다', () => {
      const store = new VectorStore();
      store.addChunk('a', [1, 0, 0], 0);
      expect(store.dimension).toBe(3);
      expect(store.size).toBe(1);
    });

    it('차원 불일치 시 throw', () => {
      const store = new VectorStore();
      store.addChunk('a', [1, 0, 0], 0);
      expect(() => store.addChunk('b', [1, 0], 1)).toThrow(/차원 불일치/);
    });

    it('영벡터는 허용되지만 검색 결과에 포함되지 않는다', () => {
      const store = new VectorStore();
      store.addChunk('zero', [0, 0, 0], 0);
      const result = store.search([1, 0, 0], 5, 0.3);
      expect(result).toEqual([]);
    });
  });

  describe('search', () => {
    it('빈 스토어는 빈 배열을 반환한다', () => {
      const store = new VectorStore();
      expect(store.search([1, 0, 0])).toEqual([]);
    });

    it('유사도 내림차순으로 정렬되어 반환된다', () => {
      const store = new VectorStore();
      store.addChunk('close', [1, 0, 0], 0);
      store.addChunk('mid', [0.7, 0.7, 0], 1);
      store.addChunk('far', [0, 1, 0], 2);
      const result = store.search([1, 0, 0], 5, 0);
      expect(result.map((r) => r.text)).toEqual(['close', 'mid', 'far']);
      // 첫 번째 결과는 완벽한 매칭 (dot product 1.0)
      expect(result[0]!.score).toBeCloseTo(1.0, 5);
    });

    it('topK 수를 초과하지 않는다', () => {
      const store = new VectorStore();
      for (let i = 0; i < 10; i++) {
        store.addChunk(`chunk${i}`, [1, i * 0.1, 0], i);
      }
      const result = store.search([1, 0, 0], 3, 0);
      expect(result).toHaveLength(3);
    });

    // perf: topK=1 fast-path(정렬 없이 단일 max)가 일반 경로와 동치인지 가드.
    it('topK=1 fast-path 는 최고 점수 단일 결과를 반환(정렬 경로와 동치)', () => {
      const store = new VectorStore();
      store.addChunk('mid', [1, 0.5, 0], 0);
      store.addChunk('best', [1, 0, 0], 1);   // 질의 [1,0,0]와 최고 코사인
      store.addChunk('low', [0, 1, 0], 2);
      const top1 = store.search([1, 0, 0], 1, 0);
      const topK = store.search([1, 0, 0], 5, 0);
      expect(top1).toHaveLength(1);
      expect(top1[0]!.text).toBe('best');
      expect(top1[0]!.score).toBeCloseTo(topK[0]!.score); // 정렬 경로의 1위와 동일 점수
      expect(top1[0]!.index).toBe(topK[0]!.index);
    });

    it('topK=1 fast-path 도 minScore 미만이면 빈 배열', () => {
      const store = new VectorStore();
      store.addChunk('low', [0, 1, 0], 0); // 질의와 직교 → 코사인 0
      expect(store.search([1, 0, 0], 1, 0.5)).toEqual([]);
    });

    it('minScore 이하 결과는 제외된다', () => {
      const store = new VectorStore();
      store.addChunk('high', [1, 0, 0], 0); // 코사인 1.0
      store.addChunk('low', [0, 1, 0], 1);  // 코사인 0.0
      const result = store.search([1, 0, 0], 5, 0.5);
      expect(result).toHaveLength(1);
      expect(result[0]!.text).toBe('high');
    });

    it('쿼리 차원이 인덱스 차원과 불일치하면 빈 배열 반환', () => {
      const store = new VectorStore();
      store.addChunk('a', [1, 0, 0], 0);
      expect(store.search([1, 0])).toEqual([]);
    });

    it('인덱스 저장된 원본 순서가 유지된다', () => {
      const store = new VectorStore();
      store.addChunk('first', [1, 0, 0], 42);
      store.addChunk('second', [0.5, 0.5, 0], 43);
      const result = store.search([1, 0, 0], 5, 0);
      expect(result[0]!.index).toBe(42);
      expect(result[1]!.index).toBe(43);
    });

    it('unit-norm 정규화로 벡터 크기에 관계없이 동일한 코사인 유사도', () => {
      const store = new VectorStore();
      store.addChunk('small', [1, 0, 0], 0);
      store.addChunk('large', [100, 0, 0], 1);
      const result = store.search([1, 0, 0], 5, 0);
      expect(result[0]!.score).toBeCloseTo(1.0, 5);
      expect(result[1]!.score).toBeCloseTo(1.0, 5);
    });

    // v0.18.5 B4 regression — Float32 정규화 round-off 가 dot product 를 1.0 초과로 만들지 않음을 보장.
    it('동일 임베딩(identity) 의 cosine score 는 정확히 [-1, 1] 범위 안에 있다', () => {
      const store = new VectorStore();
      // 큰 차원 + 비정수 값으로 round-off 노이즈 유도
      const dim = 768;
      const vec = Array.from({ length: dim }, (_, i) => Math.sin(i * 0.123) * 0.5 + 0.7);
      store.addChunk('a', vec, 0);
      const result = store.search(vec, 1, 0);
      expect(result).toHaveLength(1);
      expect(result[0]!.score).toBeLessThanOrEqual(1);
      expect(result[0]!.score).toBeGreaterThanOrEqual(-1);
    });

    it('반대 방향 임베딩의 score 도 -1 미만으로 떨어지지 않는다', () => {
      const store = new VectorStore();
      const dim = 256;
      const vec = Array.from({ length: dim }, (_, i) => Math.cos(i * 0.07) + 0.3);
      const opp = vec.map((v) => -v);
      store.addChunk('opp', opp, 0);
      // minScore=-1 로 호출해 음수 결과도 통과시키도록
      const result = store.search(vec, 1, -1);
      expect(result).toHaveLength(1);
      expect(result[0]!.score).toBeGreaterThanOrEqual(-1);
      expect(result[0]!.score).toBeLessThanOrEqual(1);
    });
  });

  describe('clear', () => {
    it('모든 청크와 차원/모델을 초기화한다', () => {
      const store = new VectorStore();
      store.setModel('test-model');
      store.addChunk('a', [1, 0, 0], 0);
      store.clear();
      expect(store.size).toBe(0);
      expect(store.dimension).toBeNull();
      expect(store.model).toBeNull();
    });
  });

  describe('setModel / model', () => {
    it('모델 이름을 저장·조회', () => {
      const store = new VectorStore();
      expect(store.model).toBeNull();
      store.setModel('nomic-embed-text');
      expect(store.model).toBe('nomic-embed-text');
    });
  });

  // page-citation-viewer 기능 — Design Ref §3.1
  describe('page metadata', () => {
    it('addChunk 가 metadata 없이 호출되면 기존 동작 유지 (pageStart/pageEnd undefined)', () => {
      const store = new VectorStore();
      store.addChunk('a', [1, 0, 0], 0);
      const result = store.search([1, 0, 0], 5, 0);
      expect(result[0]!.text).toBe('a');
      expect(result[0]!.pageStart).toBeUndefined();
      expect(result[0]!.pageEnd).toBeUndefined();
    });

    it('addChunk metadata 가 있으면 search 결과에 pageStart/pageEnd 전파', () => {
      const store = new VectorStore();
      store.addChunk('first page', [1, 0, 0], 0, { pageStart: 1, pageEnd: 1 });
      store.addChunk('span pages', [0.9, 0.1, 0], 1, { pageStart: 2, pageEnd: 4 });
      const result = store.search([1, 0, 0], 5, 0);
      expect(result[0]!.pageStart).toBe(1);
      expect(result[0]!.pageEnd).toBe(1);
      expect(result[1]!.pageStart).toBe(2);
      expect(result[1]!.pageEnd).toBe(4);
    });

    it('일부 청크만 metadata 가 있어도 정상 동작 (혼합)', () => {
      const store = new VectorStore();
      store.addChunk('no meta', [1, 0, 0], 0);
      store.addChunk('with meta', [0.8, 0.2, 0], 1, { pageStart: 5, pageEnd: 5 });
      const result = store.search([1, 0, 0], 5, 0);
      expect(result[0]!.pageStart).toBeUndefined();
      expect(result[1]!.pageStart).toBe(5);
    });
  });

  // session-persistence module-1 (L1): serialize/restore 라운드트립 — 재임베딩 없이 인덱스 복원.
  describe('serialize / restore (session-persistence)', () => {
    it('라운드트립: search 결과·page·dimension·model 보존', () => {
      const vs = new VectorStore();
      vs.setModel('nomic-embed-text');
      vs.addChunk('first chunk', [1, 0, 0], 0, { pageStart: 1, pageEnd: 2 });
      vs.addChunk('second chunk', [0, 1, 0], 1, { pageStart: 3, pageEnd: 3 });

      const s = vs.serialize();
      expect(s.dimension).toBe(3);
      expect(s.model).toBe('nomic-embed-text');
      expect(s.chunkMeta).toHaveLength(2);
      expect(s.buffer.byteLength).toBe(2 * 3 * 4); // count × dim × 4

      const restored = VectorStore.restore(s);
      expect(restored.size).toBe(2);
      expect(restored.dimension).toBe(3);
      expect(restored.model).toBe('nomic-embed-text');

      const r = restored.search([1, 0, 0], 5, 0.5);
      expect(r[0]?.text).toBe('first chunk');
      expect(r[0]?.pageStart).toBe(1);
      expect(r[0]?.pageEnd).toBe(2);
      expect(r[0]?.score).toBeCloseTo(1, 5); // 재정규화 없이 벡터 보존
    });

    it('빈 인덱스 라운드트립', () => {
      const vs = new VectorStore();
      const s = vs.serialize();
      expect(s.buffer.byteLength).toBe(0);
      expect(s.dimension).toBeNull();
      const restored = VectorStore.restore(s);
      expect(restored.size).toBe(0);
      expect(restored.search([1, 2, 3])).toEqual([]);
    });

    it('블롭 크기가 chunkMeta×dim 과 불일치하면 restore throw (fail-safe)', () => {
      const vs = new VectorStore();
      vs.addChunk('x', [1, 0, 0], 0);
      const s = vs.serialize();
      const bad = { ...s, buffer: s.buffer.slice(0, 4) }; // 잘린 버퍼
      expect(() => VectorStore.restore(bad)).toThrow(/크기 불일치/);
    });
  });

  // serialize-skip 지원: 자동저장이 "직전 영속화 이후 인덱스가 바뀌었는가"를 판정하는 신호.
  describe('revision (serialize-skip 신호)', () => {
    it('addChunk 마다 증가, clear 도 증가', () => {
      const vs = new VectorStore();
      expect(vs.revision).toBe(0);
      vs.addChunk('a', [1, 0, 0], 0);
      const r1 = vs.revision;
      expect(r1).toBeGreaterThan(0);
      vs.addChunk('b', [0, 1, 0], 1);
      expect(vs.revision).toBeGreaterThan(r1);
      const r2 = vs.revision;
      vs.clear();
      expect(vs.revision).toBeGreaterThan(r2);
    });

    it('restore 로 만든 인덱스는 revision 0 에서 시작 (복원 직후 디스크와 동일 baseline)', () => {
      const src = new VectorStore();
      src.addChunk('a', [1, 0, 0], 0);
      const restored = VectorStore.restore(src.serialize());
      expect(restored.revision).toBe(0);
      expect(restored.size).toBe(1);
    });
  });

  describe('serializeMeta (버퍼 없는 경량 직렬화)', () => {
    it('chunkMeta/model/dim 을 반환하되 벡터 버퍼는 만들지 않는다', () => {
      const vs = new VectorStore();
      vs.setModel('nomic-embed-text');
      vs.addChunk('chunk one', [1, 0, 0], 0, { pageStart: 1, pageEnd: 2 });
      vs.addChunk('chunk two', [0, 1, 0], 1, { pageStart: 3, pageEnd: 3 });

      const meta = vs.serializeMeta();
      expect(meta.model).toBe('nomic-embed-text');
      expect(meta.dimension).toBe(3);
      expect(meta).not.toHaveProperty('buffer'); // 버퍼 미생성
      expect(meta.chunkMeta).toHaveLength(2);
      expect(meta.chunkMeta[0]).toEqual({ text: 'chunk one', index: 0, pageStart: 1, pageEnd: 2 });

      // 전체 serialize 의 chunkMeta 와 동일해야 함(session.json 일관성)
      expect(meta.chunkMeta).toEqual(vs.serialize().chunkMeta);
    });
  });
});
