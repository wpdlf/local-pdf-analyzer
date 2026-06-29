/**
 * 인메모리 벡터 스토어 — RAG 기반 Q&A를 위한 코사인 유사도 검색
 *
 * 최적화: 인덱스 추가 시 임베딩을 unit-norm으로 사전 정규화하여
 * 검색 시 비용이 높은 magnitude 재계산을 제거. 코사인 유사도는
 * 정규화된 벡터의 dot product 와 동일. Float32Array 사용으로
 * 메모리 사용량 절반 + 캐시 지역성 개선.
 */

import type { SerializedIndex, PersistedChunkMeta } from '../types';
// 정규화/내적은 src/shared/vector-math 단일 출처 — main 의 session:searchSemantic 과 동일 로직 공유.
import { normalizeToFloat32 as toNormalizedFloat32, dotClamped as dotFloat32 } from '../../shared/vector-math';

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

export class VectorStore {
  private chunks: VectorChunk[] = [];
  private _model: string | null = null;
  private _dimension: number | null = null;
  // 내용 변경 카운터(serialize-skip). addChunk/clear 마다 증가 → 자동저장이 (인스턴스, revision)
  // 으로 "직전 영속화 이후 인덱스가 바뀌었는가"를 판정해, 불변이면 blob 재직렬화/재전송/index.bin
  // 재기록을 생략한다. restore() 는 직접 push 하므로 0 으로 시작(복원 직후 디스크와 동일 = baseline).
  private _revision = 0;

  get size(): number {
    return this.chunks.length;
  }

  get revision(): number {
    return this._revision;
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
    this._revision++;
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
    this._revision++;
  }

  /**
   * 메타만 직렬화 — 정규화 벡터 버퍼(가장 비싼 부분)를 만들지 않는다.
   * serialize-skip 경로에서 index.bin 은 그대로 두되 session.json 에 들어갈 chunkMeta/model/dim
   * 만 필요할 때 사용(버퍼 할당·복사·IPC 전송 생략).
   */
  serializeMeta(): { model: string | null; dimension: number | null; chunkMeta: PersistedChunkMeta[] } {
    const chunkMeta: PersistedChunkMeta[] = this.chunks.map((c) => ({
      text: c.text, index: c.index, pageStart: c.pageStart, pageEnd: c.pageEnd,
    }));
    return { model: this._model, dimension: this._dimension, chunkMeta };
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
