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

/**
 * R42 fix: manifest 의 개별 엔트리 형태를 신뢰하지 않고 정규화한다. loadManifest 는 entries 가
 * 배열인지만 검사했고, 손상된(부분 쓰기/외부 편집) 엔트리의 비문자열 lastAccessed 는
 * enforceLru/listSessions 의 `.localeCompare` 를 throw 시키고(try/catch 없는 session:list·stats
 * 핸들러를 크래시), 비유한 byteSize 는 sessionStats 합산과 200MB LRU 캡을 NaN 으로 무력화한다.
 * 유효 docHash 가 없는 엔트리는 폐기, 나머지는 writeSession 과 동일 규칙으로 좌표를 보정한다.
 */
function normalizeEntry(raw: unknown): SessionManifestEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!isValidDocHash(e.docHash)) return null;
  const safeStr = (v: unknown, cap: number): string => (typeof v === 'string' ? v.slice(0, cap) : '');
  const safeNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  // 정렬·LRU 키는 반드시 문자열이어야 한다. 누락/손상 시 epoch 로 폴백 → 가장 오래된 것으로 취급(fail-safe).
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const lastAccessed = typeof e.lastAccessed === 'string' ? e.lastAccessed : EPOCH;
  return {
    docHash: e.docHash,
    fileName: safeStr(e.fileName, 512),
    filePath: safeStr(e.filePath, 4096),
    pageCount: safeNum(e.pageCount),
    embedModel: typeof e.embedModel === 'string' ? e.embedModel.slice(0, 128) : null,
    embedDim: typeof e.embedDim === 'number' && Number.isFinite(e.embedDim) ? e.embedDim : null,
    chunkCount: safeNum(e.chunkCount),
    byteSize: safeNum(e.byteSize),
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : lastAccessed,
    lastAccessed,
  };
}

