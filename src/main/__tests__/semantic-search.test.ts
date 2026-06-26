import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionManifestEntry } from '../../shared/session-types';

// 전체 문서 의미 검색의 main 측 코사인 — 렌더러에서 이전된 매칭/제외/skip/정렬/손상방어 검증.
// session-store(listSessions/readSession)를 목으로 디스크 없이 구동.

const store = vi.hoisted(() => ({ listSessions: vi.fn(), readSession: vi.fn() }));
vi.mock('../session-store', () => ({
  listSessions: store.listSessions,
  readSession: store.readSession,
}));

import { runSemanticSearch } from '../semantic-search';

const DIR = '/sessions';

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
function loaded(over: { chunkMeta?: unknown; vecs?: number[][] } = {}) {
  return {
    session: { chunkMeta: over.chunkMeta ?? [{ text: '관련 청크 내용', index: 0, pageStart: 5 }] },
    blob: blob(over.vecs ?? [[1, 0]]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.listSessions.mockResolvedValue([]);
  store.readSession.mockResolvedValue(null);
});

describe('runSemanticSearch (main 코사인)', () => {
  it('모델 일치 문서 → 코사인 결과 + 청크 스니펫(페이지)', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readSession.mockResolvedValue(loaded({ vecs: [[1, 0]] }));
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.score).toBeGreaterThan(0.9); // [1,0]·[1,0]=1
    expect(out.results[0]!.snippets[0]!.page).toBe(5);
    expect(out.results[0]!.snippets[0]!.text).toContain('관련 청크');
    expect(out.results[0]!.inSummary).toBe(false);
  });

  it('임베딩 모델/차원 불일치 문서는 제외(excludedCount) — read 조차 안 함', async () => {
    store.listSessions.mockResolvedValue([
      entry({ docHash: 'a'.repeat(64), embedModel: 'other-model' }),
      entry({ docHash: 'b'.repeat(64), embedDim: 3 }),
    ]);
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.excludedCount).toBe(2);
    expect(out.results).toHaveLength(0);
    expect(store.readSession).not.toHaveBeenCalled(); // 불일치는 로드조차 안 함
  });

  it('인덱스 없는 문서(chunkCount 0 / embedModel null)는 skip(제외 아님)', async () => {
    store.listSessions.mockResolvedValue([entry({ chunkCount: 0, embedModel: null })]);
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.excludedCount).toBe(0);
    expect(out.results).toHaveLength(0);
    expect(store.readSession).not.toHaveBeenCalled();
  });

  it('유사도 minScore 미만 → 결과 제외', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readSession.mockResolvedValue(loaded({ vecs: [[0, 1]] })); // 질의 [1,0] 직교 → cos 0 < 0.3
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('손상 블롭(크기 불일치) → 해당 문서 skip, 크래시 없음', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readSession.mockResolvedValue(loaded({ vecs: [[1]] })); // dim 1 버퍼인데 dim 2 → 크기 불일치
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('손상 블롭(byteLength 비-4배수) → 해당 문서만 skip, 정상 문서는 검색됨(전체 reject 아님)', async () => {
    // 회귀: new Float32Array(blob) 는 byteLength%4!==0 이면 RangeError 를 던진다.
    // 가드가 없으면 손상 문서 하나가 Promise.all 전체를 reject 시켜 정상 문서 매칭까지 사라진다.
    const odd = new ArrayBuffer(6); // 6바이트 = 비-4배수(트렁케이션 손상)
    store.listSessions.mockResolvedValue([
      entry({ docHash: 'a'.repeat(64) }),
      entry({ docHash: 'b'.repeat(64), fileName: 'ok.pdf' }),
    ]);
    store.readSession.mockImplementation((_dir: string, hash: string) =>
      Promise.resolve(
        hash === 'a'.repeat(64)
          ? { session: { chunkMeta: [{ text: '손상', index: 0 }] }, blob: odd }
          : loaded({ vecs: [[1, 0]] }),
      ),
    );
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(1); // 손상 문서 skip, 정상 문서 b 는 살아남음
    expect(out.results[0]!.fileName).toBe('ok.pdf');
  });

  it('chunkMeta 비배열/손상 → 해당 문서 skip(부분 성공)', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readSession.mockResolvedValue({ session: { chunkMeta: 'corrupt' }, blob: blob([[1, 0]]) });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('blob 없는 문서 → skip', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readSession.mockResolvedValue({ session: { chunkMeta: [{ text: 't', index: 0 }] }, blob: null });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('readSession throw → 해당 문서 skip, 크래시 없음', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readSession.mockRejectedValue(new Error('io'));
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('점수 내림차순 정렬', async () => {
    store.listSessions.mockResolvedValue([entry({ docHash: 'a'.repeat(64) }), entry({ docHash: 'b'.repeat(64) })]);
    store.readSession
      .mockResolvedValueOnce(loaded({ vecs: [[0.6, 0.8]] }))  // cos 0.6
      .mockResolvedValueOnce(loaded({ vecs: [[1, 0]] }));     // cos 1.0
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results.map((r) => r.docHash)).toEqual(['b'.repeat(64), 'a'.repeat(64)]);
  });
});
