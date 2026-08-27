import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SESSION_MAX_COUNT,
  type SessionManifestEntry,
  type SessionSaveMeta,
} from '../../shared/session-types';
import { MAX_SUMMARY_TYPE_LEN, MAX_TEMPLATE_ID_LEN } from '../../shared/constants';

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
      // QA6-B(reconcile): withFileTypes readdir — 평면 파일맵에서 1단계 하위 항목을 유도.
      // '<dir>/<name>/...' 형태면 <name> 은 디렉토리, '<dir>/<name>' 이 파일이면 파일.
      readdir: vi.fn(async (p: string, _opts?: unknown) => {
        const prefix = norm(p).replace(/\/$/, '') + '/';
        const entries = new Map<string, boolean>(); // name → isDirectory
        let found = false;
        for (const k of V.files.keys()) {
          if (!k.startsWith(prefix)) continue;
          found = true;
          const rest = k.slice(prefix.length);
          const idx = rest.indexOf('/');
          if (idx === -1) entries.set(rest, entries.get(rest) ?? false);
          else entries.set(rest.slice(0, idx), true);
        }
        if (!found) throw enoent();
        // QA28(A-Low): withFileTypes 없이 부르면 실제 fs 처럼 **이름 문자열** 배열을 준다
        // (reconcile 의 byteSize 실측이 이 형태로 부른다 — 객체를 주면 path.join 이 throw).
        if (!(_opts && typeof _opts === 'object' && (_opts as { withFileTypes?: boolean }).withFileTypes)) {
          return [...entries.keys()];
        }
        return [...entries.entries()].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
      }),
    },
  };
});

import fsp from 'fs/promises';
import {
  writeSession, readSession, readSessionMeta, patchSession, mergeSessionSummary, deleteSession, clearAll,
  listSessions, sessionStats, enforceLru, isValidDocHash, loadManifest, reconcileSessions,
} from '../session-store';

const DIR = '/userData/sessions';

/**
 * QA24(C-M2): listSessions 는 일시 I/O 오류를 `null` 로 구분해 반환한다("불러오지 못함" ≠
 * "정말 없음"). 아래 기존 테스트들은 전부 정상 경로라 배열을 기대하므로, null 이면 즉시
 * 실패시키는 래퍼로 감싼다 — 옵셔널 체이닝으로 넘기면 null 이 반환되기 시작해도 단언이
 * 조용히 통과하는 공허한 테스트가 된다. null 계약 자체는 아래 별도 describe 에서 검증한다.
 */
async function listSessionsOk(dir: string) {
  const list = await listSessions(dir);
  if (list === null) throw new Error('listSessions 가 null 을 반환했다 — 이 테스트는 정상 경로를 기대한다');
  return list;
}
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

  // QA post-v0.31.15: patchSession 과 대칭 — session.json 존재 + manifest 엔트리 부재 시 ok:false.
  it('session.json 존재 + manifest 엔트리 부재 → {ok:false} (divergent write 미은폐)', async () => {
    const h = hashOf(5);
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, summaries: {} }, blob: null, now: 1000 });
    V.files.set('/userData/sessions/manifest.json', JSON.stringify({ schemaVersion: 1, entries: [] }));
    const r = await mergeSessionSummary(DIR, h, 'full', { content: 'z', model: 'm', provider: 'ollama' }, 2000);
    expect(r).toEqual({ ok: false });
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

