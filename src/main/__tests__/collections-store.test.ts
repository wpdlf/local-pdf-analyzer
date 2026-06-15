import { describe, it, expect, vi, beforeEach } from 'vitest';
import { COLLECTION_MAX_COUNT, type CollectionStoreFile } from '../../shared/collection-types';

// multi-doc Phase 3 module-1 (L1): collections-store 파일 I/O·검증·LRU.
// fs/promises 를 in-memory 가상 FS 로 모킹해 원자적 쓰기·정규화·LRU·삭제를 행위 검증.

const V = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('fs/promises', () => {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const enoent = () => { const e = new Error('ENOENT') as NodeJS.ErrnoException; e.code = 'ENOENT'; return e; };
  return {
    default: {
      writeFile: vi.fn(async (p: string, data: string) => { V.files.set(norm(p), String(data)); }),
      rename: vi.fn(async (a: string, b: string) => {
        const k = norm(a); const v = V.files.get(k);
        if (v === undefined) throw enoent();
        V.files.set(norm(b), v); V.files.delete(k);
      }),
      readFile: vi.fn(async (p: string) => {
        const v = V.files.get(norm(p));
        if (v === undefined) throw enoent();
        return v;
      }),
      unlink: vi.fn(async (p: string) => { V.files.delete(norm(p)); }),
    },
  };
});

import { listCollections, saveCollection, deleteCollection } from '../collections-store';

const FILE = '/tmp/collections.json';
const H = (c: string) => c.repeat(64); // 유효 docHash 헬퍼 (hex 64자)
const T0 = Date.parse('2026-06-15T00:00:00.000Z');

function readFile(): CollectionStoreFile {
  return JSON.parse(V.files.get(FILE) as string) as CollectionStoreFile;
}

beforeEach(() => { V.files.clear(); });

describe('listCollections', () => {
  it('파일 없으면 빈 배열(ENOENT fail-safe)', async () => {
    expect(await listCollections(FILE)).toEqual([]);
  });

  it('lastAccessed 내림차순 정렬', async () => {
    await saveCollection(FILE, { name: 'A', docHashes: [H('a')] }, T0);
    await saveCollection(FILE, { name: 'B', docHashes: [H('b')] }, T0 + 1000);
    const list = await listCollections(FILE);
    expect(list.map((c) => c.name)).toEqual(['B', 'A']); // 최근(B) 먼저
  });

  it('손상 항목(멤버 없음/비배열)은 폐기, 유효 항목만 반환', async () => {
    const corrupt: CollectionStoreFile = {
      schemaVersion: 1,
      collections: [
        { id: '1', name: 'valid', docHashes: [H('a')], createdAt: 'x', lastAccessed: 'x' },
        { id: '2', name: 'no-members', docHashes: [], createdAt: 'x', lastAccessed: 'x' },
        { id: '3', name: 'bad-hash', docHashes: ['not-a-hash'], createdAt: 'x', lastAccessed: 'x' },
      ],
    };
    V.files.set(FILE, JSON.stringify(corrupt));
    const list = await listCollections(FILE);
    expect(list.map((c) => c.name)).toEqual(['valid']);
  });
});

describe('saveCollection', () => {
  it('신규 저장 → id 발급 + 멤버/이름 보존', async () => {
    const r = await saveCollection(FILE, { name: '강의 묶음', docHashes: [H('a'), H('b')] }, T0);
    expect(r.ok).toBe(true);
    expect(typeof r.id).toBe('string');
    const list = await listCollections(FILE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '강의 묶음', docHashes: [H('a'), H('b')] });
  });

  it('id 지정 시 upsert(갱신) — 중복 생성 안 함', async () => {
    const r1 = await saveCollection(FILE, { name: 'v1', docHashes: [H('a')] }, T0);
    const r2 = await saveCollection(FILE, { id: r1.id, name: 'v2', docHashes: [H('a'), H('c')] }, T0 + 1000);
    expect(r2.ok).toBe(true);
    const list = await listCollections(FILE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: r1.id, name: 'v2', docHashes: [H('a'), H('c')] });
  });

  it('멤버 docHash 중복 제거 + 무효 hash 필터', async () => {
    await saveCollection(FILE, { name: 'x', docHashes: [H('a'), H('a'), 'bad', H('b')] }, T0);
    const list = await listCollections(FILE);
    expect(list[0]?.docHashes).toEqual([H('a'), H('b')]);
  });

  it('빈 멤버/빈 이름은 거부 (ok:false)', async () => {
    expect(await saveCollection(FILE, { name: '', docHashes: [H('a')] }, T0)).toEqual({ ok: false });
    expect(await saveCollection(FILE, { name: 'x', docHashes: [] }, T0)).toEqual({ ok: false });
    expect(await saveCollection(FILE, { name: 'x', docHashes: ['bad'] }, T0)).toEqual({ ok: false });
  });

  it('개수 상한 초과 시 가장 오래된 것부터 제거(LRU)', async () => {
    // 유효 hex 64자(인덱스를 2-hex 로 32회 반복) — 각기 다른 docHash + 증가하는 시각
    const hashFor = (i: number) => i.toString(16).padStart(2, '0').repeat(32);
    for (let i = 0; i < COLLECTION_MAX_COUNT + 5; i++) {
      await saveCollection(FILE, { name: `c${i}`, docHashes: [hashFor(i)] }, T0 + i * 1000);
    }
    const file = readFile();
    expect(file.collections.length).toBe(COLLECTION_MAX_COUNT);
    // 가장 오래된 c0 은 제거됨
    expect(file.collections.some((c) => c.name === 'c0')).toBe(false);
  });
});

describe('deleteCollection', () => {
  it('id 로 삭제', async () => {
    const r = await saveCollection(FILE, { name: 'x', docHashes: [H('a')] }, T0);
    expect((await deleteCollection(FILE, r.id!)).ok).toBe(true);
    expect(await listCollections(FILE)).toEqual([]);
  });

  it('없는 id 도 ok (idempotent)', async () => {
    await saveCollection(FILE, { name: 'x', docHashes: [H('a')] }, T0);
    expect((await deleteCollection(FILE, 'nonexistent')).ok).toBe(true);
    expect(await listCollections(FILE)).toHaveLength(1);
  });

  it('빈 id 는 거부', async () => {
    expect(await deleteCollection(FILE, '')).toEqual({ ok: false });
  });
});
