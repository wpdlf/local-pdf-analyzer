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
      expect(result[0].score).toBeCloseTo(1.0, 5);
    });

    it('topK 수를 초과하지 않는다', () => {
      const store = new VectorStore();
      for (let i = 0; i < 10; i++) {
        store.addChunk(`chunk${i}`, [1, i * 0.1, 0], i);
      }
      const result = store.search([1, 0, 0], 3, 0);
      expect(result).toHaveLength(3);
    });

    it('minScore 이하 결과는 제외된다', () => {
      const store = new VectorStore();
      store.addChunk('high', [1, 0, 0], 0); // 코사인 1.0
      store.addChunk('low', [0, 1, 0], 1);  // 코사인 0.0
      const result = store.search([1, 0, 0], 5, 0.5);
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('high');
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
      expect(result[0].index).toBe(42);
      expect(result[1].index).toBe(43);
    });

    it('unit-norm 정규화로 벡터 크기에 관계없이 동일한 코사인 유사도', () => {
      const store = new VectorStore();
      store.addChunk('small', [1, 0, 0], 0);
      store.addChunk('large', [100, 0, 0], 1);
      const result = store.search([1, 0, 0], 5, 0);
      expect(result[0].score).toBeCloseTo(1.0, 5);
      expect(result[1].score).toBeCloseTo(1.0, 5);
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
});