// QA24(C-M2): "불러오지 못함" 과 "정말 없음" 을 구분한다. 종전에는 둘 다 `[]` 라 EBUSY 한 번에
// ①최근 문서 목록이 빈 채로 표시되고(사용자는 전량 소실로 읽는다) ②use-qa 의 resolveMembers 가
// 활성 문서 외 전 멤버를 missing 으로 판정해 **컬렉션 Q&A 가 다른 문서를 빼고 답변**했다(조용한 오답).
// QA23(D-LOW)이 listCollections 를 같은 이유로 전파형으로 바꿨는데 세션에는 이식되지 않았다.
describe('listSessions — 읽기 실패 ≠ 부재', () => {
  it.each(['EBUSY', 'EACCES', 'EPERM'])('일시 I/O 오류(%s)는 null 을 반환한다', async (code) => {
    await writeSession(DIR, { meta: metaOf(hashOf(1)), session: { a: 1 }, blob: null, now: 1000 });
    const err: NodeJS.ErrnoException = Object.assign(new Error(code), { code });
    const spy = vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(err);
    try {
      await expect(listSessions(DIR)).resolves.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('manifest 부재(ENOENT)는 빈 배열 — 그건 실제로 "없음" 이 맞다', async () => {
    await expect(listSessions('/userData/empty-sessions')).resolves.toEqual([]);
  });
});

describe('manifest / list / stats / delete / clear', () => {
  it('저장 시 manifest upsert + list/stats 반영', async () => {
    await writeSession(DIR, { meta: metaOf(hashOf(1)), session: { a: 1 }, blob: null, now: 1000 });
    await writeSession(DIR, { meta: metaOf(hashOf(2)), session: { a: 2 }, blob: null, now: 2000 });
    const list = await listSessionsOk(DIR);
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
    const list = await listSessionsOk(DIR);
    expect(list).toHaveLength(1);
    expect(list[0]!.createdAt).toBe(new Date(1000).toISOString());
    expect(list[0]!.lastAccessed).toBe(new Date(5000).toISOString());
  });

  it('deleteSession 은 디렉토리 + manifest 항목 제거', async () => {
    await writeSession(DIR, { meta: metaOf(hashOf(1)), session: { a: 1 }, blob: null, now: 1000 });
    const r = await deleteSession(DIR, hashOf(1));
    expect(r.ok).toBe(true);
    expect(await listSessionsOk(DIR)).toHaveLength(0);
    expect(await readSession(DIR, hashOf(1))).toBeNull();
  });

  it('clearAll 은 전체 비우기', async () => {
    await writeSession(DIR, { meta: metaOf(hashOf(1)), session: { a: 1 }, blob: null, now: 1000 });
    await clearAll(DIR);
    expect(await listSessionsOk(DIR)).toHaveLength(0);
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
    const withBlob = (await listSessionsOk(DIR))[0]!.byteSize;

    // 같은 docHash 를 blob 없이 재저장 → 이전 index.bin 제거 + byteSize 축소
    await writeSession(DIR, {
      meta: { ...metaOf(h), embedModel: null, embedDim: null, chunkCount: 0 },
      session: { a: 2 }, blob: null, now: 2000,
    });
    expect((await readSession(DIR, h))!.blob).toBeNull();
    expect((await listSessionsOk(DIR))[0]!.byteSize).toBeLessThan(withBlob);
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
    const e = (await listSessionsOk(DIR))[0]!;
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
    const byteWithBlob = (await listSessionsOk(DIR))[0]!.byteSize;

    // keepIndex 로 재저장(blob 미전송) → 인덱스 그대로, 본문만 갱신
    const r = await writeSession(DIR, { meta: metaOf(h), session: { v: 2 }, blob: null, keepIndex: true, now: 2000 });
    expect(r.ok).toBe(true);

    const after = await readSession(DIR, h);
    expect(after!.blob).not.toBeNull();                       // index.bin 보존됨 (null→unlink 와 구분)
    expect(after!.blob!.byteLength).toBe(withBlob.byteLength); // 동일 인덱스
    expect((after!.session as { v: number }).v).toBe(2);      // 본문은 갱신
    // byteSize 가 index.bin 크기를 계속 포함 (과소계상 방지 — LRU 캡 정상)
    const byteAfter = (await listSessionsOk(DIR))[0]!.byteSize;
    expect(byteAfter).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ v: 2 })));
    expect(Math.abs(byteAfter - byteWithBlob)).toBeLessThan(50); // json 차이만큼만 변동
  });

  it('keepIndex 인데 index.bin 이 없으면 byteSize=json 만 (graceful)', async () => {
    const h = hashOf(8);
    const r = await writeSession(DIR, { meta: { ...metaOf(h), embedModel: null, embedDim: null, chunkCount: 0 }, session: { v: 1 }, blob: null, keepIndex: true, now: 1000 });
    expect(r.ok).toBe(true);
    expect((await readSession(DIR, h))!.blob).toBeNull();
    expect(Number.isFinite((await listSessionsOk(DIR))[0]!.byteSize)).toBe(true);
  });

  // QA21(C-MED, 조용한 오답): 위 테스트는 meta 가 이미 "인덱스 없음"(embedModel:null, chunkCount:0)인
  // **정직한** 경우만 다뤄, 진짜 문제 케이스를 구조적으로 비껴갔다 — 렌더러가 "인덱스 있음" 을
  // 주장하는데 디스크에 index.bin 이 없는 경우. 그러면 manifest 에 거짓 엔트리가 남아
  // semantic-search 는 후보로 통과시킨 뒤 결과에서 조용히 빼고(excludedCount 에도 미집계),
  // 컬렉션은 ready 배지를 켠 채 그 문서를 빼고 답변한다.
  it('keepIndex 인데 index.bin 이 없으면 manifest 가 "인덱스 있음" 을 주장하지 않는다', async () => {
    const h = hashOf(9);
    const r = await writeSession(DIR, {
      // 렌더러는 인덱스가 있다고 믿는 상태(시그니처 유효) — 디스크는 비어 있다(LRU evict 직후 등)
      meta: { ...metaOf(h), embedModel: 'nomic-embed-text', embedDim: 768, chunkCount: 42 },
      session: { v: 1 }, blob: null, keepIndex: true, now: 1000,
    });

    // 저장 자체는 성공해야 한다 — 여기서 실패시키면 session.json 은 이미 기록됐는데 manifest 에
    // 등록되지 않은 고아 디렉터리가 남는다(목록·검색·LRU 어디에도 안 잡힘).
    expect(r.ok).toBe(true);
    expect(r.indexMissing).toBe(true); // 렌더러가 시그니처를 무효화하고 전체 저장으로 회복하도록

    const entry = (await listSessionsOk(DIR)).find((e) => e.docHash === h)!;
    expect(entry.embedModel, '없는 인덱스를 있다고 기록하면 안 된다').toBeNull();
    expect(entry.embedDim).toBeNull();
    expect(entry.chunkCount).toBe(0);
    // chunkMeta 사이드카만 남는 상태(blob 없이 meta 만)도 만들지 않는다
    expect((await readSession(DIR, h))!.blob).toBeNull();
  });

  // QA21(C-MED, 데이터손실): 열린 탭의 세션은 evict 대상에서 제외(pin)한다. 비활성 탭의 분석
  // 상태(요약·Q&A·인덱스)는 메모리에 없고 디스크 세션에만 있어(탭 전환 시 setSummary(null)/
  // clearQa()) evict 되면 그 탭으로 돌아갔을 때 복구 불가다.
  it('열린 탭(openDocHashes)의 세션은 LRU evict 되지 않는다', async () => {
    const oldestOpen = hashOf(100); // 가장 오래된 = 원래라면 첫 번째 evict 대상
    for (let i = 0; i < SESSION_MAX_COUNT; i++) {
      await writeSession(DIR, {
        meta: { ...metaOf(hashOf(100 + i)), fileName: `doc-${i}.pdf` },
        session: { v: i }, blob: null, now: 1000 + i,
      });
    }
    const r = await writeSession(DIR, {
      meta: { ...metaOf(hashOf(999)), fileName: 'newest.pdf' },
      session: { v: 999 }, blob: null, now: 9999,
      openDocHashes: [oldestOpen], // 이 문서 탭이 열려 있다
    });

    expect(r.ok).toBe(true);
    const hashes = (await listSessionsOk(DIR)).map((e) => e.docHash);
    expect(hashes, '열린 탭은 보호돼야 한다').toContain(oldestOpen);
    // 상한은 여전히 지켜진다 — 열린 탭 대신 그 다음으로 오래된 것이 지워진다
    expect(hashes).not.toContain(hashOf(101));
    expect(r.evicted).toContain('doc-1.pdf');
  });

  it('열린 탭만 남아 상한을 넘으면 아무것도 지우지 않는다 (분석 결과 > 디스크 상한)', async () => {
    const all: string[] = [];
    for (let i = 0; i < SESSION_MAX_COUNT; i++) {
      const h = hashOf(200 + i);
      all.push(h);
      await writeSession(DIR, { meta: { ...metaOf(h) }, session: { v: i }, blob: null, now: 1000 + i });
    }
    const r = await writeSession(DIR, {
      meta: { ...metaOf(hashOf(888)) }, session: { v: 1 }, blob: null, now: 9999,
      openDocHashes: all, // 전부 열려 있음
    });

    expect(r.ok).toBe(true);
    expect(r.evicted).toBeUndefined();
    // 상한(30)을 일시 초과하도록 둔다 — 탭을 닫으면 다음 저장에서 정리된다
    expect((await listSessionsOk(DIR)).length).toBe(SESSION_MAX_COUNT + 1);
  });

  // QA21(C-MED, 데이터손실): LRU 정리는 완전 무음이었다 — ok:true 로 반환돼 렌더러의 연속실패
  // 통지망도 통과했고, 사용자는 비활성 탭의 요약·Q&A 가 사라진 이유를 알 수 없었다.
  it('LRU 로 세션이 삭제되면 삭제된 문서명을 결과에 실어 알린다', async () => {
    // 상한(30건)을 넘기도록 채운다 — 가장 오래된 것이 evict 된다.
    for (let i = 0; i < SESSION_MAX_COUNT; i++) {
      await writeSession(DIR, {
        meta: { ...metaOf(hashOf(100 + i)), fileName: `doc-${i}.pdf` },
        session: { v: i }, blob: null, now: 1000 + i,
      });
    }
    const r = await writeSession(DIR, {
      meta: { ...metaOf(hashOf(999)), fileName: 'newest.pdf' },
      session: { v: 999 }, blob: null, now: 9999,
    });

    expect(r.ok).toBe(true);
    expect(r.evicted, '삭제 사실이 호출자에게 전달돼야 한다(무음 금지)').toBeDefined();
    expect(r.evicted).toContain('doc-0.pdf'); // 가장 오래된 것
    // 삭제 성공분만 보고 — 목록에서도 실제로 사라졌는지 확인
    const hashes = (await listSessionsOk(DIR)).map((e) => e.docHash);
    expect(hashes).not.toContain(hashOf(100));
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

  // QA22(백로그): 커스텀 템플릿 요약 키는 `custom:<id>` 라 최대 71자(7 + id 64)인데 세 경로가
  // 전부 64 로 판정했다. patchSession 은 키를 **잘라서** 저장했으므로 렌더러가 원본 키로 조회하는
  // 다음 복원에서 요약이 사라진다(저장은 ok:true — 조용한 소실).
  it('최대 길이 custom 키(71자)가 절단 없이 왕복한다', async () => {
    const h = hashOf(13);
    const key = `custom:${'a'.repeat(MAX_TEMPLATE_ID_LEN)}`;
    expect(key.length).toBe(MAX_SUMMARY_TYPE_LEN);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, summaries: {}, summaryType: 'full', qaMessages: [] },
      blob: null, now: 1000,
    });
    const r = await patchSession(DIR, {
      docHash: h,
      summary: { type: key, content: '커스텀 요약', model: 'm', provider: 'ollama' },
      summaryType: key,
      qaMessages: [],
      now: 2000,
    });
    expect(r.ok).toBe(true);
    const sess = (await readSession(DIR, h))!.session as { summaries: Record<string, { content: string }>; summaryType: string };
    expect(Object.keys(sess.summaries)).toEqual([key]);   // 잘린 키가 아니라 원본 키
    expect(sess.summaries[key]!.content).toBe('커스텀 요약');
    expect(sess.summaryType).toBe(key);                    // 활성 유형도 유지(옛 값 고착 없음)
  });

  it('상한 초과 키는 잘라 저장하지 않고 요약 델타만 skip', async () => {
    const h = hashOf(14);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, summaries: { full: { content: 'F', model: 'm', provider: 'ollama' } }, summaryType: 'full', qaMessages: [] },
      blob: null, now: 1000,
    });
    const tooLong = `custom:${'a'.repeat(MAX_TEMPLATE_ID_LEN + 10)}`;
    await patchSession(DIR, {
      docHash: h,
      summary: { type: tooLong, content: 'X', model: 'm', provider: 'ollama' },
      summaryType: 'full',
      qaMessages: [{ id: 'q', role: 'user', content: '질문' }],
      now: 2000,
    });
    const sess = (await readSession(DIR, h))!.session as { summaries: Record<string, unknown>; qaMessages: unknown[] };
    expect(Object.keys(sess.summaries)).toEqual(['full']);  // 절단 키가 새로 생기지 않는다
    expect(sess.qaMessages).toHaveLength(1);                // 나머지 델타는 정상 반영
  });

  it('mergeSessionSummary 도 71자 custom 키를 수용한다 (컬렉션 인라인 요약)', async () => {
    const h = hashOf(15);
    const key = `custom:${'b'.repeat(MAX_TEMPLATE_ID_LEN)}`;
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, summaries: {}, qaMessages: [] },
      blob: null, now: 1000,
    });
    expect(await mergeSessionSummary(DIR, h, key, { content: 'C', model: 'm', provider: 'ollama' }, 2000)).toEqual({ ok: true });
    const sess = (await readSession(DIR, h))!.session as { summaries: Record<string, { content: string }> };
    expect(sess.summaries[key]!.content).toBe('C');
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

  // QA post-v0.31.14 회귀: session.json 은 있으나 manifest 엔트리가 없을 때(manifest 손상 후
  // [] 리셋 등) ok:true 를 주면 호출자가 full save 폴백을 안 해 활성 세션이 최근목록/검색/stats
  // 에서 영구 누락됐다. ok:false 로 폴백을 유도해 엔트리를 재등록하게 한다.
  it('session.json 존재 + manifest 엔트리 부재 → {ok:false} (재등록 폴백 유도)', async () => {
    const h = hashOf(77);
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, summaries: {}, qaMessages: [] }, blob: null, now: 1000 });
    // manifest 손상 시뮬레이션: 엔트리만 비운다(세션 디렉토리/json 은 보존).
    V.files.set('/userData/sessions/manifest.json', JSON.stringify({ schemaVersion: 1, entries: [] }));
    expect(await readSession(DIR, h)).not.toBeNull(); // 디스크 세션은 멀쩡
    const r = await patchSession(DIR, { docHash: h, summary: null, summaryType: 'full', qaMessages: [{ id: 'q', role: 'user', content: 'x' }], now: 2000 });
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

  // QA24(C-L2, 조용한 오답): 저장이 중간에 죽으면 디스크에 **새 텍스트 + 옛 인덱스** 가 남을 수
  // 있었다. embedModel·embedDim 이 그대로면 VectorStore.restore 가 성공하므로 **탐지되지 않고**,
  // 인용이 옛 청크 좌표를 새 텍스트에 대고 가리켜 엉뚱한 문장을 근거로 제시한다.
  // 불일치 대신 **부재**로 수렴시켜(옛 인덱스를 먼저 치운다) 재오픈 시 재임베딩으로 회복시킨다.
  it('인덱스 갱신이 중간에 실패해도 "새 텍스트 + 옛 인덱스" 짝을 남기지 않는다', async () => {
    const h = hashOf(37);
    // 1차 저장: 옛 텍스트 + 옛 인덱스
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, extractedText: '옛 본문', chunkMeta: cm },
      blob: idxBlob(), now: 1000,
    });
    expect(V.files.get(p(h, 'index.bin'))).toBeTruthy();

    // 2차 저장: 새 텍스트 + 새 인덱스인데 index.bin 기록에서 죽는다(전원 차단 등)
    const writeSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (path0, data) => {
      if (String(path0).replace(/\\/g, '/').endsWith('index.bin.tmp')) {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      }
      V.files.set(String(path0).replace(/\\/g, '/'), data as Buffer | string);
    });
    try {
      // writeSession 은 실패를 throw 하지 않고 { ok:false } 로 알린다.
      await expect(writeSession(DIR, {
        meta: metaOf(h),
        session: { docHash: h, extractedText: '새 본문', chunkMeta: cm },
        blob: idxBlob(), now: 2000,
      })).resolves.toMatchObject({ ok: false });
    } finally {
      writeSpy.mockRestore();
    }

    // 본문은 새 것으로 갱신됐을 수 있다 — 문제는 그 옆에 **옛 인덱스**가 남는 것이다.
    expect(
      V.files.get(p(h, 'index.bin')),
      '옛 index.bin 이 남으면 새 텍스트에 옛 청크 좌표가 매칭돼 조용한 오답이 된다',
    ).toBeUndefined();
    // 복원 경로에서도 **쓸 수 있는 인덱스가 없어야** 한다 — 그래야 재임베딩으로 회복된다.
    // (사이드카가 남는 것은 기존 설계가 택한 안전 상태다: blob 부재 → 인덱스 없음으로 수렴.)
    const loaded = await readSession(DIR, h);
    expect(loaded!.blob, '벡터가 남아 있으면 옛 좌표로 인용이 성립해버린다').toBeNull();
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
    const entry = (await listSessionsOk(DIR)).find((e) => e.docHash === h)!;
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
    const list = await listSessionsOk(DIR);
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
    expect(await listSessionsOk(DIR)).toHaveLength(SESSION_MAX_COUNT);
    // 1개 더 추가 → 가장 오래된 hashOf(0) 제거, 개수 유지
    await writeSession(DIR, { meta: metaOf(hashOf(9999)), session: { x: 1 }, blob: null, now: 9_000_000 });
    const list = await listSessionsOk(DIR);
    expect(list).toHaveLength(SESSION_MAX_COUNT);
    expect(list.some((e) => e.docHash === hashOf(0))).toBe(false);
    expect(list.some((e) => e.docHash === hashOf(9999))).toBe(true);
    expect(await readSession(DIR, hashOf(0))).toBeNull(); // 디렉토리도 제거됨
  });

  // QA post-v0.31.14 회귀: rm 실패 시 manifest 엔트리를 무조건 드롭하면 디스크엔 디렉토리가
  // 남는데 manifest 에선 사라져 영구 고아 + stats 과소집계가 됐다(Windows EBUSY 현실적).
  it('LRU rm 실패 → 엔트리 보존(고아 디렉토리 방지, 다음 저장 재시도)', async () => {
    for (let i = 0; i < SESSION_MAX_COUNT; i++) {
      await writeSession(DIR, { meta: metaOf(hashOf(i)), session: { i }, blob: null, now: 1000 + i });
    }
    // 가장 오래된 hashOf(0) 이 evict 대상 → 그 rm 을 1회 실패시킨다(EBUSY 모사).
    vi.mocked(fsp.rm).mockRejectedValueOnce(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));
    await writeSession(DIR, { meta: metaOf(hashOf(9999)), session: { x: 1 }, blob: null, now: 9_000_000 });
    const list = await listSessionsOk(DIR);
    // rm 실패 → 엔트리 유지(manifest 와 디스크 일치 — 고아 아님).
    expect(list.some((e) => e.docHash === hashOf(0))).toBe(true);
    expect(await readSession(DIR, hashOf(0))).not.toBeNull();
  });
});

