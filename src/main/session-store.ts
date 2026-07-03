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
// chunkMeta(청크 텍스트+페이지) 전용 경량 사이드카 — index.bin 과 동일 생명주기.
// 전역 의미검색(semantic-search)이 멀티MB session.json(extractedText/pageTexts)을 파싱하지 않고
// chunkMeta 만 읽도록 분리(메모리 M2). 저장 시 session.json 에서 분리해 이 파일에 쓰고, 읽기 시
// session.chunkMeta 로 다시 병합해 호출자(복원 경로)는 종전과 동일한 shape 를 본다. 구버전 세션
// (이 파일 없음)은 readSession 이 session.json 의 chunkMeta 로 fallback — 파괴적 마이그레이션 없음.
const INDEX_META = 'index.meta.json';

export function isValidDocHash(docHash: unknown): docHash is string {
  return typeof docHash === 'string' && DOC_HASH_RE.test(docHash);
}

function sessionDir(sessionsDir: string, docHash: string): string {
  return path.join(sessionsDir, docHash);
}

function manifestPath(sessionsDir: string): string {
  return path.join(sessionsDir, 'manifest.json');
}

async function writeFileAtomic(filePath: string, data: string | Uint8Array, options?: { sync?: boolean }): Promise<void> {
  const tmp = filePath + '.tmp';
  try {
    await fsp.writeFile(tmp, data);
    // QA6-B: rename 전 fsync(best-effort) — 저널링 FS 에서 전원 차단 시 rename 메타데이터만
    // 커밋되어 0바이트/절단 파일이 남는 것을 방지. manifest 처럼 "손상 1회=전량 리셋"인 소형
    // 크리티컬 파일만 opt-in(세션 본문/index.bin 은 손상 시 재계산으로 자가치유되고 멀티MB
    // fsync 는 저장 지연이 커서 제외). 실패는 무시 — 원자성(rename)은 그대로 유지된다.
    if (options?.sync) {
      try {
        const fh = await fsp.open(tmp, 'r+');
        try { await fh.sync(); } finally { await fh.close(); }
      } catch { /* fsync 불가 환경(테스트 모킹 등) — best-effort */ }
    }
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
  // sync: manifest 는 손상 시 전 세션이 목록·LRU·검색에서 사라지는 단일 실패점 (QA6-B)
  await writeFileAtomic(manifestPath(sessionsDir), JSON.stringify(manifest, null, 2), { sync: true });
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

/**
 * 실제 I/O 오류(EBUSY/EACCES/EPERM/EMFILE 등)와 "부재(ENOENT)"·"손상(JSON 파싱 실패)"를 구분.
 *
 * QA 발견(영속화 정합성): 읽기 실패를 일괄 null 로 흡수하면, 자동저장의 read-modify-write 경로
 * (full-save 머지·인덱싱 flush)가 일시적 I/O 실패를 "세션 부재"로 오인해 디스크의 타 타입 요약을
 * 덮어쓰거나 멀쩡한 index.bin 을 삭제(R41 회귀의 transient 변형)한다. 실제 I/O 오류는 전파해
 * 호출자가 파괴적 쓰기 대신 보존(저장 건너뜀)하도록 한다. ENOENT/파싱오류는 종전대로 null —
 * 부재는 정상(첫 저장 전), 손상은 재계산으로 자가치유.
 */
function isRealIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== 'ENOENT';
}

/** index.meta.json(사이드카) 의 chunkMeta 만 읽기. 부재 시 null(구버전 → session.json fallback). */
export async function readIndexMeta(
  sessionsDir: string,
  docHash: string,
): Promise<{ chunkMeta: unknown } | null> {
  if (!isValidDocHash(docHash)) return null;
  try {
    const raw = await fsp.readFile(path.join(sessionDir(sessionsDir, docHash), INDEX_META), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as { chunkMeta: unknown };
    return null;
  } catch (err) {
    if (isRealIoError(err)) throw err;
    return null; // 부재/손상 → 구버전 fallback
  }
}

/** index.bin(벡터 blob)만 읽기 — 의미검색이 session.json 파싱 없이 코사인하도록. 부재 시 null. */
export async function readIndexBlob(
  sessionsDir: string,
  docHash: string,
): Promise<ArrayBuffer | null> {
  if (!isValidDocHash(docHash)) return null;
  try {
    const buf = await fsp.readFile(path.join(sessionDir(sessionsDir, docHash), INDEX_BIN));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (err) {
    if (isRealIoError(err)) throw err;
    return null;
  }
}

/** 세션 본문 + 인덱스 블롭 로드. 부재/손상 시 null. 실제 I/O 오류는 throw(호출자 보존 판단). */
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
  } catch (err) {
    if (isRealIoError(err)) throw err; // 일시 I/O 오류 → 전파(호출자가 디스크 보존)
    return null; // 부재(ENOENT)/손상(파싱) → 정상 재계산 흐름
  }
  // chunkMeta 사이드카 병합: 신규 세션은 session.json 에 chunkMeta 가 없고 index.meta.json 에 있다.
  // 호출자(복원)가 session.chunkMeta 를 그대로 쓰도록 여기서 합친다. 구버전(사이드카 없음)은
  // session.json 의 chunkMeta 를 유지(병합 no-op).
  if (session && typeof session === 'object') {
    const indexMeta = await readIndexMeta(sessionsDir, docHash);
    if (indexMeta && Array.isArray(indexMeta.chunkMeta)) {
      (session as Record<string, unknown>).chunkMeta = indexMeta.chunkMeta;
    }
  }
  let blob: ArrayBuffer | null = null;
  try {
    const buf = await fsp.readFile(path.join(dir, INDEX_BIN));
    blob = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (err) {
    if (isRealIoError(err)) throw err; // index.bin 일시 I/O 오류 → 전파(보존). 부재는 null.
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
  } catch (err) {
    if (isRealIoError(err)) throw err; // 일시 I/O 오류 → 전파(호출자가 디스크 보존). 부재/손상은 null.
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

    // chunkMeta 사이드카 분리: session.json 에서 chunkMeta 를 떼어 index.meta.json 으로 보낸다
    // (의미검색이 본문을 파싱하지 않도록, 메모리 M2). 호출자(렌더러)는 종전대로 chunkMeta 를 포함한
    // session 을 보내고, 여기서 분리한다 — 읽기 때 readSession 이 다시 병합하므로 contract 무변경.
    let chunkMeta: unknown = undefined;
    let sessionForDisk: unknown = session;
    if (session && typeof session === 'object') {
      const { chunkMeta: cm, ...rest } = session as Record<string, unknown>;
      chunkMeta = cm;
      sessionForDisk = rest;
    }

    const jsonStr = JSON.stringify(sessionForDisk);
    await writeFileAtomic(path.join(dir, SESSION_JSON), jsonStr);
    const indexBinPath = path.join(dir, INDEX_BIN);
    const indexMetaPath = path.join(dir, INDEX_META);
    let blobBytes = 0;
    let metaBytes = 0;
    const metaStrOf = () => JSON.stringify({ chunkMeta: Array.isArray(chunkMeta) ? chunkMeta : [] });
    if (keepIndex) {
      // serialize-skip(인덱스 무변경): 기존 index.bin·index.meta.json 을 건드리지 않고 보존한다.
      // blob 미전송이지만 아래 null→unlink 분기와 명확히 구분 — keepIndex 는 "그대로 둬라", null 은
      // "인덱스 없음, 지워라". byteSize 는 현재 두 사이드카 크기를 stat 해 반영.
      try { blobBytes = (await fsp.stat(indexBinPath)).size; } catch { blobBytes = 0; }
      try {
        metaBytes = (await fsp.stat(indexMetaPath)).size;
      } catch {
        // QA: 사이드카 부재(구버전 세션이 keepIndex 경로 진입 — session.json 의 chunkMeta 가 위에서
        // strip 되어 사라졌다)면 strip 된 chunkMeta 로 1회 self-heal 생성. "keepIndex ⟹ 사이드카 존재"
        // 불변식을 코드로 봉인해 chunkMeta 영구 소실(→재임베딩/검색 누락)을 차단.
        const metaStr = metaStrOf();
        await writeFileAtomic(indexMetaPath, metaStr);
        metaBytes = Buffer.byteLength(metaStr);
      }
    } else if (blob) {
      // index.bin 과 짝을 이루는 chunkMeta 를 함께 기록(둘 다 새 인덱스 기준).
      // QA(크래시 안전): 사이드카를 먼저 쓰고 index.bin 을 마지막에 기록한다. 중간 크래시 시 blob 이
      // 부재(또는 옛 것)로 귀결돼 재오픈이 throw→재임베딩(또는 옛 짝)으로 안전 수렴 — "blob 있는데
      // chunkMeta 없음" 의 새 실패 모드를 피한다.
      const metaStr = metaStrOf();
      await writeFileAtomic(indexMetaPath, metaStr);
      metaBytes = Buffer.byteLength(metaStr);
      const u8 = new Uint8Array(blob);
      await writeFileAtomic(indexBinPath, u8);
      blobBytes = u8.byteLength;
    } else {
      // R41 fix: blob 없이 갱신 시 이전 index.bin 을 제거한다(stale 임베딩 잔존·byteSize 과소 방지).
      // chunkMeta 사이드카도 함께 제거해 index.bin 과 생명주기를 일치시킨다.
      try { await fsp.unlink(indexBinPath); } catch { /* 없으면 무시 */ }
      try { await fsp.unlink(indexMetaPath); } catch { /* 없으면 무시 */ }
    }
    const byteSize = Buffer.byteLength(jsonStr) + blobBytes + metaBytes;
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
      // QA post-v0.31.14: rm 이 성공한 항목만 manifest 에서 제거한다. 이전엔 rm 결과와 무관하게
      // 무조건 엔트리를 드롭해, Windows 에서 rm 이 EBUSY/EPERM(AV 스캔·동시 session:load/search 가
      // 디렉토리를 잡고 있을 때 — 읽기는 write mutex 밖에서 돈다)으로 실패하면 디렉토리는 디스크에
      // 남는데 manifest 엔트리는 사라져 영구 고아가 됐다(LRU·stats 가 manifest 만 보므로 다시는
      // 제거·집계 안 됨, 디스크 누수). 실패분은 manifest 에 남겨 다음 저장에서 재시도된다.
      const removed = new Set<string>();
      for (const h of evictSet) {
        try {
          await fsp.rm(sessionDir(sessionsDir, h), { recursive: true, force: true });
          removed.add(h);
        } catch { /* rm 실패 → 엔트리 보존, 다음 저장에서 재시도 */ }
      }
      manifest.entries = next.filter((e) => !removed.has(e.docHash));
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
    try { blobBytes += (await fsp.stat(path.join(dir, INDEX_META))).size; } catch { /* 사이드카 없음 */ }
    const manifest = await loadManifest(sessionsDir);
    const entry = manifest.entries.find((e) => e.docHash === docHash);
    if (entry) {
      entry.byteSize = Buffer.byteLength(jsonStr) + blobBytes;
      entry.lastAccessed = new Date(now).toISOString();
      await saveManifest(sessionsDir, manifest);
    } else {
      // QA post-v0.31.15: patchSession 과 대칭 — session.json 은 썼으나 manifest 엔트리가 없으면
      // (manifest 손상 후 [] 리셋 등) ok:true 로 divergent write 를 감추지 않고 ok:false 를 알린다.
      // 현재 유일 호출자(session:saveSummary)는 반환을 무시하지만, patchSession 과 같은 계약으로
      // 맞춰 footgun(디스크엔 있고 목록엔 없는 세션의 조용한 방치)을 제거한다.
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[session] summary merge failed:', (err as Error)?.message);
    return { ok: false };
  }
}

/**
 * 자동저장 부분 패치(serialize-skip 의 짝, Tier3) — 인덱스가 무변경일 때 자동저장이 호출.
 *
 * 불변 본문(extractedText/pageTexts/chunkMeta)·index.bin 을 렌더러가 매 턴 IPC 로 재전송하던 것을
 * 제거한다: 렌더러는 변하는 qa/summary delta 만 보내고, Main 이 디스크 session.json 을 읽어 해당
 * 필드만 교체 후 재기록한다(IPC ~5MB→~50KB). index.bin 은 손대지 않으므로 임베딩 보존.
 *
 * 디스크 세션이 없거나(최초 저장 전·LRU evict) 손상이면 {ok:false} — 호출자(use-session)는 이때
 * 전체 저장(writeSession)으로 폴백해 세션·인덱스를 재생성한다. mergeSessionSummary 와 동일 mutex
 * (serializeSessionWrite)로 직렬화되어 활성 문서 저장·컬렉션 인라인 요약과 원자적이다.
 */
export async function patchSession(
  sessionsDir: string,
  params: {
    docHash: string;
    summary: { type: string; content: string; model: string; provider: string } | null;
    summaryType: string;
    qaMessages: unknown;
    now: number;
  },
): Promise<{ ok: boolean }> {
  const { docHash, summary, summaryType, qaMessages, now } = params;
  if (!isValidDocHash(docHash)) return { ok: false };
  try {
    const dir = sessionDir(sessionsDir, docHash);
    const jsonPath = path.join(dir, SESSION_JSON);
    let session: Record<string, unknown>;
    try {
      const parsed = JSON.parse(await fsp.readFile(jsonPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') return { ok: false };
      session = parsed as Record<string, unknown>;
    } catch {
      return { ok: false }; // 디스크 세션 부재/손상 → 호출자가 전체 저장으로 폴백
    }
    // summary delta — 해당 타입 한 칸만 교체(다른 타입 보존). mergeSessionSummary 와 동일 정규화.
    if (summary && typeof summary.type === 'string' && summary.type.length > 0
        && typeof summary.content === 'string' && summary.content.trim().length > 0) {
      const summaries = (session.summaries && typeof session.summaries === 'object')
        ? session.summaries as Record<string, unknown>
        : {};
      summaries[summary.type.slice(0, 64)] = {
        content: summary.content,
        model: typeof summary.model === 'string' ? summary.model.slice(0, 128) : '',
        provider: typeof summary.provider === 'string' ? summary.provider.slice(0, 64) : '',
      };
      session.summaries = summaries;
    }
    if (typeof summaryType === 'string' && summaryType.length > 0 && summaryType.length <= 64) {
      session.summaryType = summaryType;
    }
    if (Array.isArray(qaMessages)) session.qaMessages = qaMessages;

    const jsonStr = JSON.stringify(session);
    await writeFileAtomic(jsonPath, jsonStr);

    // manifest: lastAccessed 갱신 + byteSize 재계산(json + 기존 index.bin 보존분). 엔트리 없으면
    // skip(고아 best-effort). 인덱스 메타(embedModel/dim/chunkCount)는 무변경이라 그대로 둔다.
    let blobBytes = 0;
    try { blobBytes = (await fsp.stat(path.join(dir, INDEX_BIN))).size; } catch { blobBytes = 0; }
    try { blobBytes += (await fsp.stat(path.join(dir, INDEX_META))).size; } catch { /* 사이드카 없음 */ }
    const manifest = await loadManifest(sessionsDir);
    const entry = manifest.entries.find((e) => e.docHash === docHash);
    if (entry) {
      entry.byteSize = Buffer.byteLength(jsonStr) + blobBytes;
      entry.lastAccessed = new Date(now).toISOString();
      await saveManifest(sessionsDir, manifest);
    } else {
      // QA post-v0.31.14: session.json 은 디스크에 있으나 manifest 엔트리가 없는 경우(manifest
      // 손상 후 [] 리셋 등) ok:true 를 반환하면 호출자(use-session)가 full save 폴백을 하지 않아
      // 활성 세션이 최근목록/검색/stats 에서 영구 누락된다. ok:false 로 알려 호출자가 전체
      // writeSession 으로 폴백 → manifest 엔트리 재등록(use-session.ts:228-231 → api.save).
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn('[session] partial save failed:', (err as Error)?.message);
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

/**
 * 부팅 시 1회 자가치유(QA6-B): manifest 손상 리셋(부분 쓰기/전원 차단 → loadManifest 가 [] 로
 * 복구)이나 개별 엔트리 폐기(normalizeEntry) 후 디스크에 남은 세션 디렉토리는 목록·검색·LRU·
 * stats 에서 영구 제외된 채 잔존했다(재오픈하는 문서만 savePartial ok:false → full-save 폴백으로
 * 자가치유, 나머지는 "전체 삭제" 외 회수 수단 없음 — 최대 수백 MB 디스크 누수). 디렉토리 ↔
 * manifest 를 대조해 유효한 session.json 을 가진 고아는 재등록하고, 본문 부재/손상/정체성
 * 불일치로 어떤 경로로도 복원 불가능한 디렉토리는 제거한다.
 *
 * - 호출자는 세션 쓰기 mutex(serializeSessionWrite)로 직렬화할 것 — saveManifest 원자성.
 * - 일시 I/O 오류(readSessionMeta throw)는 판단 불가로 보존, 다음 부팅에서 재시도.
 * - LRU 는 여기서 강제하지 않는다 — 다음 writeSession 의 enforceLru 가 정상 수렴.
 * - 절대 throw 하지 않는다(부팅 경로 best-effort).
 */
export async function reconcileSessions(
  sessionsDir: string,
  now: number,
): Promise<{ registered: number; removed: number }> {
  let registered = 0;
  let removed = 0;
  try {
    let dirents;
    try {
      dirents = await fsp.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return { registered, removed }; // 첫 실행(sessions 디렉토리 부재) 등 — 할 일 없음
    }
    const manifest = await loadManifest(sessionsDir);
    const known = new Set(manifest.entries.map((e) => e.docHash));
    for (const d of dirents) {
      if (!d.isDirectory() || !DOC_HASH_RE.test(d.name) || known.has(d.name)) continue;
      let meta: { session: unknown } | null = null;
      try {
        meta = await readSessionMeta(sessionsDir, d.name);
      } catch {
        continue; // 일시 I/O 오류 → 판단 불가, 보존
      }
      const s = meta?.session as Record<string, unknown> | null | undefined;
      const restorable = !!s && typeof s === 'object'
        && s.docHash === d.name // 렌더러 복원 가드(session.docHash===docHash)와 동일 — 불일치면 영원히 복원 불가
        && typeof s.fileName === 'string' && typeof s.filePath === 'string';
      const dir = sessionDir(sessionsDir, d.name);
      if (!restorable) {
        // session.json 부재/손상/정체성 불일치 — 어떤 경로로도 사용 불가한 찌꺼기, 회수
        try {
          await fsp.rm(dir, { recursive: true, force: true });
          removed++;
        } catch { /* rm 실패(잠김) → 다음 부팅에서 재시도 */ }
        continue;
      }
      // byteSize·타임스탬프는 디스크 실측 기준으로 재구성
      let byteSize = 0;
      let mtimeIso = new Date(now).toISOString();
      for (const f of [SESSION_JSON, INDEX_BIN, INDEX_META]) {
        try {
          const st = await fsp.stat(path.join(dir, f));
          byteSize += st.size;
          // mtimeMs 비유한(모킹/특수 FS) 시 now 폴백 유지
          if (f === SESSION_JSON && Number.isFinite(st.mtimeMs)) {
            mtimeIso = new Date(st.mtimeMs).toISOString();
          }
        } catch { /* 부재 파일 skip */ }
      }
      // chunkCount: 구버전은 session.json 의 chunkMeta, 신버전은 index.meta.json 사이드카
      let chunkCount = Array.isArray(s.chunkMeta) ? s.chunkMeta.length : 0;
      if (chunkCount === 0) {
        try {
          const im = await readIndexMeta(sessionsDir, d.name);
          if (im && Array.isArray(im.chunkMeta)) chunkCount = im.chunkMeta.length;
        } catch { /* 사이드카 I/O 오류 — chunkCount 0 유지 */ }
      }
      // writeSession 의 meta 정규화와 동일 규칙으로 재등록
      manifest.entries.push({
        docHash: d.name,
        fileName: (s.fileName as string).slice(0, 512),
        filePath: (s.filePath as string).slice(0, 4096),
        pageCount: typeof s.pageCount === 'number' && Number.isFinite(s.pageCount) ? s.pageCount : 0,
        embedModel: typeof s.embedModel === 'string' ? s.embedModel.slice(0, 128) : null,
        embedDim: typeof s.embedDim === 'number' && Number.isFinite(s.embedDim) ? s.embedDim : null,
        chunkCount,
        byteSize,
        createdAt: mtimeIso,
        lastAccessed: mtimeIso, // mtime 기준 — 오래된 고아는 이후 LRU 에서 자연히 먼저 밀린다
      });
      registered++;
    }
    if (registered > 0) {
      manifest.schemaVersion = SESSION_SCHEMA_VERSION;
      await saveManifest(sessionsDir, manifest);
    }
    return { registered, removed };
  } catch (err) {
    console.warn('[session] reconcile failed:', (err as Error)?.message);
    return { registered, removed };
  }
}
