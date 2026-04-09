/**
 * 인메모리 벡터 스토어 — RAG 기반 Q&A를 위한 코사인 유사도 검색
 */

export interface VectorChunk {
  text: string;
  embedding: number[];
  index: number; // 원본 청크 순서
}

export interface SearchResult {
  text: string;
  score: number;
  index: number;
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0; // 차원 불일치 시 유사도 0
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  const sim = dotProduct(a, b) / (magA * magB);
  // NaN 방어 (Infinity/NaN 전파 차단)
  return Number.isFinite(sim) ? sim : 0;
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
    this.chunks.push({ text, embedding, index });
  }

  /**
   * 쿼리 임베딩과 가장 유사한 청크 topK개 반환.
   * minScore 미만인 결과는 제외. 차원 불일치 시 빈 배열 반환.
   */
  search(queryEmbedding: number[], topK: number = 5, minScore: number = 0.3): SearchResult[] {
    if (this.chunks.length === 0) return [];
    // 쿼리 차원이 인덱스 차원과 불일치 시 검색 불가
    if (this._dimension !== null && queryEmbedding.length !== this._dimension) return [];

    const scored = this.chunks.map((chunk) => ({
      text: chunk.text,
      score: cosineSimilarity(queryEmbedding, chunk.embedding),
      index: chunk.index,
    }));

    return scored
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  clear(): void {
    this.chunks = [];
    this._model = null;
    this._dimension = null;
  }
}
