/**
 * 인메모리 벡터 스토어 — RAG 기반 Q&A를 위한 코사인 유사도 검색
 *
 * 최적화: 인덱스 추가 시 임베딩을 unit-norm으로 사전 정규화하여
 * 검색 시 비용이 높은 magnitude 재계산을 제거. 코사인 유사도는
 * 정규화된 벡터의 dot product 와 동일. Float32Array 사용으로
 * 메모리 사용량 절반 + 캐시 지역성 개선.
 */

import type { SerializedIndex, PersistedChunkMeta } from '../types';

export interface VectorChunk {
  text: string;
  embedding: Float32Array; // unit-normalized
  index: number; // 원본 청크 순서
  // Design Ref: §3.1 — page-citation-viewer 기능. 옵셔널 필드로 기존 호출자 호환.
  /** 1-based 청크 시작 페이지 (있으면 인용 기능 활성화) */
  pageStart?: number;
  /** 1-based 청크 끝 페이지 */
  pageEnd?: number;
}

export interface SearchResult {
  text: string;
  score: number;
  index: number;
  // Design Ref: §3.1 — SearchResult 에도 page 전파하여 RAG 컨텍스트 빌더가 사용
  pageStart?: number;
  pageEnd?: number;
}

/**
 * addChunk 의 옵셔널 메타데이터.
 * page-citation-viewer 기능에서만 사용되며, 기존 호출자(`addChunk(text, emb, idx)`)는 무변경.
 */
export interface ChunkMetadata {
  pageStart?: number;
  pageEnd?: number;
}

/** 벡터를 unit-length로 정규화한 Float32Array 반환. 영벡터는 0으로 채움 */
function toNormalizedFloat32(v: number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sumSq = 0;
  // noUncheckedIndexedAccess: 루프 내 인덱스가 length 내부임이 보장되어 non-null 단언.
  for (let i = 0; i < v.length; i++) sumSq += v[i]! * v[i]!;
  const mag = Math.sqrt(sumSq);
  if (!Number.isFinite(mag) || mag === 0) {
    return out; // 영벡터/무효 값 → dot product가 항상 0이 되어 minScore로 필터됨
  }
  const inv = 1 / mag;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

/**
 * 두 unit 벡터의 dot product = 코사인 유사도.
 *
 * v0.18.5 B4 fix: Float32 정규화는 round-off 로 magnitude 가 정확히 1.0 이 아니라
 * 1.0000001 처럼 미세하게 빗나가, 동일 벡터끼리의 dot product 가 1.0 을 초과할 수 있다.
 * 이 경우 호출자가 `minScore = 1.0` 으로 "완전 일치만" 필터링하려 하면 round-off 노이즈가
 * 통과하고, search 결과 정렬 비교에서도 값 비교가 미묘하게 어긋난다.
 * 수학적으로 코사인 유사도는 [-1, 1] 범위가 보장되어야 하므로 명시적 clamp.
 */
function dotFloat32(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  const len = a.length;
  // noUncheckedIndexedAccess: 호출 측에서 동일 차원 보장. 핫패스라 non-null 단언으로 좁힘 비용 0.
  for (let i = 0; i < len; i++) sum += a[i]! * b[i]!;
  if (sum > 1) return 1;
  if (sum < -1) return -1;
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

  addChunk(text: string, embedding: number[], index: number, metadata?: ChunkMetadata): void {
    // 첫 번째 청크에서 차원 고정, 이후 불일치 시 거부
    if (this._dimension === null) {
      this._dimension = embedding.length;
    } else if (embedding.length !== this._dimension) {
      throw new Error(`임베딩 차원 불일치: expected ${this._dimension}, got ${embedding.length}`);
    }
    this.chunks.push({
      text,
      embedding: toNormalizedFloat32(embedding),
      index,
      pageStart: metadata?.pageStart,
      pageEnd: metadata?.pageEnd,
    });
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
        scored.push({
          text: chunk.text,
          score,
          index: chunk.index,
          pageStart: chunk.pageStart,
          pageEnd: chunk.pageEnd,
        });
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

  /**
   * 인덱스를 직렬화 — 메타(text/index/page)는 JSON, 정규화 벡터는 Float32 버퍼로 분리.
   * Design Ref: §3.2 — 세션 영속화 시 session.json(메타) + index.bin(버퍼) 으로 저장.
   * embedding 은 addChunk 에서 이미 unit-normalized 됐으므로 그대로 export(재정규화 불필요).
   */
  serialize(): SerializedIndex {
    const dim = this._dimension ?? 0;
    const count = this.chunks.length;
    const buffer = new ArrayBuffer(count * dim * 4);
    const floats = new Float32Array(buffer);
    const chunkMeta: PersistedChunkMeta[] = [];
    for (let i = 0; i < count; i++) {
      const c = this.chunks[i]!;
      floats.set(c.embedding, i * dim);
      chunkMeta.push({ text: c.text, index: c.index, pageStart: c.pageStart, pageEnd: c.pageEnd });
    }
    return { model: this._model, dimension: this._dimension, chunkMeta, buffer };
  }

  /**
   * 직렬화된 인덱스를 복원 — 재임베딩 없이 VectorStore 재구성.
   * Plan SC: 재오픈 시 재임베딩 0. 블롭 크기가 (chunkCount × dim × 4) 와 불일치하면 throw 하여
   * 호출자(store)가 인덱스를 무시하고 재임베딩하도록 한다(fail-safe, Design §6).
   * 벡터는 이미 정규화돼 있으므로 addChunk 의 재정규화 경로를 우회해 직접 push.
   */
  static restore(s: SerializedIndex): VectorStore {
    const store = new VectorStore();
    store._model = s.model;
    store._dimension = s.dimension;
    const dim = s.dimension ?? 0;
    const floats = new Float32Array(s.buffer);
    if (dim > 0 && floats.length !== s.chunkMeta.length * dim) {
      throw new Error(
        `인덱스 블롭 크기 불일치: expected ${s.chunkMeta.length * dim}, got ${floats.length}`,
      );
    }
    for (let i = 0; i < s.chunkMeta.length; i++) {
      const m = s.chunkMeta[i]!;
      // slice 로 독립 복사본 확보(원본 버퍼와 분리). 이미 unit-normalized 라 재정규화 금지.
      const embedding = dim > 0 ? floats.slice(i * dim, i * dim + dim) : new Float32Array(0);
      store.chunks.push({
        text: m.text,
        embedding,
        index: m.index,
        pageStart: m.pageStart,
        pageEnd: m.pageEnd,
      });
    }
    return store;
  }
}
