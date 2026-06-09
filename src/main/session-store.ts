import fsp from 'fs/promises';
import path from 'path';
import {
  DOC_HASH_RE,
  SESSION_SCHEMA_VERSION,
  SESSION_MAX_COUNT,
  SESSION_MAX_TOTAL_BYTES,
  type SessionManifest,
  type SessionManifestEntry,
  type SessionSaveMeta,
  type SessionStats,
} from '../shared/session-types';

/**
 * 세션 영속화 — 순수 파일 I/O 헬퍼 (settings-store / api-keys-store 와 동일 패턴).
 *
 * Design Ref: §4 — userData/sessions/ 에 manifest.json + <docHash>/{session.json,index.bin} 저장.
 * electron 비의존(sessionsDir 주입)으로 fs 모킹 기반 단위 테스트 가능. 세션 본문은 opaque(JSON)로
 * 다루고, Main 은 manifest(최근목록·LRU)만 강타입으로 관리한다.
 *
 * 책임:
 * - 원자적 tmp→rename 쓰기, 손상/부재 시 안전 폴백(load → null, 정상 재계산 흐름).
 * - docHash 화이트리스트(/^[a-f0-9]{64}$/)로 경로 traversal 차단.
 * - LRU 상한 초과 시 가장 오래 안 쓴 세션부터 디렉토리 제거.
 */

const SESSION_JSON = 'session.json';
const INDEX_BIN = 'index.bin';

export function isValidDocHash(docHash: unknown): docHash is string {
  return typeof docHash === 'string' && DOC_HASH_RE.test(docHash);
}

function sessionDir(sessionsDir: string, docHash: string): string {
  return path.join(sessionsDir, docHash);
}

function manifestPath(sessionsDir: string): string {
  return path.join(sessionsDir, 'manifest.json');
}

async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const tmp = filePath + '.tmp';
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    try { await fsp.unlink(tmp); } catch { /* 이미 삭제됨 */ }
    throw err;
  }
}

export async function loadManifest(sessionsDir: string): Promise<SessionManifest> {
  try {
    const raw = await fsp.readFile(manifestPath(sessionsDir), 'utf-8');
    const parsed = JSON.parse(raw) as SessionManifest;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { schemaVersion: SESSION_SCHEMA_VERSION, entries: [] };
    }
    return { schemaVersion: parsed.schemaVersion ?? SESSION_SCHEMA_VERSION, entries: parsed.entries };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[session] manifest load failed, resetting:', (err as Error)?.message);
    }
    return { schemaVersion: SESSION_SCHEMA_VERSION, entries: [] };
  }
}

async function saveManifest(sessionsDir: string, manifest: SessionManifest): Promise<void> {
  await fsp.mkdir(sessionsDir, { recursive: true });
  await writeFileAtomic(manifestPath(sessionsDir), JSON.stringify(manifest, null, 2));
}

/**
 * LRU 정리 대상 선정 (순수 함수). 개수/용량 상한을 초과하면 lastAccessed 가 가장 오래된
 * 항목부터 제거 대상으로 반환. Design §3 / Plan Risk: 디스크 무한 증가 차단.
 */
export function enforceLru(
  entries: SessionManifestEntry[],
  maxCount: number = SESSION_MAX_COUNT,
  maxBytes: number = SESSION_MAX_TOTAL_BYTES,
): string[] {
  const sorted = [...entries].sort((a, b) => a.lastAccessed.localeCompare(b.lastAccessed));
  let count = entries.length;
  let total = entries.reduce((sum, e) => sum + e.byteSize, 0);
  const evict: string[] = [];
  for (let i = 0; i < sorted.length && (count > maxCount || total > maxBytes); i++) {
    const e = sorted[i]!;
    evict.push(e.docHash);
    count -= 1;
    total -= e.byteSize;
  }
  return evict;
}

