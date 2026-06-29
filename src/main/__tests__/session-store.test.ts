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
      stat: vi.fn(async (p: string) => {
        const v = V.files.get(norm(p));
        if (v === undefined) throw enoent();
        const size = typeof v === 'string' ? Buffer.byteLength(v) : v.byteLength;
        return { size };
      }),
    },
  };
});

import fsp from 'fs/promises';
import {
  writeSession, readSession, readSessionMeta, patchSession, mergeSessionSummary, deleteSession, clearAll,
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

describe('writeSession keepIndex (serialize-skip, Tier2)', () => {
  it('keepIndex=true → 기존 index.bin 보존(재기록·삭제 안 함) + byteSize 에 기존 크기 반영', async () => {
    const h = hashOf(7);
    const blob = new Float32Array([1, 0, 0, 0, 1, 0]).buffer; // 2×3 인덱스
    await writeSession(DIR, { meta: metaOf(h), session: { v: 1 }, blob, now: 1000 });
    const withBlob = (await readSession(DIR, h))!.blob!;
    const byteWithBlob = (await listSessions(DIR))[0]!.byteSize;

    // keepIndex 로 재저장(blob 미전송) → 인덱스 그대로, 본문만 갱신
    const r = await writeSession(DIR, { meta: metaOf(h), session: { v: 2 }, blob: null, keepIndex: true, now: 2000 });
    expect(r.ok).toBe(true);

    const after = await readSession(DIR, h);
    expect(after!.blob).not.toBeNull();                       // index.bin 보존됨 (null→unlink 와 구분)
    expect(after!.blob!.byteLength).toBe(withBlob.byteLength); // 동일 인덱스
    expect((after!.session as { v: number }).v).toBe(2);      // 본문은 갱신
    // byteSize 가 index.bin 크기를 계속 포함 (과소계상 방지 — LRU 캡 정상)
    const byteAfter = (await listSessions(DIR))[0]!.byteSize;
    expect(byteAfter).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ v: 2 })));
    expect(Math.abs(byteAfter - byteWithBlob)).toBeLessThan(50); // json 차이만큼만 변동
  });

  it('keepIndex 인데 index.bin 이 없으면 byteSize=json 만 (graceful)', async () => {
    const h = hashOf(8);
    const r = await writeSession(DIR, { meta: { ...metaOf(h), embedModel: null, embedDim: null, chunkCount: 0 }, session: { v: 1 }, blob: null, keepIndex: true, now: 1000 });
    expect(r.ok).toBe(true);
    expect((await readSession(DIR, h))!.blob).toBeNull();
    expect(Number.isFinite((await listSessions(DIR))[0]!.byteSize)).toBe(true);
  });
});

