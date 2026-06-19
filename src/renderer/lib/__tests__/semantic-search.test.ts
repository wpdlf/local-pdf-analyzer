import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionManifestEntry } from '../../../shared/session-types';

// 의미 검색 코어 — window.electronAPI(checkEmbedModel/embed/session) 목 + 실제 VectorStore 복원.
// 모델 일치 검색 / 모델 불일치 제외 / 인덱스 없음 skip / no-embed-model·embed-failed 분기 / 손상 방어.

const API = vi.hoisted(() => ({
  checkEmbedModel: vi.fn(),
  embed: vi.fn(),
  list: vi.fn(),
  load: vi.fn(),
}));
vi.stubGlobal('window', {
  electronAPI: {
    ai: { checkEmbedModel: API.checkEmbedModel, embed: API.embed },
    session: { list: API.list, load: API.load },
  },
});

import { searchSessionsSemantic } from '../semantic-search';

/** 정규화 벡터들을 Float32 index.bin 버퍼로. */
function blob(vecs: number[][]): ArrayBuffer {
  const dim = vecs[0]!.length;
  const buf = new ArrayBuffer(vecs.length * dim * 4);
  const f = new Float32Array(buf);
  vecs.forEach((v, i) => f.set(v, i * dim));
  return buf;
}
function entry(over: Partial<SessionManifestEntry>): SessionManifestEntry {
  return {
    docHash: 'a'.repeat(64), fileName: 'f.pdf', filePath: '/f.pdf', pageCount: 3,
    embedModel: 'nomic', embedDim: 2, chunkCount: 1, byteSize: 0, createdAt: '', lastAccessed: '', ...over,
  };
}
function loadResult(over: { chunkMeta?: unknown[]; vecs?: number[][]; embedModel?: string; embedDim?: number } = {}) {
  return {
    session: { embedModel: over.embedModel ?? 'nomic', embedDim: over.embedDim ?? 2, chunkMeta: over.chunkMeta ?? [{ text: '관련 청크 내용', index: 0, pageStart: 5 }] },
    blob: blob(over.vecs ?? [[1, 0]]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  API.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic' });
  API.embed.mockResolvedValue({ success: true, embeddings: [[1, 0]], model: 'nomic' });
  API.list.mockResolvedValue([]);
  API.load.mockResolvedValue(null);
});

describe('searchSessionsSemantic', () => {
  it('2자 미만 → 빈 결과(임베딩 호출 없음)', async () => {
    const out = await searchSessionsSemantic('a');
    expect(out.results).toEqual([]);
    expect(API.embed).not.toHaveBeenCalled();
  });

  it('임베딩 모델 없음 → no-embed-model', async () => {
    API.checkEmbedModel.mockResolvedValue({ available: false });
    const out = await searchSessionsSemantic('질의어');
    expect(out.status).toBe('no-embed-model');
  });

  it('질의 임베딩 실패 → embed-failed', async () => {
    API.embed.mockResolvedValue({ success: false });
    const out = await searchSessionsSemantic('질의어');
    expect(out.status).toBe('embed-failed');
  });

  it('모델 일치 문서 → 코사인 검색 결과 + 청크 스니펫(페이지)', async () => {
    API.list.mockResolvedValue([entry({})]);
    API.load.mockResolvedValue(loadResult({ vecs: [[1, 0]] }));
    const out = await searchSessionsSemantic('질의어');
    expect(out.status).toBe('ok');
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.score).toBeGreaterThan(0.9); // [1,0]·[1,0]=1
    expect(out.results[0]!.snippets[0]!.page).toBe(5);
    expect(out.results[0]!.snippets[0]!.text).toContain('관련 청크');
    expect(out.results[0]!.inSummary).toBe(false);
  });

  it('임베딩 모델/차원 불일치 문서는 제외(excludedCount) — 결과에 없음', async () => {
    API.list.mockResolvedValue([
      entry({ docHash: 'a'.repeat(64), embedModel: 'other-model' }),
      entry({ docHash: 'b'.repeat(64), embedDim: 3 }),
    ]);
    const out = await searchSessionsSemantic('질의어');
    expect(out.excludedCount).toBe(2);
    expect(out.results).toHaveLength(0);
    expect(API.load).not.toHaveBeenCalled(); // 불일치는 로드조차 안 함
  });

  it('embed 반환 model 태그가 달라도 check.model 기준 비교 — 정상 문서 오제외 방지(E2E 회귀)', async () => {
    // 인덱스 embedModel 은 빌드 시 checkEmbedModel.model 로 기록됨. embed IPC 가 :latest 태그를
    // 붙여 반환해도 그걸로 비교하면 안 됨(전부 제외되던 버그).
    API.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    API.embed.mockResolvedValue({ success: true, embeddings: [[1, 0]], model: 'nomic-embed-text:latest' });
    API.list.mockResolvedValue([entry({ embedModel: 'nomic-embed-text' })]);
    API.load.mockResolvedValue(loadResult({ embedModel: 'nomic-embed-text' }));
    const out = await searchSessionsSemantic('질의어');
    expect(out.excludedCount).toBe(0);
    expect(out.results).toHaveLength(1);
  });

  it('인덱스 없는 문서(chunkCount 0)는 skip(제외 아님)', async () => {
    API.list.mockResolvedValue([entry({ chunkCount: 0, embedModel: null })]);
    const out = await searchSessionsSemantic('질의어');
    expect(out.excludedCount).toBe(0);
    expect(out.results).toHaveLength(0);
  });

  it('유사도 minScore 미만 → 결과 제외', async () => {
    API.list.mockResolvedValue([entry({})]);
    API.load.mockResolvedValue(loadResult({ vecs: [[0, 1]] })); // 질의 [1,0] 과 직교 → cos 0 < 0.3
    const out = await searchSessionsSemantic('질의어');
    expect(out.results).toHaveLength(0);
  });

  it('손상 블롭(크기 불일치) → 해당 문서 skip, 크래시 없음', async () => {
    API.list.mockResolvedValue([entry({})]);
    API.load.mockResolvedValue(loadResult({ vecs: [[1]] })); // dim 1 버퍼인데 embedDim 2 → restore throw
    const out = await searchSessionsSemantic('질의어');
    expect(out.status).toBe('ok');
    expect(out.results).toHaveLength(0);
  });

  it('점수 내림차순 정렬', async () => {
    API.list.mockResolvedValue([entry({ docHash: 'a'.repeat(64) }), entry({ docHash: 'b'.repeat(64) })]);
    API.load
      .mockResolvedValueOnce(loadResult({ vecs: [[0.6, 0.8]] }))  // cos 0.6
      .mockResolvedValueOnce(loadResult({ vecs: [[1, 0]] }));     // cos 1.0
    const out = await searchSessionsSemantic('질의어');
    expect(out.results.map((r) => r.docHash)).toEqual(['b'.repeat(64), 'a'.repeat(64)]);
  });
});
