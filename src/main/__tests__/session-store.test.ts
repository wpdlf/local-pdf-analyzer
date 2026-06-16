import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SESSION_MAX_COUNT,
  type SessionManifestEntry,
  type SessionSaveMeta,
} from '../../shared/session-types';

// session-persistence module-2 (L2): session-store 파일 I/O·LRU·검증.
// fs/promises 를 in-memory 가상 파일시스템으로 모킹해 원자적 쓰기·매니페스트·LRU·삭제를 행위 검증.

const V = vi.hoisted(() => ({ files: new Map<string, Buffer | string>() }));

vi.mock('fs/promises', () => {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const enoent = () => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; return e; };
  return {
    default: {
      writeFile: vi.fn(async (p: string, data: Buffer | string | Uint8Array) => {
        V.files.set(norm(p), data instanceof Uint8Array && !(data instanceof Buffer) ? Buffer.from(data) : data as Buffer | string);
      }),
      rename: vi.fn(async (a: string, b: string) => {
        const k = norm(a); const v = V.files.get(k);
        if (v === undefined) throw enoent();
        V.files.set(norm(b), v); V.files.delete(k);
      }),
      readFile: vi.fn(async (p: string, _enc?: string) => {
        const v = V.files.get(norm(p));
        if (v === undefined) throw enoent();
        return v;
      }),
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async (p: string) => {
        const prefix = norm(p);
        for (const k of [...V.files.keys()]) {
          if (k === prefix || k.startsWith(prefix + '/')) V.files.delete(k);
        }
      }),
      unlink: vi.fn(async (p: string) => { V.files.delete(norm(p)); }),
    },
  };
});

import {
  writeSession, readSession, mergeSessionSummary, deleteSession, clearAll,
  listSessions, sessionStats, enforceLru, isValidDocHash, loadManifest,
} from '../session-store';

const DIR = '/userData/sessions';
const hashOf = (n: number) => n.toString(16).padStart(64, '0'); // 유효 64-hex
const metaOf = (docHash: string): SessionSaveMeta => ({
  docHash, fileName: 'doc.pdf', filePath: '/x/doc.pdf', pageCount: 10,
  embedModel: 'nomic-embed-text', embedDim: 3, chunkCount: 2,
});

beforeEach(() => { V.files.clear(); });

describe('isValidDocHash', () => {
  it('64-hex 만 허용 (traversal/형식 위반 거부)', () => {
    expect(isValidDocHash(hashOf(1))).toBe(true);
    expect(isValidDocHash('../etc/passwd')).toBe(false);
    expect(isValidDocHash('ABC')).toBe(false);
    expect(isValidDocHash('g'.repeat(64))).toBe(false);
    expect(isValidDocHash(123)).toBe(false);
  });
});