export async function loadManifest(sessionsDir: string): Promise<SessionManifest> {
  try {
    const raw = await fsp.readFile(manifestPath(sessionsDir), 'utf-8');
    const parsed = JSON.parse(raw) as SessionManifest;
    if (!parsed || !Array.isArray(parsed.entries)) {
      return { schemaVersion: SESSION_SCHEMA_VERSION, entries: [] };
    }
    const entries = parsed.entries
      .map(normalizeEntry)
      .filter((e): e is SessionManifestEntry => e !== null);
    return { schemaVersion: parsed.schemaVersion ?? SESSION_SCHEMA_VERSION, entries };
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

/**
 * 세션 본문만 로드(인덱스 blob 읽기 생략). 자동저장의 summaries 머지처럼 index.bin(수 MB)이
 * 불필요한 경로에서 turn 당 수~9MB 재읽기·구조화복제를 제거하기 위한 경량 변형(성능).
 */
export async function readSessionMeta(
  sessionsDir: string,
  docHash: string,
): Promise<{ session: unknown } | null> {
  if (!isValidDocHash(docHash)) return null;
  try {
    const raw = await fsp.readFile(path.join(sessionDir(sessionsDir, docHash), SESSION_JSON), 'utf-8');
    return { session: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/** 세션 저장 + manifest upsert + LRU 정리. best-effort — 실패 시 { ok:false }. */
export async function writeSession(
  sessionsDir: string,
  params: { meta: SessionSaveMeta; session: unknown; blob: ArrayBuffer | null; keepIndex?: boolean; now: number },
): Promise<{ ok: boolean }> {
  const { meta, session, blob, keepIndex, now } = params;
  if (!isValidDocHash(meta.docHash)) return { ok: false };
  try {
    const dir = sessionDir(sessionsDir, meta.docHash);
    await fsp.mkdir(dir, { recursive: true });

    const jsonStr = JSON.stringify(session);
    await writeFileAtomic(path.join(dir, SESSION_JSON), jsonStr);
    const indexBinPath = path.join(dir, INDEX_BIN);
    let blobBytes = 0;
    if (keepIndex) {
      // serialize-skip(인덱스 무변경): 기존 index.bin 을 건드리지 않고 보존한다. blob 미전송이지만
      // 아래 null→unlink 분기와 명확히 구분해야 한다 — keepIndex 는 "그대로 둬라", null 은
      // "인덱스 없음, 지워라"라는 서로 다른 계약. byteSize 는 현재 index.bin 크기를 stat 해 반영.
      try { blobBytes = (await fsp.stat(indexBinPath)).size; } catch { blobBytes = 0; }
    } else if (blob) {
      const u8 = new Uint8Array(blob);
      await writeFileAtomic(indexBinPath, u8);
      blobBytes = u8.byteLength;
    } else {
      // R41 fix: blob 없이 갱신 시 이전 index.bin 을 제거한다. 미제거 시 (1) stale 임베딩
      // 인덱스가 디스크에 잔존해 다음 readSession 이 새 session.json 과 옛 index.bin 을 짝지어
      // 차원/모델 불일치 복원을 유발하고, (2) byteSize 가 과소 계상되어 LRU 200MB 캡이 실제
      // 디스크 사용량을 과소평가한다.
      try { await fsp.unlink(indexBinPath); } catch { /* 없으면 무시 */ }
    }
    const byteSize = Buffer.byteLength(jsonStr) + blobBytes;
    const nowIso = new Date(now).toISOString();

    const manifest = await loadManifest(sessionsDir);
    const existing = manifest.entries.find((e) => e.docHash === meta.docHash);
    // R41 fix: 렌더러 제공 meta 필드 서버측 정규화 — 손상된 렌더러의 거대 문자열/비유한 숫자가
    // manifest 를 오염시키거나 enforceLru 의 byteSize 합산을 NaN 으로 무력화하는 것을 차단.
    const safeStr = (v: unknown, cap: number): string => (typeof v === 'string' ? v.slice(0, cap) : '');
    const safeNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    const entry: SessionManifestEntry = {
      docHash: meta.docHash,
      fileName: safeStr(meta.fileName, 512),
      filePath: safeStr(meta.filePath, 4096),
      pageCount: safeNum(meta.pageCount),
      embedModel: typeof meta.embedModel === 'string' ? meta.embedModel.slice(0, 128) : null,
      embedDim: meta.embedDim === null ? null : safeNum(meta.embedDim),
      chunkCount: safeNum(meta.chunkCount),
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

/**
 * 세션의 summaries[type] 한 칸만 병합 저장 (multi-doc Phase 3: 컬렉션 인라인 요약 영속화).
 *
 * 전체 세션 덮어쓰기(writeSession)와 달리 **디스크의 최신 session.json 을 읽어 summaries 한 칸만**
 * 갱신하므로, 비활성 멤버 세션에 cross-write 해도 다른 필드(qa/임베딩/텍스트)를 렌더러 메모리의
 * stale 값으로 덮지 않는다. 호출자(session:saveSummary 핸들러)가 session:save 와 동일한 쓰기
 * mutex 로 직렬화하므로 활성 문서 auto-persist 와도 원자적이다.
 *
 * 세션 부재/손상 시 {ok:false} — 요약을 붙일 본문이 없으므로 호출자는 발췌 fallback 을 유지한다.
 * index.bin(임베딩)은 건드리지 않는다(요약은 임베딩과 무관).
 */
export async function mergeSessionSummary(
  sessionsDir: string,
  docHash: string,
  type: string,
  summary: { content: string; model: string; provider: string },
  now: number,
): Promise<{ ok: boolean }> {
  if (!isValidDocHash(docHash)) return { ok: false };
  if (typeof type !== 'string' || type.length === 0 || type.length > 64) return { ok: false };
  if (!summary || typeof summary.content !== 'string' || summary.content.trim().length === 0) {
    return { ok: false };
  }
  try {
    const dir = sessionDir(sessionsDir, docHash);
    const jsonPath = path.join(dir, SESSION_JSON);
    let session: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') return { ok: false };
      session = parsed as Record<string, unknown>;
    } catch {
      return { ok: false }; // 세션 부재/손상 → 인라인 영속화 skip(호출자 발췌 유지)
    }
    const summaries = (session.summaries && typeof session.summaries === 'object')
      ? session.summaries as Record<string, unknown>
      : {};
    // 렌더러 제공 필드 정규화(거대 문자열/비문자열 방어) — writeSession meta 정규화와 동일 정신.
    summaries[type] = {
      content: summary.content,
      model: typeof summary.model === 'string' ? summary.model.slice(0, 128) : '',
      provider: typeof summary.provider === 'string' ? summary.provider.slice(0, 64) : '',
    };
    session.summaries = summaries;
    const jsonStr = JSON.stringify(session);
    await writeFileAtomic(jsonPath, jsonStr);

    // manifest: lastAccessed 갱신 + byteSize 재계산(json + 기존 index.bin). 엔트리 없으면 skip(고아 best-effort).
    let blobBytes = 0;
    try { blobBytes = (await fsp.stat(path.join(dir, INDEX_BIN))).size; } catch { blobBytes = 0; }
    const manifest = await loadManifest(sessionsDir);
    const entry = manifest.entries.find((e) => e.docHash === docHash);
    if (entry) {
      entry.byteSize = Buffer.byteLength(jsonStr) + blobBytes;
      entry.lastAccessed = new Date(now).toISOString();
      await saveManifest(sessionsDir, manifest);
    }
    return { ok: true };
  } catch (err) {
    console.warn('[session] summary merge failed:', (err as Error)?.message);
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