/** 세션 본문 + 인덱스 블롭 로드. 없거나 손상 시 null(blob 만 없으면 blob: null). */
export async function readSession(
  sessionsDir: string,
  docHash: string,
): Promise<{ session: unknown; blob: ArrayBuffer | null } | null> {
  if (!isValidDocHash(docHash)) return null;
  const dir = sessionDir(sessionsDir, docHash);
  let session: unknown;
  try {
    const raw = await fsp.readFile(path.join(dir, SESSION_JSON), 'utf-8');
    session = JSON.parse(raw);
  } catch {
    return null; // 부재/손상 → 정상 재계산 흐름
  }
  let blob: ArrayBuffer | null = null;
  try {
    const buf = await fsp.readFile(path.join(dir, INDEX_BIN));
    blob = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch {
    blob = null; // 인덱스 없으면 텍스트만 복원
  }
  return { session, blob };
}

/** 세션 저장 + manifest upsert + LRU 정리. best-effort — 실패 시 { ok:false }. */
export async function writeSession(
  sessionsDir: string,
  params: { meta: SessionSaveMeta; session: unknown; blob: ArrayBuffer | null; now: number },
): Promise<{ ok: boolean }> {
  const { meta, session, blob, now } = params;
  if (!isValidDocHash(meta.docHash)) return { ok: false };
  try {
    const dir = sessionDir(sessionsDir, meta.docHash);
    await fsp.mkdir(dir, { recursive: true });

    const jsonStr = JSON.stringify(session);
    await writeFileAtomic(path.join(dir, SESSION_JSON), jsonStr);
    let blobBytes = 0;
    if (blob) {
      const u8 = new Uint8Array(blob);
      await writeFileAtomic(path.join(dir, INDEX_BIN), u8);
      blobBytes = u8.byteLength;
    }
    const byteSize = Buffer.byteLength(jsonStr) + blobBytes;
    const nowIso = new Date(now).toISOString();

    const manifest = await loadManifest(sessionsDir);
    const existing = manifest.entries.find((e) => e.docHash === meta.docHash);
    const entry: SessionManifestEntry = {
      docHash: meta.docHash,
      fileName: meta.fileName,
      filePath: meta.filePath,
      pageCount: meta.pageCount,
      embedModel: meta.embedModel,
      embedDim: meta.embedDim,
      chunkCount: meta.chunkCount,
      byteSize,
      createdAt: existing?.createdAt ?? nowIso,
      lastAccessed: nowIso,
    };
    const others = manifest.entries.filter((e) => e.docHash !== meta.docHash);
    const next: SessionManifestEntry[] = [...others, entry];

    const evict = enforceLru(next);
    if (evict.length > 0) {
      const evictSet = new Set(evict.filter((h) => h !== meta.docHash));
      for (const h of evictSet) {
        try { await fsp.rm(sessionDir(sessionsDir, h), { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      manifest.entries = next.filter((e) => !evictSet.has(e.docHash));
    } else {
      manifest.entries = next;
    }
    manifest.schemaVersion = SESSION_SCHEMA_VERSION;
    await saveManifest(sessionsDir, manifest);
    return { ok: true };
  } catch (err) {
    console.warn('[session] save failed:', (err as Error)?.message);
    return { ok: false };
  }
}

/** load 시 lastAccessed 갱신(최근 사용 표시). 실패는 무시(best-effort). */
export async function touchSession(sessionsDir: string, docHash: string, now: number): Promise<void> {
  if (!isValidDocHash(docHash)) return;
  try {
    const manifest = await loadManifest(sessionsDir);
    const entry = manifest.entries.find((e) => e.docHash === docHash);
    if (!entry) return;
    entry.lastAccessed = new Date(now).toISOString();
    await saveManifest(sessionsDir, manifest);
  } catch { /* best-effort */ }
}

export async function deleteSession(sessionsDir: string, docHash: string): Promise<{ ok: boolean }> {
  if (!isValidDocHash(docHash)) return { ok: false };
  try {
    await fsp.rm(sessionDir(sessionsDir, docHash), { recursive: true, force: true });
    const manifest = await loadManifest(sessionsDir);
    manifest.entries = manifest.entries.filter((e) => e.docHash !== docHash);
    await saveManifest(sessionsDir, manifest);
    return { ok: true };
  } catch (err) {
    console.warn('[session] delete failed:', (err as Error)?.message);
    return { ok: false };
  }
}

export async function clearAll(sessionsDir: string): Promise<{ ok: boolean }> {
  try {
    await fsp.rm(sessionsDir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    console.warn('[session] clear failed:', (err as Error)?.message);
    return { ok: false };
  }
}

/** 최근목록(lastAccessed 내림차순). */
export async function listSessions(sessionsDir: string): Promise<SessionManifestEntry[]> {
  const manifest = await loadManifest(sessionsDir);
  return [...manifest.entries].sort((a, b) => b.lastAccessed.localeCompare(a.lastAccessed));
}

export async function sessionStats(sessionsDir: string): Promise<SessionStats> {
  const manifest = await loadManifest(sessionsDir);
  const totalBytes = manifest.entries.reduce((sum, e) => sum + e.byteSize, 0);
  return { count: manifest.entries.length, totalBytes, dir: sessionsDir };
}