// QA6-B: 부팅 시 1회 자가치유 — manifest 손상 리셋/엔트리 폐기로 디스크에 남은 고아 세션
// 디렉토리를 재등록하고, 복원 불가(부재/손상/정체성 불일치 session.json) 디렉토리를 회수.
describe('reconcileSessions (부팅 자가치유)', () => {
  const p = (h: string, f: string) => `${DIR}/${h}/${f}`;

  it('manifest 손상 리셋 후 고아 디렉토리를 재등록 — 목록·stats 에 복귀', async () => {
    const h1 = hashOf(1);
    const h2 = hashOf(2);
    await writeSession(DIR, { meta: metaOf(h1), session: { docHash: h1, fileName: 'a.pdf', filePath: '/a.pdf', pageCount: 3 }, blob: null, now: 1000 });
    await writeSession(DIR, { meta: metaOf(h2), session: { docHash: h2, fileName: 'b.pdf', filePath: '/b.pdf', pageCount: 5 }, blob: null, now: 2000 });
    // manifest 부분 쓰기 손상 → loadManifest 가 [] 로 리셋되는 상황 모사
    V.files.set(`${DIR}/manifest.json`, '{corrupt');
    const r = await reconcileSessions(DIR, 5000);
    expect(r).toEqual({ registered: 2, removed: 0, repaired: 0 });
    const list = await listSessionsOk(DIR);
    expect(list.map((e) => e.docHash).sort()).toEqual([h1, h2].sort());
    const e1 = list.find((e) => e.docHash === h1)!;
    expect(e1.fileName).toBe('a.pdf');           // session.json 본문 기준 재구성
    expect(e1.byteSize).toBeGreaterThan(0);      // 디스크 실측 기준
    expect((await sessionStats(DIR)).count).toBe(2);
  });

  it('session.json 부재/손상/docHash 불일치 디렉토리는 회수(removed) — 등록분은 보존', async () => {
    const good = hashOf(11);
    const corrupt = hashOf(12);
    const mismatch = hashOf(13);
    const empty = hashOf(14);
    await writeSession(DIR, { meta: metaOf(good), session: { docHash: good, fileName: 'g.pdf', filePath: '/g.pdf' }, blob: null, now: 1000 });
    V.files.set(p(corrupt, 'session.json'), '{broken');
    V.files.set(p(mismatch, 'session.json'), JSON.stringify({ docHash: hashOf(99), fileName: 'x.pdf', filePath: '/x.pdf' }));
    V.files.set(p(empty, 'index.bin'), Buffer.from([1, 2, 3])); // session.json 없이 blob 만 — 복원 불가 찌꺼기
    const r = await reconcileSessions(DIR, 5000);
    expect(r).toEqual({ registered: 0, removed: 3, repaired: 0 });
    expect(V.files.has(p(corrupt, 'session.json'))).toBe(false);
    expect(V.files.has(p(mismatch, 'session.json'))).toBe(false);
    expect(V.files.has(p(empty, 'index.bin'))).toBe(false);
    expect((await listSessionsOk(DIR)).map((e) => e.docHash)).toEqual([good]);
  });

  it('전부 등록된 상태면 no-op — manifest 재기록 없음', async () => {
    const h = hashOf(21);
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' }, blob: null, now: 1000 });
    vi.mocked(fsp.writeFile).mockClear();
    const r = await reconcileSessions(DIR, 5000);
    expect(r).toEqual({ registered: 0, removed: 0, repaired: 0 });
    expect(vi.mocked(fsp.writeFile)).not.toHaveBeenCalled();
  });

  it('sessions 디렉토리 부재(첫 실행) → {0,0} (throw 없음)', async () => {
    expect(await reconcileSessions(DIR, 1)).toEqual({ registered: 0, removed: 0, repaired: 0 });
  });

  it('사이드카(index.meta.json) chunkMeta 로 chunkCount 복원', async () => {
    const h = hashOf(31);
    V.files.set(p(h, 'session.json'), JSON.stringify({ docHash: h, fileName: 'c.pdf', filePath: '/c.pdf', pageCount: 2, embedModel: 'nomic-embed-text', embedDim: 3 }));
    V.files.set(p(h, 'index.meta.json'), JSON.stringify({ chunkMeta: [{ t: 'a' }, { t: 'b' }, { t: 'c' }] }));
    V.files.set(p(h, 'index.bin'), Buffer.from(new Uint8Array(36)));
    const r = await reconcileSessions(DIR, 5000);
    expect(r.registered).toBe(1);
    const entry = (await listSessionsOk(DIR)).find((e) => e.docHash === h)!;
    expect(entry.chunkCount).toBe(3);
    expect(entry.embedModel).toBe('nomic-embed-text');
  });

  // QA7(B-LOW): 크래시로 writeFileAtomic tmp→rename 사이에 죽으면 stray *.tmp 잔존 → 정리.
  it('stray *.tmp 잔존물 정리 — 루트 manifest.tmp + 세션 디렉토리 사이드카 tmp (등록 세션도)', async () => {
    const h = hashOf(41);
    await writeSession(DIR, { meta: metaOf(h), session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' }, blob: null, now: 1000 });
    // 크래시 잔존물 모사
    V.files.set(`${DIR}/manifest.json.tmp`, '{partial');
    V.files.set(p(h, 'session.json.tmp'), '{partial');
    V.files.set(p(h, 'index.bin.tmp'), Buffer.from([9, 9]));
    V.files.set(p(h, 'index.meta.json.tmp'), '{partial');
    await reconcileSessions(DIR, 5000);
    expect(V.files.has(`${DIR}/manifest.json.tmp`)).toBe(false);
    expect(V.files.has(p(h, 'session.json.tmp'))).toBe(false);
    expect(V.files.has(p(h, 'index.bin.tmp'))).toBe(false);
    expect(V.files.has(p(h, 'index.meta.json.tmp'))).toBe(false);
    // 실제 세션 파일은 보존
    expect(V.files.has(p(h, 'session.json'))).toBe(true);
  });
});

// QA26(C-Important): "엔트리는 인덱스를 주장하는데 디스크에는 없는" 상태의 생성·회수.
//
// 이 상태가 위험한 이유는 전파가 전부 무음이기 때문이다 — 의미검색은 blob 부재로 그 문서를
// 결과에서 빼면서 excludedCount 에도 넣지 않아 사용자는 "관련 내용이 없다" 로 읽고, 컬렉션
// Q&A 는 ready 배지를 켠 채 그 문서를 빼고 답한다(조용한 오답).
describe('인덱스 거짓 주장 (QA26)', () => {
  const p = (h: string, f: string) => `${DIR}/${h}/${f}`;
  const claimsIndex = (e: { embedModel: string | null; chunkCount: number }) =>
    e.embedModel !== null || e.chunkCount > 0;

  it('blob 없이 갱신하면 엔트리도 인덱스 없음으로 정규화된다 (생성 차단)', async () => {
    const h = hashOf(90);
    // 1차: 인덱스와 함께 저장
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' },
      blob: new ArrayBuffer(8),
      now: 1000,
    });
    expect(claimsIndex((await listSessionsOk(DIR))[0]!)).toBe(true);

    // 2차: blob 없이 갱신 — index.bin 이 지워지므로 주장도 사라져야 한다.
    await writeSession(DIR, {
      meta: metaOf(h), // 렌더러가 인덱스를 주장하는 meta 를 보내더라도
      session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' },
      blob: null,
      now: 2000,
    });
    const entry = (await listSessionsOk(DIR))[0]!;
    expect(claimsIndex(entry), 'index.bin 을 지웠는데 엔트리가 인덱스를 주장하면 조용한 오답이 된다').toBe(false);
    expect(V.files.has(p(h, 'index.bin'))).toBe(false);
  });

  it('부팅 reconcile 이 거짓 주장을 회수한다 (크래시·부분삭제로 이미 생긴 것)', async () => {
    const h = hashOf(91);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' },
      blob: new ArrayBuffer(8),
      now: 1000,
    });
    expect(claimsIndex((await listSessionsOk(DIR))[0]!)).toBe(true);

    // 크래시/EBUSY 부분삭제 재현 — manifest 는 그대로인데 index.bin 만 사라진다.
    V.files.delete(p(h, 'index.bin'));

    const r = await reconcileSessions(DIR, 5000);
    expect(r.repaired).toBe(1);
    const entry = (await listSessionsOk(DIR))[0]!;
    expect(claimsIndex(entry)).toBe(false);
    // "chunkMeta 는 있고 blob 은 없는" 상태를 남기지 않는다(writeSession 과 동일 규칙).
    expect(V.files.has(p(h, 'index.meta.json'))).toBe(false);
  });

  it('QA28(A-Low): 거짓 주장 회수 시 byteSize 도 남은 파일(session.json)만의 실측으로 교정된다', async () => {
    // known 분기는 index.bin 부재 + 사이드카 삭제 뒤에도 옛 합계(json+bin+meta)를 그대로 두었다 —
    // enforceLru 가 이 합계를 쓰므로 존재하지 않는 바이트만큼 다른 세션이 조기 evict 된다.
    const h = hashOf(96);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: {
        docHash: h, fileName: 'a.pdf', filePath: '/a.pdf',
        embedModel: 'nomic-embed-text', embedDim: 3,
        chunkMeta: [{ text: 'A', index: 0, pageStart: 1 }, { text: 'B', index: 1, pageStart: 2 }],
      },
      blob: new ArrayBuffer(4096),
      now: 1000,
    });
    const stale = (await listSessionsOk(DIR))[0]!.byteSize;
    expect(V.files.has(p(h, 'index.meta.json'))).toBe(true); // 사이드카 존재
    V.files.delete(p(h, 'index.bin'));

    const r = await reconcileSessions(DIR, 5000);
    expect(r.repaired).toBe(1);
    const entry = (await listSessionsOk(DIR))[0]!;
    const jsonOnly = Buffer.byteLength(V.files.get(p(h, 'session.json')) as string);
    expect(V.files.has(p(h, 'index.meta.json'))).toBe(false);
    expect(entry.byteSize).toBe(jsonOnly);
    expect(entry.byteSize).toBeLessThan(stale);
  });

  it('인덱스가 멀쩡하면 건드리지 않는다', async () => {
    const h = hashOf(92);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' },
      blob: new ArrayBuffer(8),
      now: 1000,
    });
    const r = await reconcileSessions(DIR, 5000);
    expect(r.repaired).toBe(0);
    expect(claimsIndex((await listSessionsOk(DIR))[0]!)).toBe(true);
  });

  it('애초에 인덱스를 주장하지 않는 엔트리는 stat 조차 하지 않는다 (부팅 비용)', async () => {
    const h = hashOf(93);
    await writeSession(DIR, {
      meta: { ...metaOf(h), embedModel: null, embedDim: null, chunkCount: 0 },
      session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' },
      blob: null,
      now: 1000,
    });
    // QA27(D-Low): 제목은 "stat 조차 하지 않는다" 인데 결과 객체만 보고 있었다 — 회수 로직이
    // 매 부팅 전 세션을 stat 해도 그린이었다. 실제로 stat 이 불리지 않는지 관측한다.
    const statSpy = vi.spyOn(fsp, 'stat');
    try {
      const r = await reconcileSessions(DIR, 5000);
      expect(r).toEqual({ registered: 0, removed: 0, repaired: 0 });
      expect(statSpy.mock.calls.some(([p]) => String(p).endsWith('index.bin'))).toBe(false);
    } finally {
      statSpy.mockRestore();
    }
  });

  it('QA27(A-Important): 고아 재등록도 index.bin 이 없으면 인덱스를 주장하지 않는다', async () => {
    // 크래시로 "session.json + 사이드카는 있고 index.bin 은 없는" 고아가 남은 상태.
    // 회수해야 할 reconcile 이 거짓 주장의 **생산자**가 되면 안 된다.
    const h = hashOf(94);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: {
        docHash: h, fileName: 'a.pdf', filePath: '/a.pdf',
        embedModel: 'nomic-embed-text', embedDim: 3,
        chunkMeta: [{ text: 'A', index: 0, pageStart: 1 }, { text: 'B', index: 1, pageStart: 2 }],
      },
      blob: new ArrayBuffer(8),
      now: 1000,
    });
    // manifest 에서 엔트리를 지워 "고아 디렉터리" 로 만든다(manifest 손상 리셋 재현) + index.bin 소실
    V.files.delete(`${DIR}/manifest.json`);
    V.files.delete(p(h, 'index.bin'));

    const r = await reconcileSessions(DIR, 5000);
    expect(r.registered).toBe(1);
    const entry = (await listSessionsOk(DIR))[0]!;
    expect(claimsIndex(entry), 'index.bin 이 없는데 재등록 엔트리가 인덱스를 주장하면 조용한 누락이 된다').toBe(false);
    // "chunkMeta 는 있고 blob 은 없는" 짝도 남기지 않는다(writeSession·known 분기와 동일 규칙).
    expect(V.files.has(p(h, 'index.meta.json'))).toBe(false);
  });

  it('QA27(A-Important): index.bin 이 온전한 고아는 인덱스 메타를 보존한 채 재등록된다', async () => {
    const h = hashOf(95);
    await writeSession(DIR, {
      meta: metaOf(h),
      session: {
        docHash: h, fileName: 'a.pdf', filePath: '/a.pdf',
        embedModel: 'nomic-embed-text', embedDim: 3,
        chunkMeta: [{ text: 'A', index: 0, pageStart: 1 }, { text: 'B', index: 1, pageStart: 2 }],
      },
      blob: new ArrayBuffer(8),
      now: 1000,
    });
    V.files.delete(`${DIR}/manifest.json`);

    const r = await reconcileSessions(DIR, 5000);
    expect(r.registered).toBe(1);
    const entry = (await listSessionsOk(DIR))[0]!;
    expect(claimsIndex(entry)).toBe(true);
    expect(entry.embedModel).toBe('nomic-embed-text');
    expect(entry.chunkCount).toBe(2);
  });
});

