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
import { RAG_MIN_SCORE } from '../../shared/constants';

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
    // QA30(D6): 상한만 두면 **완전 직렬화**(캡 1)도 통과한다 — 실측으로 SESSION_FANOUT_LIMIT 을
    // 1 로 낮춰도 23/23 이 초록이었다. 형제 async-pool.test 처럼 양방향으로 못박는다.
    expect(peak, '캡이 1 로 쪼그라들면 검색이 통째로 직렬화된다 — 그것도 회귀다').toBeGreaterThan(1);
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

/**
 * QA30(C-1b): **인덱스를 주장하는데 실제로는 못 쓰는 문서**가 종전에는 아무 데도 집계되지 않고
 * 사라졌다(excludedCount 는 모델/차원 불일치만 센다). 사용자는 "그 문서엔 관련 내용이 없다" 로
 * 읽는다. 여기서는 손상 4종 + 일시 I/O 오류를 **문서별로** 주입해 corruptedCount 를 실측한다.
 *
 * 기존 테스트가 이 결함을 못 잡은 이유: 손상 케이스마다 `results` 가 비었다는 것만 확인하고
 * **"그래서 몇 개가 빠졌는가" 를 아무도 묻지 않았다** — 정상 인덱스의 "관련 없음" 과 구분되지
 * 않는 상태였다.
 */
describe('QA30(C-1b): 손상·부재 인덱스는 무음이 아니라 corruptedCount 로 집계된다', () => {
  const H = {
    ok: 'a'.repeat(64),        // 정상 + 매칭
    noHit: 'b'.repeat(64),     // 정상 + 이 질의와 무관 (손상 아님)
    noBlob: 'c'.repeat(64),    // index.bin 부재 (manifest 는 주장)
    short: 'd'.repeat(64),     // index.bin 이 chunkMeta × dim 보다 짧음
    unaligned: 'e'.repeat(64), // byteLength 가 4의 배수가 아님
    badMeta: 'f'.repeat(64),   // chunkMeta 손상
    ioError: '0'.repeat(64),   // 읽는 중 EBUSY
    mismatch: '1'.repeat(64),  // 모델 불일치 — 기존 excludedCount 쪽
  };

  /** docHash 별로 다른 인덱스 상태를 돌려주는 디스패처. */
  function wire() {
    store.listSessions.mockResolvedValue([
      entry({ docHash: H.ok }),
      entry({ docHash: H.noHit }),
      entry({ docHash: H.noBlob }),
      entry({ docHash: H.short }),
      entry({ docHash: H.unaligned }),
      entry({ docHash: H.badMeta }),
      entry({ docHash: H.ioError }),
      entry({ docHash: H.mismatch, embedModel: 'other-model' }),
    ]);
    store.readIndexBlob.mockImplementation(async (_dir: string, h: string) => {
      if (h === H.noBlob) return null;                       // 부재
      if (h === H.ioError) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      if (h === H.short) return new ArrayBuffer(4);           // 1 float < 1청크 × dim 2
      if (h === H.unaligned) return new ArrayBuffer(6);       // 비-4배수
      if (h === H.noHit) return blob([[0, 1]]);               // 질의 [1,0] 과 직교
      return blob([[1, 0]]);
    });
    store.readIndexMeta.mockImplementation(async (_dir: string, h: string) => {
      if (h === H.badMeta) return { chunkMeta: [{ text: 42 }] }; // text 가 문자열이 아님
      return { chunkMeta: defaultChunkMeta };
    });
  }

  it('손상 4종 + I/O 오류가 corruptedCount 에 잡히고, 정상 "관련 없음" 은 잡히지 않는다', async () => {
    wire();
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    // 결과는 정상 매칭 1건뿐 — 종전과 동일(회귀 아님)
    expect(out.results.map((r) => r.docHash)).toEqual([H.ok]);
    // 모델 불일치는 종전대로 excludedCount
    expect(out.excludedCount).toBe(1);
    // 부재·짧음·비정렬·chunkMeta 손상·EBUSY = 5건
    expect(out.corruptedCount).toBe(5);
  });

  it('전부 정상이면 corruptedCount 는 0 — "관련 없음" 을 손상으로 부풀리지 않는다', async () => {
    store.listSessions.mockResolvedValue([entry({ docHash: H.ok }), entry({ docHash: H.noHit })]);
    store.readIndexBlob.mockImplementation(async (_dir: string, h: string) =>
      (h === H.noHit ? blob([[0, 1]]) : blob([[1, 0]])));
    store.readIndexMeta.mockResolvedValue({ chunkMeta: defaultChunkMeta });
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results).toHaveLength(1);
    expect(out.corruptedCount).toBe(0);
  });

  it('인덱스를 주장하지 않는 문서(chunkCount 0)는 손상이 아니다 — 로드조차 하지 않는다', async () => {
    store.listSessions.mockResolvedValue([entry({ docHash: H.ok, chunkCount: 0, embedModel: null })]);
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.corruptedCount).toBe(0);
    expect(out.excludedCount).toBe(0);
    expect(store.readIndexBlob).not.toHaveBeenCalled();
  });
});

/**
 * QA30(B-7): 최소 유사도 임계는 `shared/constants.ts` 의 RAG_MIN_SCORE 단일 출처를 쓴다.
 * 종전엔 여기와 renderer/use-qa.ts 에 리터럴 0.3 이 각각 있었고 둘을 잇는 것은 주석뿐이었다.
 */
describe('QA30(B-7): 의미검색 임계값은 shared 상수를 따른다', () => {
  /** 질의 [1,0] 과의 코사인이 정확히 s 가 되는 단위벡터. */
  const vecFor = (s: number) => [s, Math.sqrt(Math.max(0, 1 - s * s))];

  it('임계 바로 위는 포함, 바로 아래는 제외 (상수를 바꾸면 이 단언이 함께 움직인다)', async () => {
    store.listSessions.mockResolvedValue([
      entry({ docHash: 'a'.repeat(64) }),
      entry({ docHash: 'b'.repeat(64) }),
    ]);
    store.readIndexMeta.mockResolvedValue({ chunkMeta: defaultChunkMeta });
    store.readIndexBlob.mockImplementation(async (_dir: string, h: string) =>
      blob([vecFor(h.startsWith('a') ? RAG_MIN_SCORE + 0.02 : RAG_MIN_SCORE - 0.02)]));
    const out = await runSemanticSearch(DIR, [1, 0], 'nomic', 2);
    expect(out.results.map((r) => r.docHash)).toEqual(['a'.repeat(64)]);
    // 임계 미만은 "관련 없음" 이지 손상이 아니다.
    expect(out.corruptedCount).toBe(0);
  });

  it('소스에 임계 리터럴이 남아 있지 않다 (주석 제거 후 스캔)', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = await fs.readFile(path.join(here, '..', 'semantic-search.ts'), 'utf-8');
    // QA29(D축)의 교훈: 소스 스캔 가드는 **주석에 매칭돼 통과**할 수 있다. 코드만 남기고 본다.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).toContain('RAG_MIN_SCORE');
    expect(code, '임계 리터럴이 코드에 재도입됐다 — shared/constants 단일 출처를 쓸 것').not.toMatch(/\b0\.3\b/);
  });
});