describe('patchSession (부분저장 IPC, Tier3)', () => {
  it('qa/summary delta 만 패치 — 불변 본문(extractedText)·index.bin 보존', async () => {
    const h = hashOf(11);
    const blob = new Float32Array([1, 0, 0, 0, 1, 0]).buffer;
    // 전체 저장으로 완전한 세션 생성
    await writeSession(DIR, {
      meta: metaOf(h),
      session: {
        docHash: h, extractedText: '아주 긴 본문'.repeat(100), pageTexts: ['p1', 'p2'],
        chunkMeta: [{ text: 'c', index: 0 }], summaries: { full: { content: '구요약', model: 'm', provider: 'ollama' } },
        summaryType: 'full', qaMessages: [],
      },
      blob, now: 1000,
    });
    const before = (await readSession(DIR, h))!;
    const bodyText = (before.session as { extractedText: string }).extractedText;

    // 부분 패치 — qa 추가 + 요약 갱신
    const r = await patchSession(DIR, {
      docHash: h,
      summary: { type: 'full', content: '새요약', model: 'm2', provider: 'ollama' },
      summaryType: 'full',
      qaMessages: [{ id: 'q', role: 'user', content: '질문' }],
      now: 2000,
    });
    expect(r.ok).toBe(true);

    const after = await readSession(DIR, h);
    const sess = after!.session as { extractedText: string; pageTexts: string[]; chunkMeta: unknown[]; summaries: Record<string, { content: string }>; qaMessages: unknown[] };
    expect(sess.extractedText).toBe(bodyText);          // 불변 본문 보존
    expect(sess.pageTexts).toEqual(['p1', 'p2']);
    expect(sess.chunkMeta).toHaveLength(1);
    expect(after!.blob).not.toBeNull();                 // index.bin 보존
    expect(after!.blob!.byteLength).toBe(blob.byteLength);
    expect(sess.summaries.full!.content).toBe('새요약'); // 요약 갱신
    expect(sess.qaMessages).toHaveLength(1);            // qa 갱신
  });

  it('다른 타입 요약은 보존하고 해당 타입만 교체', async () => {
    const h = hashOf(12);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, summaries: { full: { content: 'F', model: 'm', provider: 'ollama' }, keywords: { content: 'K', model: 'm', provider: 'ollama' } }, summaryType: 'full', qaMessages: [] },
      blob: null, now: 1000,
    });
    await patchSession(DIR, { docHash: h, summary: { type: 'full', content: 'F2', model: 'm', provider: 'ollama' }, summaryType: 'full', qaMessages: [], now: 2000 });
    const sess = (await readSession(DIR, h))!.session as { summaries: Record<string, { content: string }> };
    expect(sess.summaries.full!.content).toBe('F2');  // 교체
    expect(sess.summaries.keywords!.content).toBe('K'); // 보존
  });

  it('디스크 세션 부재 → {ok:false} (호출자 전체저장 폴백 신호)', async () => {
    const r = await patchSession(DIR, { docHash: hashOf(99), summary: null, summaryType: 'full', qaMessages: [], now: 1000 });
    expect(r.ok).toBe(false);
  });


  it('잘못된 docHash → {ok:false}', async () => {
    const r = await patchSession(DIR, { docHash: '../evil', summary: null, summaryType: 'full', qaMessages: [], now: 1000 });
    expect(r.ok).toBe(false);
  });

  it('QA: readSession/readSessionMeta 는 실제 I/O 오류(EBUSY)는 throw, 부재(ENOENT)는 null', async () => {
    const h = hashOf(91);
    await writeSession(DIR, { meta: metaOf(h), session: { v: 1 }, blob: null, now: 1000 });
    expect(await readSession(DIR, h)).not.toBeNull();   // 정상
    expect(await readSessionMeta(DIR, h)).not.toBeNull();

    // 다음 readFile(session.json) 1회만 EBUSY — 일시 I/O 오류 시 전파(보존 신호)
    vi.mocked(fsp.readFile).mockImplementationOnce(async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); });
    await expect(readSession(DIR, h)).rejects.toThrow();
    vi.mocked(fsp.readFile).mockImplementationOnce(async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    await expect(readSessionMeta(DIR, h)).rejects.toThrow();

    // 부재(ENOENT)는 종전대로 null (전파 안 함)
    expect(await readSession(DIR, hashOf(92))).toBeNull();
    expect(await readSessionMeta(DIR, hashOf(93))).toBeNull();
  });

  it('summary=null 이면 요약 미변경(qa 만 갱신)', async () => {
    const h = hashOf(13);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, summaries: { full: { content: 'keep', model: 'm', provider: 'ollama' } }, summaryType: 'full', qaMessages: [] },
      blob: null, now: 1000,
    });
    await patchSession(DIR, { docHash: h, summary: null, summaryType: 'full', qaMessages: [{ id: 'q', role: 'user', content: 'x' }], now: 2000 });
    const sess = (await readSession(DIR, h))!.session as { summaries: Record<string, { content: string }>; qaMessages: unknown[] };
    expect(sess.summaries.full!.content).toBe('keep'); // 요약 보존
    expect(sess.qaMessages).toHaveLength(1);           // qa 갱신
  });
});