describe('reconcileSessions — 일시 I/O 오류에 디스크를 확정하지 않는다 (QA27 C-Important)', () => {
  it.each(['EBUSY', 'EACCES', 'EPERM'])('manifest 읽기 %s 면 재구축 없이 종료한다', async (code) => {
    // 흡수형 로더였을 때: manifest 읽기 실패 → {entries: []} 를 기준으로 전 디렉터리를 고아로
    // 재등록하는데, 그중 session.json 읽기가 함께 실패한 것은 `continue` 로 빠진다. 기준이
    // 비어 있으므로 그 continue 는 보존이 아니라 **누락**이고, 그 상태가 디스크에 확정된다.
    const a = hashOf(96);
    const b = hashOf(97);
    for (const h of [a, b]) {
      await writeSession(DIR, {
        meta: metaOf(h), session: { docHash: h, fileName: `${h}.pdf`, filePath: `/${h}.pdf` },
        blob: null, now: 1000,
      });
    }
    const before = V.files.get(`${DIR}/manifest.json`);

    const err: NodeJS.ErrnoException = Object.assign(new Error(code), { code });
    const spy = vi.spyOn(fsp, 'readFile').mockRejectedValueOnce(err); // manifest 읽기만 1회 실패
    try {
      const r = await reconcileSessions(DIR, 5000);
      expect(r).toEqual({ registered: 0, removed: 0, repaired: 0 });
    } finally {
      spy.mockRestore();
    }
    // manifest 는 손대지 않았어야 한다 — 두 세션 모두 그대로 살아 있다.
    expect(V.files.get(`${DIR}/manifest.json`)).toBe(before);
    const list = await listSessionsOk(DIR);
    expect(list.map((e) => e.docHash).sort()).toEqual([a, b].sort());
  });

  it('manifest 부재(ENOENT)는 종전대로 진행한다 — 그건 실제로 "없음" 이 맞다', async () => {
    const h = hashOf(98);
    await writeSession(DIR, {
      meta: metaOf(h), session: { docHash: h, fileName: 'a.pdf', filePath: '/a.pdf' },
      blob: null, now: 1000,
    });
    V.files.delete(`${DIR}/manifest.json`);
    const r = await reconcileSessions(DIR, 5000);
    expect(r.registered).toBe(1);
  });
});
