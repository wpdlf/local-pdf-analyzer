import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionManifestEntry } from '../../shared/session-types';

// 전체 문서 의미 검색의 main 측 코사인 — 렌더러에서 이전된 매칭/제외/skip/정렬/손상방어 검증.
// session-store 를 목으로 디스크 없이 구동. chunkMeta 분리 후: 의미검색은 index.meta.json(사이드카)
// + index.bin 만 읽고 session.json 파싱을 회피한다(메모리 M2). 사이드카 없는 구버전만 readSession fallback.

const store = vi.hoisted(() => ({
  listSessions: vi.fn(),
  readSessionMeta: vi.fn(),
  readIndexMeta: vi.fn(),
  readIndexBlob: vi.fn(),
}));
vi.mock('../session-store', () => ({
  listSessions: store.listSessions,
  readSessionMeta: store.readSessionMeta,
  readIndexMeta: store.readIndexMeta,
  readIndexBlob: store.readIndexBlob,
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
const defaultChunkMeta = [{ text: '관련 청크 내용', index: 0, pageStart: 5 }];
/** 신규(사이드카) 경로 설정 — index.meta.json(chunkMeta) + index.bin(blob). */
function setIndex(over: { chunkMeta?: unknown; vecs?: number[][] } = {}) {
  store.readIndexBlob.mockResolvedValue(blob(over.vecs ?? [[1, 0]]));
  store.readIndexMeta.mockResolvedValue({ chunkMeta: over.chunkMeta ?? defaultChunkMeta });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.listSessions.mockResolvedValue([]);
  store.readSessionMeta.mockResolvedValue(null);
  store.readIndexMeta.mockResolvedValue(null);
  store.readIndexBlob.mockResolvedValue(null);
});

describe('runSemanticSearch (main 코사인)', () => {
  it('모델 일치 문서 → 코사인 결과 + 청크 스니펫(페이지), session.json 미파싱', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    setIndex({ vecs: [[1, 0]] });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.score).toBeGreaterThan(0.9); // [1,0]·[1,0]=1
    expect(out.results[0]!.snippets[0]!.page).toBe(5);
    expect(out.results[0]!.snippets[0]!.text).toContain('관련 청크');
    expect(out.results[0]!.inSummary).toBe(false);
    expect(store.readSessionMeta).not.toHaveBeenCalled(); // 사이드카 경로 — session.json 안 읽음
  });

  it('임베딩 모델/차원 불일치 문서는 제외(excludedCount) — read 조차 안 함', async () => {
    store.listSessions.mockResolvedValue([
      entry({ docHash: 'a'.repeat(64), embedModel: 'other-model' }),
      entry({ docHash: 'b'.repeat(64), embedDim: 3 }),
    ]);
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.excludedCount).toBe(2);
    expect(out.results).toHaveLength(0);
    expect(store.readIndexBlob).not.toHaveBeenCalled(); // 불일치는 로드조차 안 함
  });

  it('인덱스 없는 문서(chunkCount 0 / embedModel null)는 skip(제외 아님)', async () => {
    store.listSessions.mockResolvedValue([entry({ chunkCount: 0, embedModel: null })]);
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.excludedCount).toBe(0);
    expect(out.results).toHaveLength(0);
    expect(store.readIndexBlob).not.toHaveBeenCalled();
  });

  it('유사도 minScore 미만 → 결과 제외', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    setIndex({ vecs: [[0, 1]] }); // 질의 [1,0] 직교 → cos 0 < 0.3
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('손상 블롭(크기 불일치) → 해당 문서 skip, 크래시 없음', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    setIndex({ vecs: [[1]] }); // dim 1 버퍼인데 dim 2 → 크기 불일치
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('손상 블롭(byteLength 비-4배수) → 해당 문서만 skip, 정상 문서는 검색됨(전체 reject 아님)', async () => {
    const odd = new ArrayBuffer(6); // 6바이트 = 비-4배수(트렁케이션 손상)
    store.listSessions.mockResolvedValue([
      entry({ docHash: 'a'.repeat(64) }),
      entry({ docHash: 'b'.repeat(64), fileName: 'ok.pdf' }),
    ]);
    store.readIndexBlob.mockImplementation((_dir: string, hash: string) =>
      Promise.resolve(hash === 'a'.repeat(64) ? odd : blob([[1, 0]])));
    store.readIndexMeta.mockResolvedValue({ chunkMeta: defaultChunkMeta });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(1); // 손상 문서 skip, 정상 문서 b 는 살아남음
    expect(out.results[0]!.fileName).toBe('ok.pdf');
  });

  it('chunkMeta 비배열/손상 → 해당 문서 skip(부분 성공)', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readIndexBlob.mockResolvedValue(blob([[1, 0]]));
    store.readIndexMeta.mockResolvedValue({ chunkMeta: 'corrupt' });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('blob(index.bin) 없는 문서 → skip', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readIndexBlob.mockResolvedValue(null);
    store.readIndexMeta.mockResolvedValue({ chunkMeta: defaultChunkMeta });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('readIndexBlob throw(일시 I/O) → 해당 문서 skip, 크래시 없음', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readIndexBlob.mockRejectedValue(new Error('io'));
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(0);
  });

  it('구버전 세션(사이드카 없음) → session.json 의 chunkMeta 로 fallback(readSessionMeta, index.bin 재독 없음)', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    store.readIndexBlob.mockResolvedValue(blob([[1, 0]])); // index.bin 은 존재(1회 읽음)
    store.readIndexMeta.mockResolvedValue(null);            // index.meta.json 없음(구버전)
    store.readSessionMeta.mockResolvedValue({ session: { chunkMeta: defaultChunkMeta } }); // session.json 만
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(1);                      // fallback 으로 매칭
    expect(store.readSessionMeta).toHaveBeenCalled();
    expect(store.readIndexBlob).toHaveBeenCalledTimes(1);     // index.bin 1회만(이중 읽기 회귀 방지)
  });

  // QA29(A-5): 스니펫 예산 절단(180자)이 `[p.N]` 토큰 한가운데를 자르면 반쪽이 그대로 노출된다.
  // 오늘은 표시 전용이라 Low 지만, QA27(B-MED)/QA28/QA29 가 반복해서 잡아온 것과 같은 모양이다.
  it('스니펫 절단이 인용 토큰을 반으로 남기지 않는다', async () => {
    // 절단 경계(180자) 직전에 `[p.123]` 이 걸치도록 배치한다.
    const head = '가'.repeat(176);
    store.listSessions.mockResolvedValue([entry({})]);
    setIndex({ chunkMeta: [{ text: `${head}[p.123] 뒷부분 본문이 더 있다`, index: 0, pageStart: 5 }] });

    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);

    const text = out.results[0]!.snippets[0]!.text;
    expect(text, '반쪽 토큰이 남으면 잘린 조각이 그대로 보인다').not.toMatch(/\[[^\]]*$/);
    expect(text.endsWith('…')).toBe(true);
  });

  it('절단 경계에 인용이 없으면 종전대로 자른다 (과잉 삭제 금지)', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    setIndex({ chunkMeta: [{ text: '나'.repeat(300), index: 0, pageStart: 5 }] });

    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);

    const text = out.results[0]!.snippets[0]!.text;
    expect(text).toBe('나'.repeat(180) + '…');
  });

  it('상한 이하 텍스트는 말줄임 없이 그대로', async () => {
    store.listSessions.mockResolvedValue([entry({})]);
    setIndex({ chunkMeta: [{ text: '짧은 청크 [p.3]', index: 0, pageStart: 3 }] });

    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);

    expect(out.results[0]!.snippets[0]!.text).toBe('짧은 청크 [p.3]');
  });

  // QA29(C-4): 무캡 Promise.all 이 main 을 초 단위로 잡던 것을 캡 + 양보로 교체.
  it('후보 세션 읽기가 동시 4건을 넘지 않는다 (main 무캡 팬아웃 금지)', async () => {
    const hashes = Array.from({ length: 12 }, (_, i) => String(i).padStart(64, '0'));
    store.listSessions.mockResolvedValue(hashes.map((h) => entry({ docHash: h })));
    store.readIndexMeta.mockResolvedValue({ chunkMeta: defaultChunkMeta });
    let inFlight = 0;
    let peak = 0;
    store.readIndexBlob.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return blob([[1, 0]]);
    });

    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);

    expect(out.results).toHaveLength(12); // 캡을 둬도 결과는 전부 나온다
    expect(peak, '캡이 없으면 12건이 한 번에 들어와 main 이 그만큼 잡힌다').toBeLessThanOrEqual(4);
  });

  it('점수 내림차순 정렬', async () => {
    store.listSessions.mockResolvedValue([entry({ docHash: 'a'.repeat(64) }), entry({ docHash: 'b'.repeat(64) })]);
    store.readIndexBlob.mockImplementation((_dir: string, hash: string) =>
      Promise.resolve(hash === 'a'.repeat(64) ? blob([[0.6, 0.8]]) : blob([[1, 0]])));
    store.readIndexMeta.mockResolvedValue({ chunkMeta: defaultChunkMeta });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results.map((r) => r.docHash)).toEqual(['b'.repeat(64), 'a'.repeat(64)]);
  });
});