describe('mergeSessionSummary (컬렉션 인라인 요약 영속화)', () => {
  it('기존 세션에 summaries[type] 병합 — 다른 필드 보존', async () => {
    const h = hashOf(1);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, extractedText: 'body', summaries: {}, qaMessages: [{ role: 'user', content: 'q' }] },
      blob: null, now: 1000,
    });
    const r = await mergeSessionSummary(DIR, h, 'full', { content: '요약본', model: 'm', provider: 'ollama' }, 2000);
    expect(r).toEqual({ ok: true });
    const s = (await readSession(DIR, h))?.session as Record<string, unknown>;
    expect((s.summaries as Record<string, unknown>).full).toEqual({ content: '요약본', model: 'm', provider: 'ollama' });
    expect(s.extractedText).toBe('body');                          // 본문 보존
    expect((s.qaMessages as unknown[])).toHaveLength(1);           // Q&A 보존
  });

  it('기존 다른 타입 요약은 보존하고 해당 타입만 갱신', async () => {
    const h = hashOf(2);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, summaries: { keywords: { content: 'kw', model: 'm', provider: 'ollama' } } },
      blob: null, now: 1000,
    });
    await mergeSessionSummary(DIR, h, 'full', { content: 'full요약', model: 'm', provider: 'ollama' }, 2000);
    const sm = ((await readSession(DIR, h))?.session as { summaries: Record<string, { content: string }> }).summaries;
    expect(sm.keywords?.content).toBe('kw');     // 기존 타입 보존
    expect(sm.full?.content).toBe('full요약');   // 신규 타입 병합
  });

  it('세션 부재 → {ok:false} (쓰기 없음)', async () => {
    const r = await mergeSessionSummary(DIR, hashOf(9), 'full', { content: 'x', model: 'm', provider: 'ollama' }, 1000);
    expect(r).toEqual({ ok: false });
  });

  it('잘못된 docHash / 빈 content 거부', async () => {
    expect(await mergeSessionSummary(DIR, 'bad', 'full', { content: 'x', model: 'm', provider: 'ollama' }, 1)).toEqual({ ok: false });
    const h = hashOf(3);
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, summaries: {} }, blob: null, now: 1 });
    expect(await mergeSessionSummary(DIR, h, 'full', { content: '   ', model: 'm', provider: 'ollama' }, 1)).toEqual({ ok: false });
  });

  it('manifest lastAccessed 갱신', async () => {
    const h = hashOf(4);
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, summaries: {} }, blob: null, now: 1000 });
    await mergeSessionSummary(DIR, h, 'full', { content: 'y', model: 'm', provider: 'ollama' }, 5000);
    const entry = (await loadManifest(DIR)).entries.find((e) => e.docHash === h);
    expect(entry?.lastAccessed).toBe(new Date(5000).toISOString());
  });
});

describe('writeSession / readSession 라운드트립', () => {
  it('세션 본문 + 블롭 저장 후 복원', async () => {
    const h = hashOf(1);
    const blob = new Float32Array([1, 0, 0, 0, 1, 0]).buffer; // 2×3
    const session = { schemaVersion: 1, docHash: h, qaMessages: [{ id: 'a', role: 'user', content: 'q' }] };
    const r = await writeSession(DIR, { meta: metaOf(h), session, blob, now: 1000 });
    expect(r.ok).toBe(true);

    const loaded = await readSession(DIR, h);
    expect(loaded).not.toBeNull();
    expect((loaded!.session as { docHash: string }).docHash).toBe(h);
    expect(loaded!.blob).not.toBeNull();
    expect(loaded!.blob!.byteLength).toBe(6 * 4);
  });

  it('블롭 없이도 저장/복원 (인덱스 미저장)', async () => {
    const h = hashOf(2);
    await writeSession(DIR, { meta: { ...metaOf(h), embedModel: null, embedDim: null, chunkCount: 0 }, session: { docHash: h }, blob: null, now: 1000 });
    const loaded = await readSession(DIR, h);
    expect(loaded!.blob).toBeNull();
  });

  it('부재 → null', async () => {
    expect(await readSession(DIR, hashOf(99))).toBeNull();
  });

  it('손상 session.json → null (정상 재계산 폴백)', async () => {
    const h = hashOf(3);
    V.files.set(`${DIR}/${h}/session.json`, '{ broken json');
    expect(await readSession(DIR, h)).toBeNull();
  });

  it('잘못된 docHash 저장 거부', async () => {
    const r = await writeSession(DIR, { meta: metaOf('../evil'), session: {}, blob: null, now: 1 });
    expect(r.ok).toBe(false);
  });
});

