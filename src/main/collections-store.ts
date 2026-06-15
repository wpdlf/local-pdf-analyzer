import fsp from 'fs/promises';
import { randomUUID } from 'node:crypto';
import { DOC_HASH_RE } from '../shared/session-types';
import {
  COLLECTION_SCHEMA_VERSION,
  COLLECTION_MAX_COUNT,
  COLLECTION_MAX_MEMBERS,
  COLLECTION_NAME_MAX,
  type SavedCollection,
  type CollectionStoreFile,
  type CollectionSaveInput,
} from '../shared/collection-types';

/**
 * 컬렉션 영속화 — 순수 파일 I/O 헬퍼 (session-store 와 동일 패턴, electron 비의존).
 *
 * Design Ref: multi-doc-phase3.design.md §2.B, §3.1, §4. filePath 주입으로 fs 모킹 단위 테스트 가능.
 * 책임: 원자적 tmp→rename 쓰기 / 손상·부재 시 안전 폴백(load → []) / docHash 화이트리스트 검증 /
 * 멤버·이름·개수 상한(LRU) 강제.
 */

async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const tmp = filePath + '.tmp';
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* 이미 삭제됨 */ }
    throw err;
  }
}

/** 멤버 docHash 정제 — 유효 hex 64자만, 중복 제거, 상한 컷 */
function sanitizeHashes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of raw) {
    if (typeof h === 'string' && DOC_HASH_RE.test(h) && !seen.has(h)) {
      seen.add(h);
      out.push(h);
      if (out.length >= COLLECTION_MAX_MEMBERS) break;
    }
  }
  return out;
}

/** 손상/외부 편집 항목을 신뢰하지 않고 정규화. 유효 멤버가 없으면 폐기(null). */
function normalizeCollection(raw: unknown): SavedCollection | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const docHashes = sanitizeHashes(c.docHashes);
  if (docHashes.length === 0) return null; // 멤버 없는 컬렉션은 의미 없음
  const id = typeof c.id === 'string' && c.id.length > 0 ? c.id.slice(0, 128) : randomUUID();
  const name = typeof c.name === 'string' && c.name.trim().length > 0
    ? c.name.trim().slice(0, COLLECTION_NAME_MAX)
    : '(untitled)';
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const lastAccessed = typeof c.lastAccessed === 'string' ? c.lastAccessed : EPOCH;
  const createdAt = typeof c.createdAt === 'string' ? c.createdAt : lastAccessed;
  return { id, name, docHashes, createdAt, lastAccessed };
}

async function loadFile(filePath: string): Promise<SavedCollection[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CollectionStoreFile;
    if (!parsed || !Array.isArray(parsed.collections)) return [];
    return parsed.collections
      .map(normalizeCollection)
      .filter((c): c is SavedCollection => c !== null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[collections] load failed, resetting:', (err as Error)?.message);
    }
    return [];
  }
}

async function saveFile(filePath: string, collections: SavedCollection[]): Promise<void> {
  const file: CollectionStoreFile = { schemaVersion: COLLECTION_SCHEMA_VERSION, collections };
  await writeFileAtomic(filePath, JSON.stringify(file, null, 2));
}

/** 컬렉션 목록 — lastAccessed 내림차순(최근 먼저). */
export async function listCollections(filePath: string): Promise<SavedCollection[]> {
  const all = await loadFile(filePath);
  return all.sort((a, b) => b.lastAccessed.localeCompare(a.lastAccessed));
}

/**
 * 컬렉션 upsert. id 가 있으면 갱신, 없으면 신규. 이름·멤버 검증 후 원자적 저장.
 * 개수 상한 초과 시 lastAccessed 가장 오래된 항목부터 제거(LRU).
 * @param now 저장 시각(ms) — 테스트 결정성 위해 주입.
 */
export async function saveCollection(
  filePath: string,
  input: CollectionSaveInput,
  now: number,
): Promise<{ ok: boolean; id?: string }> {
  const docHashes = sanitizeHashes(input?.docHashes);
  const name = typeof input?.name === 'string' ? input.name.trim().slice(0, COLLECTION_NAME_MAX) : '';
  if (docHashes.length === 0 || name.length === 0) return { ok: false }; // 빈 멤버/이름은 거부
  const nowIso = new Date(now).toISOString();
  try {
    let collections = await loadFile(filePath);
    const id = typeof input.id === 'string' && input.id.length > 0 ? input.id : randomUUID();
    const existing = collections.find((c) => c.id === id);
    if (existing) {
      existing.name = name;
      existing.docHashes = docHashes;
      existing.lastAccessed = nowIso;
    } else {
      collections.push({ id, name, docHashes, createdAt: nowIso, lastAccessed: nowIso });
    }
    // LRU: 개수 초과 시 가장 오래된 것부터 제거. 단 방금 저장/갱신한 id 는 절대 제거 대상에서
    // 제외(R47: 동률 lastAccessed 에서 신규 항목이 evict 돼 ok:true 인데 디스크엔 없는 문제 차단).
    if (collections.length > COLLECTION_MAX_COUNT) {
      const evictCount = collections.length - COLLECTION_MAX_COUNT;
      const evictIds = new Set(
        [...collections]
          .filter((c) => c.id !== id)
          .sort((a, b) => a.lastAccessed.localeCompare(b.lastAccessed))
          .slice(0, evictCount)
          .map((c) => c.id),
      );
      collections = collections.filter((c) => !evictIds.has(c.id));
    }
    await saveFile(filePath, collections);
    return { ok: true, id };
  } catch (err) {
    console.warn('[collections] save failed:', (err as Error)?.message);
    return { ok: false };
  }
}

/** 컬렉션 삭제. 없는 id 도 ok(idempotent). */
export async function deleteCollection(filePath: string, id: unknown): Promise<{ ok: boolean }> {
  if (typeof id !== 'string' || id.length === 0) return { ok: false };
  try {
    const collections = await loadFile(filePath);
    const next = collections.filter((c) => c.id !== id);
    await saveFile(filePath, next);
    return { ok: true };
  } catch (err) {
    console.warn('[collections] delete failed:', (err as Error)?.message);
    return { ok: false };
  }
}