describe('chunkMeta 사이드카 분리 (index.meta.json, Tier3)', () => {
  const cm = [{ text: '청크A', index: 0, pageStart: 1 }, { text: '청크B', index: 1, pageStart: 2 }];
  const idxBlob = () => new Float32Array([1, 0, 0, 0, 1, 0]).buffer; // 2×3
  const p = (h: string, f: string) => `${DIR}/${h}/${f}`;

  it('writeSession: chunkMeta 를 index.meta.json 으로 분리(session.json 엔 없음), readSession 이 병합 복원', async () => {
    const h = hashOf(31);
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, extractedText: '본문', chunkMeta: cm }, blob: idxBlob(), now: 1000 });

    // 디스크: index.meta.json 에 chunkMeta, session.json 엔 없음
    const metaRaw = V.files.get(p(h, 'index.meta.json'));
    expect(metaRaw).toBeTruthy();
    expect(JSON.parse(String(metaRaw)).chunkMeta).toHaveLength(2);
    const sessRaw = JSON.parse(String(V.files.get(p(h, 'session.json'))));
    expect(sessRaw.chunkMeta).toBeUndefined();  // 본문 파일엔 chunkMeta 없음
    expect(sessRaw.extractedText).toBe('본문');  // 본문은 그대로

    // readSession 병합 → 호출자(복원)는 종전대로 session.chunkMeta 를 본다
    const loaded = await readSession(DIR, h);
    expect((loaded!.session as { chunkMeta: unknown[] }).chunkMeta).toHaveLength(2);
    expect(loaded!.blob).not.toBeNull();
  });

  it('구버전(session.json 에 chunkMeta, 사이드카 없음) → readSession fallback', async () => {
    const h = hashOf(32);
    V.files.set(p(h, 'session.json'), JSON.stringify({ docHash: h, chunkMeta: cm })); // 구버전 직접 주입
    const loaded = await readSession(DIR, h);
    expect((loaded!.session as { chunkMeta: unknown[] }).chunkMeta).toHaveLength(2);
  });

  it('blob null → index.meta.json 도 함께 제거(index.bin 과 생명주기 일치)', async () => {
    const h = hashOf(33);
    await writeSession(DIR, { meta: metaOf(h), session: { chunkMeta: cm }, blob: idxBlob(), now: 1000 });
    expect(V.files.get(p(h, 'index.meta.json'))).toBeTruthy();
    await writeSession(DIR, { meta: { ...metaOf(h), embedModel: null, embedDim: null, chunkCount: 0 }, session: { chunkMeta: [] }, blob: null, now: 2000 });
    expect(V.files.get(p(h, 'index.meta.json'))).toBeUndefined(); // 제거
    expect(V.files.get(p(h, 'index.bin'))).toBeUndefined();
  });

  it('keepIndex → index.meta.json 보존(재기록 안 함)', async () => {
    const h = hashOf(34);
    await writeSession(DIR, { meta: metaOf(h), session: { chunkMeta: cm }, blob: idxBlob(), now: 1000 });
    const before = V.files.get(p(h, 'index.meta.json'));
    await writeSession(DIR, { meta: metaOf(h), session: { chunkMeta: cm }, blob: null, keepIndex: true, now: 2000 });
    expect(V.files.get(p(h, 'index.meta.json'))).toBe(before); // 그대로 보존
  });

  it('keepIndex 인데 사이드카 부재(구버전) → strip 된 chunkMeta 로 self-heal 생성 (영구 소실 방지)', async () => {
    const h = hashOf(36);
    // 사이드카 없이 index.bin 만 있는 구버전 상태 시뮬레이션
    V.files.set(p(h, 'index.bin'), Buffer.from(new Uint8Array(idxBlob())));
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, chunkMeta: cm }, blob: null, keepIndex: true, now: 1000 });
    // session.json 엔 chunkMeta 없지만 사이드카가 self-heal 로 생성됨
    expect(JSON.parse(String(V.files.get(p(h, 'session.json')))).chunkMeta).toBeUndefined();
    const metaRaw = V.files.get(p(h, 'index.meta.json'));
    expect(metaRaw).toBeTruthy();
    expect(JSON.parse(String(metaRaw)).chunkMeta).toHaveLength(2);
    // readSession 병합 → chunkMeta 복원됨(소실 없음)
    expect(((await readSession(DIR, h))!.session as { chunkMeta: unknown[] }).chunkMeta).toHaveLength(2);
  });

  it('byteSize 가 index.meta.json 크기를 포함(LRU 과소계상 방지)', async () => {
    const h = hashOf(35);
    await writeSession(DIR, { meta: metaOf(h), session: { chunkMeta: cm }, blob: idxBlob(), now: 1000 });
    const sessBytes = Buffer.byteLength(String(V.files.get(p(h, 'session.json'))));
    const metaBytes = Buffer.byteLength(String(V.files.get(p(h, 'index.meta.json'))));
    const binBytes = (V.files.get(p(h, 'index.bin')) as Buffer).byteLength;
    const entry = (await listSessions(DIR)).find((e) => e.docHash === h)!;
    expect(entry.byteSize).toBe(sessBytes + binBytes + metaBytes);
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
