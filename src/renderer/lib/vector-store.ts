/**
 * 인메모리 벡터 스토어 — RAG 기반 Q&A를 위한 코사인 유사도 검색
 *
 * 최적화: 인덱스 추가 시 임베딩을 unit-norm으로 사전 정규화하여
 * 검색 시 비용이 높은 magnitude 재계산을 제거. 코사인 유사도는
 * 정규화된 벡터의 dot product 와 동일. Float32Array 사용으로
 * 메모리 사용량 절반 + 캐시 지역성 개선.
 */

export interface VectorChunk {
  text: string;
  embedding: Float32Array; // unit-normalized
  index: number; // 원본 청크 순서
}

export interface SearchResult {
  text: string;
  score: number;
  index: number;
}

/** 벡터를 unit-length로 정규화한 Float32Array 반환. 영벡터는 0으로 채움 */
function toNormalizedFloat32(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const mag = Math.sqrt(sumSq);
  if (!Number.isFinite(mag) || mag === 0) {
    return out; // 영벡터/무효 값 → dot product가 항상 0이 되어 minScore로 필터됨
  }
  const inv = 1 / mag;
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

/** 두 unit 벡터의 dot product = 코사인 유사도 */
function dotFloat32(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = a.length;
  for (let i = 0; i < len; i++) sum += a[i] * b[i];
  return sum;
}

export class VectorStore {
  private chunks: VectorChunk[] = [];
  private _model: string | null = null;
  private _dimension: number | null = null;

  get size(): number {
    return this.chunks.length;
  }

  get model(): string | null {
    return this._model;
  }

  get dimension(): number | null {
    return this._dimension;
  }

  setModel(model: string): void {
    this._model = model;
  }

  addChunk(text: string, embedding: number[], index: number): void {
    // 첫 번째 청크에서 차원 고정, 이후 불일치 시 거부
    if (this._dimension === null) {
      this._dimension = embedding.length;
    } else if (embedding.length !== this._dimension) {
      throw new Error(`임베딩 차원 불일치: expected ${this._dimension}, got ${embedding.length}`);
    }
    this.chunks.push({ text, embedding: toNormalizedFloat32(embedding), index });
  }

  /**
   * 쿼리 임베딩과 가장 유사한 청크 topK개 반환.
   * minScore 미만인 결과는 제외. 차원 불일치 시 빈 배열 반환.
   */
  search(queryEmbedding: number[], topK: number = 5, minScore: number = 0.3): SearchResult[] {
    if (this.chunks.length === 0) return [];
    // 쿼리 차원이 인덱스 차원과 불일치 시 검색 불가
    if (this._dimension !== null && queryEmbedding.length !== this._dimension) return [];

    const queryNorm = toNormalizedFloat32(queryEmbedding);

    // 부분 top-K heap 대신 단순 sort — 일반적인 문서(수백~수천 청크)에서
    // sort O(n log n) + slice 가 충분히 빠르고 코드가 단순함.
    const scored: SearchResult[] = [];
    for (const chunk of this.chunks) {
      const score = dotFloat32(queryNorm, chunk.embedding);
      if (score >= minScore && Number.isFinite(score)) {
        scored.push({ text: chunk.text, score, index: chunk.index });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  clear(): void {
    this.chunks = [];
    this._model = null;
    this._dimension = null;
  }
}