describe('manifest / list / stats / delete / clear', () => {
  it('저장 시 manifest upsert + list/stats 반영', async () => {
    await writeSession(DIR, { meta: metaOf(hashOf(1)), session: { a: 1 }, blob: null, now: 1000 });
    await writeSession(DIR, { meta: metaOf(hashOf(2)), session: { a: 2 }, blob: null, now: 2000 });
    const list = await listSessions(DIR);
    expect(list).toHaveLength(2);
    expect(list[0]!.docHash).toBe(hashOf(2)); // lastAccessed 내림차순
    const stats = await sessionStats(DIR);
    expect(stats.count).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.dir).toBe(DIR);
  });

  it('동일 docHash 재저장 시 createdAt 보존 + 항목 1개 유지', async () => {
    const h = hashOf(1);
    await writeSession(DIR, { meta: metaOf(h), session: { v: 1 }, blob: null, now: 1000 });
    await writeSession(DIR, { meta: metaOf(h), session: { v: 2 }, blob: null, now: 5000 });
    const list = await listSessions(DIR);
    expect(list).toHaveLength(1);
    expect(list[0]!.createdAt).toBe(new Date(1000).toISOString());
    expect(list[0]!.lastAccessed).toBe(new Date(5000).toISOString());
  });

  it('deleteSession 은 디렉토리 + manifest 항목 제거', async () => {
    await writeSession(DIR, { meta: metaOf(hashOf(1)), session: { a: 1 }, blob: null, now: 1000 });
    const r = await deleteSession(DIR, hashOf(1));
    expect(r.ok).toBe(true);
    expect(await listSessions(DIR)).toHaveLength(0);
    expect(await readSession(DIR, hashOf(1))).toBeNull();
  });

  it('clearAll 은 전체 비우기', async () => {
    await writeSession(DIR, { meta: metaOf(hashOf(1)), session: { a: 1 }, blob: null, now: 1000 });
    await clearAll(DIR);
    expect(await listSessions(DIR)).toHaveLength(0);
  });
});

describe('enforceLru (순수)', () => {
  const entry = (h: string, last: number, bytes: number): SessionManifestEntry => ({
    docHash: h, fileName: 'f', filePath: 'p', pageCount: 1,
    embedModel: null, embedDim: null, chunkCount: 0, byteSize: bytes,
    createdAt: 'x', lastAccessed: new Date(last).toISOString(),
  });

  it('개수 초과 시 가장 오래된 것부터 제거', () => {
    const entries = [entry('a', 1000, 10), entry('b', 3000, 10), entry('c', 2000, 10)];
    const evict = enforceLru(entries, 2, Infinity);
    expect(evict).toEqual(['a']); // 가장 오래된 lastAccessed
  });

  it('용량 초과 시 오래된 것부터 누적 제거', () => {
    const entries = [entry('a', 1000, 100), entry('b', 2000, 100), entry('c', 3000, 100)];
    const evict = enforceLru(entries, Infinity, 150);
    expect(evict).toEqual(['a', 'b']); // 100+100+100=300 > 150 → a,b 제거 후 100 ≤ 150
  });

  it('상한 이내면 빈 배열', () => {
    const entries = [entry('a', 1000, 10), entry('b', 2000, 10)];
    expect(enforceLru(entries, 5, 1000)).toEqual([]);
  });
});

describe('R41 fixes (session-store)', () => {
  it('blob 없이 재저장 시 이전 index.bin 제거 (stale 인덱스 + byteSize 과소 방지)', async () => {
    const h = hashOf(1);
    const blob = new Float32Array([1, 0, 0, 0, 1, 0]).buffer; // 2×3
    await writeSession(DIR, { meta: metaOf(h), session: { a: 1 }, blob, now: 1000 });
    expect((await readSession(DIR, h))!.blob).not.toBeNull();
    const withBlob = (await listSessions(DIR))[0]!.byteSize;

    // 같은 docHash 를 blob 없이 재저장 → 이전 index.bin 제거 + byteSize 축소
    await writeSession(DIR, {
      meta: { ...metaOf(h), embedModel: null, embedDim: null, chunkCount: 0 },
      session: { a: 2 }, blob: null, now: 2000,
    });
    expect((await readSession(DIR, h))!.blob).toBeNull();
    expect((await listSessions(DIR))[0]!.byteSize).toBeLessThan(withBlob);
  });

  it('손상된 meta 필드(거대 문자열/NaN/Infinity) 를 서버측 정규화', async () => {
    const h = hashOf(2);
    await writeSession(DIR, {
      meta: {
        docHash: h, fileName: 'x'.repeat(2000), filePath: 'p',
        pageCount: NaN, embedModel: null, embedDim: null, chunkCount: Infinity,
      },
      session: {}, blob: null, now: 1000,
    });
    const e = (await listSessions(DIR))[0]!;
    expect(e.fileName.length).toBeLessThanOrEqual(512);
    expect(e.pageCount).toBe(0);      // NaN → 0
    expect(e.chunkCount).toBe(0);     // Infinity → 0
    // byteSize 합산이 NaN 으로 오염되지 않음 → LRU 용량 캡 정상 동작
    expect(Number.isFinite((await sessionStats(DIR)).totalBytes)).toBe(true);
  });
});

describe('R42 fixes (session-store)', () => {
  // 손상된 manifest(부분 쓰기/외부 편집) 의 개별 엔트리를 loadManifest 가 정규화/폐기하는지 검증.
  // 과거: entries 배열 여부만 검사 → 비문자열 lastAccessed 가 listSessions/enforceLru 의
  // .localeCompare 를 throw(try/catch 없는 session:list·stats 핸들러 크래시), 비유한 byteSize 가
  // sessionStats 합산·200MB LRU 캡을 NaN 으로 무력화.
  const writeRawManifest = (entries: unknown[]) => {
    V.files.set(`${DIR}/manifest.json`, JSON.stringify({ schemaVersion: 1, entries }));
  };

  it('비문자열 lastAccessed 엔트리가 있어도 listSessions/sessionStats 가 throw 하지 않음', async () => {
    writeRawManifest([
      { docHash: hashOf(1), lastAccessed: 12345, byteSize: 10 }, // lastAccessed 숫자(손상)
      { docHash: hashOf(2), lastAccessed: '2026-01-01T00:00:00.000Z', byteSize: 20 },
    ]);
    // 과거엔 12345.localeCompare 로 throw → 이제 epoch 폴백으로 정상 정렬
    const list = await listSessions(DIR);
    expect(list).toHaveLength(2);
    expect(list[0]!.docHash).toBe(hashOf(2)); // 최신이 먼저 (손상 엔트리는 epoch 로 밀림)
    expect(Number.isFinite((await sessionStats(DIR)).totalBytes)).toBe(true);
  });

  it('비유한 byteSize 를 0 으로 정규화해 LRU 용량 합산 NaN 오염 차단', async () => {
    writeRawManifest([
      { docHash: hashOf(1), lastAccessed: '2026-01-01T00:00:00.000Z', byteSize: Number.NaN },
      { docHash: hashOf(2), lastAccessed: '2026-01-02T00:00:00.000Z', byteSize: 100 },
    ]);
    const stats = await sessionStats(DIR);
    expect(stats.totalBytes).toBe(100); // NaN → 0, 100 만 합산
  });

  it('유효 docHash 가 없는 엔트리는 폐기', async () => {
    writeRawManifest([
      { docHash: '../etc/passwd', lastAccessed: '2026-01-01T00:00:00.000Z', byteSize: 10 },
      { lastAccessed: '2026-01-02T00:00:00.000Z' }, // docHash 누락
      { docHash: hashOf(3), lastAccessed: '2026-01-03T00:00:00.000Z', byteSize: 30 },
    ]);
    const manifest = await loadManifest(DIR);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]!.docHash).toBe(hashOf(3));
  });
});

describe('writeSession LRU 통합', () => {
  it('MAX_COUNT 초과 시 가장 오래된 세션 자동 제거', async () => {
    // MAX_COUNT 개를 오래된 순으로 미리 채움
    for (let i = 0; i < SESSION_MAX_COUNT; i++) {
      await writeSession(DIR, { meta: metaOf(hashOf(i)), session: { i }, blob: null, now: 1000 + i });
    }
    expect(await listSessions(DIR)).toHaveLength(SESSION_MAX_COUNT);
    // 1개 더 추가 → 가장 오래된 hashOf(0) 제거, 개수 유지
    await writeSession(DIR, { meta: metaOf(hashOf(9999)), session: { x: 1 }, blob: null, now: 9_000_000 });
    const list = await listSessions(DIR);
    expect(list).toHaveLength(SESSION_MAX_COUNT);
    expect(list.some((e) => e.docHash === hashOf(0))).toBe(false);
    expect(list.some((e) => e.docHash === hashOf(9999))).toBe(true);
    expect(await readSession(DIR, hashOf(0))).toBeNull(); // 디렉토리도 제거됨
  });
});
