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
import { MAX_SUMMARY_TYPE_LEN } from '../shared/constants';

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

async function readManifest(sessionsDir: string, throwOnIoError: boolean): Promise<SessionManifest> {
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
    // QA21(C-MED): RMW 호출자에게는 일시 I/O 오류를 전파한다(아래 loadManifestForWrite 주석 참조).
    // JSON 파싱 오류는 code 가 없어 isRealIoError=false → 종전대로 빈 manifest 로 자가치유.
    if (throwOnIoError && isRealIoError(err)) throw err;
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn('[session] manifest load failed, resetting:', (err as Error)?.message);
    }
    return { schemaVersion: SESSION_SCHEMA_VERSION, entries: [] };
  }
}

/** 읽기 전용 경로(목록·통계·reconcile)용 — 어떤 실패든 빈 manifest 로 흡수한다. */
export async function loadManifest(sessionsDir: string): Promise<SessionManifest> {
  return readManifest(sessionsDir, false);
}

/**
 * read-modify-write 경로 전용 manifest 읽기 — **일시 I/O 오류를 삼키지 않는다**.
 *
 * QA21(C-MED, 데이터손실): 이 파일은 "부재(ENOENT)·손상 ≠ 일시 I/O 오류" 원칙을 세우고
 * (isRealIoError, api-keys-store 의 readForWrite) 세션 본문·index.bin·api-keys 읽기에 전부
 * 적용했는데 **manifest 읽기만 예외**였다. loadManifest 는 모든 에러를 `{entries: []}` 로
 * 흡수하는데, 그 함수가 6개 RMW 경로의 read 쪽이다.
 *
 * 결과: manifest.json 읽기가 EBUSY/EPERM 으로 **한 번만** 실패해도 그 직후의 writeSession 이
 * "현재 문서 1건만 담긴 manifest" 를 디스크에 확정한다 — 다른 모든 세션이 디렉터리는 남은 채
 * 최근목록·전역검색·의미검색·LRU 집계에서 조용히 증발한다(deleteSession 은 더 나빠서
 * saveManifest([]) 로 통째로 비운다). 자동저장이 1.5초 디바운스로 manifest 를 상시 재기록하므로
 * AV·인덱서의 share violation 표적이 되기 쉽다. 부팅 시 reconcileSessions 가 회수하지만
 * 그때까지는 사용자에게 전량 소실로 보인다.
 *
 * 일시 오류면 throw → 호출자의 기존 try/catch 가 {ok:false} 로 귀결돼 **디스크를 보존**한다
 * (세션 본문은 이미 원자적으로 기록됐고 manifest 재기록만 포기하므로, 다음 저장이나 부팅
 * reconcile 이 회수한다). 부재/손상은 종전대로 빈 manifest — 첫 저장이 정상 진행돼야 한다.
 */
async function loadManifestForWrite(sessionsDir: string): Promise<SessionManifest> {
  return readManifest(sessionsDir, true);
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
  /**
   * QA21(C-MED): 보호 대상(열린 탭) docHash — **후보 선정 단계에서** 건너뛴다.
   * 호출자가 결과에서 걸러내는 방식으로는 안 된다: 가장 오래된 항목이 pin 이면 그 라운드에서
   * 아무것도 지우지 못하고, 다음 저장에서도 같은 항목이 후보로 뽑혀 **상한이 영구히 미적용**된다
   * (그 탭이 열려 있는 한 디스크가 무한 증가). 여기서 건너뛰면 그 다음으로 오래된 비보호 항목이
   * 후보가 되어 상한이 계속 유지된다. 보호 대상만 남아 더는 지울 게 없으면 빈 배열 —
   * 상한을 일시 초과하도록 두는 것이 사용자가 보고 있는 문서의 분석 결과를 잃는 것보다 낫다.
   */
  pinned: ReadonlySet<string> = new Set(),
): string[] {
  const sorted = [...entries].sort((a, b) => a.lastAccessed.localeCompare(b.lastAccessed));
  let count = entries.length;
  let total = entries.reduce((sum, e) => sum + e.byteSize, 0);
  const evict: string[] = [];
  for (let i = 0; i < sorted.length && (count > maxCount || total > maxBytes); i++) {
    const e = sorted[i]!;
    if (pinned.has(e.docHash)) continue; // 보호 — count/total 도 줄이지 않는다(여전히 디스크에 있음)
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
  params: {
    meta: SessionSaveMeta; session: unknown; blob: ArrayBuffer | null; keepIndex?: boolean; now: number;
    /**
     * QA21(C-MED): 렌더러에서 지금 **열려 있는 탭**의 docHash 목록. LRU evict 대상에서 제외한다
     * (아래 pin 주석 참조). main 은 탭 상태를 보유하지 않으므로 저장 요청마다 함께 받는다.
     * 미전달(구버전 preload·테스트)이면 종전 동작 — 열린 탭 보호 없음.
     */
    openDocHashes?: unknown;
  },
  // QA21(C-MED): LRU 로 실제 삭제된 세션의 파일명. 지금까지 evict 는 **완전 무음**이었다 —
  // ok:true 로 반환되므로 렌더러의 연속실패 통지망(recordSaveResult)도 통과했고, 사용자는
  // 비활성 탭으로 돌아갔을 때 요약·Q&A 가 통째로 사라진 것을 발견할 뿐 이유를 알 수 없었다
  // (그 데이터는 메모리에 없고 디스크 세션에만 있으므로 영구 소실이다). 호출자가 사용자에게
  // 알릴 수 있도록 결과에 싣는다. 근본 수정(열린 탭 pin)은 별도 — 우선 무음을 없앤다.
): Promise<{ ok: boolean; evicted?: string[]; indexMissing?: boolean }> {
  const { session, blob, keepIndex, now } = params;
  let { meta } = params;
  // 렌더러 입력이므로 신뢰하지 않고 정규화 — 유효 docHash 만 취한다(다른 렌더러 제공 meta 필드와
  // 동일 정책). 손상된 값이 와도 pin 이 과대적용돼 LRU 가 무력화되지 않도록 상한도 둔다.
  const pinnedHashes = new Set(
    (Array.isArray(params.openDocHashes) ? params.openDocHashes : [])
      .filter(isValidDocHash)
      .slice(0, SESSION_MAX_COUNT),
  );
  // keepIndex 인데 디스크에 index.bin 이 없었는가(아래 정규화 참조) — 렌더러가 시그니처를
  // 무효화하고 다음 저장에서 인덱스를 재기록하도록 알린다.
  let indexMissing = false;
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
    const indexBinPath = path.join(dir, INDEX_BIN);
    const indexMetaPath = path.join(dir, INDEX_META);
    // QA24(C-L2, 조용한 오답): 새 인덱스를 쓸 때는 **옛 인덱스를 먼저 치운 뒤** 본문을 기록한다.
    //
    // 종전 순서는 session.json → 사이드카 → index.bin 이었다. 1·2 사이에서 크래시하면 디스크에
    // **새 텍스트 + 옛 index.bin/옛 chunkMeta** 가 남는데, embedModel·embedDim 이 그대로면
    // VectorStore.restore 가 **성공**한다 — 즉 탐지되지 않는다. 그 결과 인용이 옛 청크 좌표를
    // 새 텍스트에 대고 가리켜 **엉뚱한 문장을 근거로 제시**한다(같은 docHash 라도 OCR 재파싱·
    // Vision enrichment 로 pageTexts 가 바뀌므로 실제로 도달 가능한 경로다).
    //
    // 순서만 뒤집어도 해결되지 않는다 — 인덱스를 먼저 쓰면 이번엔 "옛 텍스트 + 새 chunkMeta"
    // 라는 같은 등급의 짝이 남는다. 그래서 **불일치 대신 부재**로 수렴시킨다: 먼저 지우면 어느
    // 지점에서 죽어도 "인덱스 없음"이거나 "완전한 새 짝"이고, 전자는 재오픈 시 재임베딩으로
    // 안전하게 회복된다(아래 사이드카→bin 순서가 이미 채택한 원칙과 같다).
    //
    // 비용: 크래시 시 재임베딩이 필요하고, 성공 경로에도 옛 인덱스가 없는 짧은 창이 생긴다.
    // 같은 docHash 의 쓰기는 그 문서가 활성일 때만 일어나므로 동시 읽기와 겹치지 않는다.
    if (!keepIndex && blob) {
      try { await fsp.unlink(indexBinPath); } catch { /* 없으면 무시 */ }
      try { await fsp.unlink(indexMetaPath); } catch { /* 없으면 무시 */ }
    }
    await writeFileAtomic(path.join(dir, SESSION_JSON), jsonStr);
    let blobBytes = 0;
    let metaBytes = 0;
    const metaStrOf = () => JSON.stringify({ chunkMeta: Array.isArray(chunkMeta) ? chunkMeta : [] });
    if (keepIndex) {
      // serialize-skip(인덱스 무변경): 기존 index.bin·index.meta.json 을 건드리지 않고 보존한다.
      // blob 미전송이지만 아래 null→unlink 분기와 명확히 구분 — keepIndex 는 "그대로 둬라", null 은
      // "인덱스 없음, 지워라". byteSize 는 현재 두 사이드카 크기를 stat 해 반영.
      try { blobBytes = (await fsp.stat(indexBinPath)).size; } catch { blobBytes = 0; }
      // QA21(C-MED, 조용한 오답): keepIndex 의 전제는 "디스크에 index.bin 이 있다" 인데 그걸
      // 검증하지 않았다. 부재해도 blobBytes=0 으로 삼키고 **렌더러가 보낸 인덱스 메타를 그대로
      // manifest 에 기록**해, 디스크에 인덱스가 없는데 "청크 N개 있음" 이라고 주장하는 엔트리가
      // 남았다. 그 거짓 주장은 조용한 누락으로 전파된다:
      //   - semantic-search: 후보 통과 → blob 로드 실패 → 결과에서 빠지고 excludedCount 에도 미집계
      //   - collection: ready 배지 점등 → 컬렉션 Q&A 가 그 문서를 빼고 답변
      // 도달 경로는 LRU evict 로 디렉터리가 지워진 뒤의 keepIndex 저장(그리고 blob 64MB 초과
      // 강등 후 시그니처가 남는 경우).
      //
      // 저장 자체를 실패시키지는 않는다 — session.json 은 이미 기록됐고, 여기서 중단하면
      // manifest 에 등록되지 않은 고아 디렉터리가 남는다(목록·검색·LRU 어디에도 안 잡힘).
      // 대신 ①엔트리의 인덱스 메타를 "없음" 으로 정규화해 거짓 주장을 막고, ②사이드카를 정리해
      // "chunkMeta 는 있고 blob 은 없는" 상태(아래 self-heal 이 만들던, 이 코드가 피하려던 실패
      // 모드)를 남기지 않으며, ③indexMissing 을 반환해 렌더러가 시그니처를 무효화하고 다음
      // 저장에서 blob 을 포함한 전체 저장으로 인덱스를 재기록하게 한다.
      if (blobBytes === 0) {
        try { await fsp.unlink(indexMetaPath); } catch { /* 없으면 무시 */ }
        indexMissing = true;
        meta = { ...meta, embedModel: null, embedDim: null, chunkCount: 0 };
      } else {
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
      // QA26(C-Important): 방금 인덱스를 지웠으므로 엔트리도 "없음" 이어야 한다. 종전에는 렌더러가
      // 보낸 meta 의 embedModel/chunkCount 를 **그대로** manifest 에 썼다 — keepIndex 분기는
      // blobBytes===0 에서 정규화하는데(위) 이 형제 분기만 빠져 있었다. 그러면 크래시 없이도
      // "엔트리는 인덱스를 주장하는데 디스크에는 없는" 상태가 만들어지고, 그 뒤로는 무음이다:
      // 의미검색이 그 문서를 결과에서 빼면서 excludedCount 에도 넣지 않아 사용자는 "관련 내용이
      // 없다" 로 읽는다. 부팅 reconcile 이 회수하지만, 그 전까지는 그대로 쓰인다.
      meta = { ...meta, embedModel: null, embedDim: null, chunkCount: 0 };
    }
    const byteSize = Buffer.byteLength(jsonStr) + blobBytes + metaBytes;
    const nowIso = new Date(now).toISOString();

    const manifest = await loadManifestForWrite(sessionsDir);
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

    const evictedNames: string[] = [];
    const evict = enforceLru(next, SESSION_MAX_COUNT, SESSION_MAX_TOTAL_BYTES, pinnedHashes);
    if (evict.length > 0) {
      // QA21(C-MED, 데이터손실): **열린 탭의 세션은 evict 하지 않는다(pin).**
      // enforceLru 의 보호 대상은 "지금 저장 중인 문서" 하나뿐이었고, main 은 렌더러의 열린 탭
      // 집합을 전혀 몰랐다. 그런데 비활성 탭의 분석 상태(요약·Q&A·인덱스)는 **오직 디스크
      // 세션에만** 존재한다 — tabs.ts 가 탭 전환 시 setSummary(null)/clearQa() 로 메모리를
      // 비우기 때문이다. 따라서 evict 되면 그 탭으로 되돌아갔을 때 세션 복원이 실패하고
      // 재파싱 fallback 을 타도 요약·Q&A·인덱스는 **복구 불가**다. writeSession 이 ok:true 를
      // 반환하므로 렌더러의 연속실패 통지망도 통과해 완전 무음이었다.
      // (Tier3 에서 통지를 먼저 붙였고, 여기가 근본 수정이다.)
      //
      // pin 은 **상한 자체를 무력화하지 않는다** — 열린 탭을 제외하고도 지울 대상이 있으면
      // 그것부터 지운다. 열린 탭만 남아 상한을 넘는 극단(탭을 30개 이상 열어둔 경우)에서는
      // 아무것도 지우지 않고 상한을 일시 초과하도록 둔다: 디스크 초과보다 **사용자가 지금 보고
      // 있는 문서의 분석 결과를 잃는 쪽이 더 비싸다**. 탭을 닫으면 다음 저장에서 정리된다.
      // (실제 제외는 enforceLru 의 **후보 선정 단계**에서 이뤄진다 — 결과에서 걸러내면 가장
      //  오래된 항목이 pin 일 때 매 라운드 같은 후보만 뽑혀 상한이 영구 미적용된다. 이 함정은
      //  회귀 테스트가 잡았다. enforceLru 의 pinned 주석 참조.)
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
          // 삭제 **성공분만** 통지 대상 — rm 실패분은 엔트리가 보존돼 다음 저장에서 재시도되므로
          // 아직 사라진 것이 아니다.
          const gone = next.find((e) => e.docHash === h);
          if (gone?.fileName) evictedNames.push(gone.fileName);
        } catch { /* rm 실패 → 엔트리 보존, 다음 저장에서 재시도 */ }
      }
      manifest.entries = next.filter((e) => !removed.has(e.docHash));
    } else {
      manifest.entries = next;
    }
    manifest.schemaVersion = SESSION_SCHEMA_VERSION;
    await saveManifest(sessionsDir, manifest);
    return {
      ok: true,
      ...(evictedNames.length > 0 ? { evicted: evictedNames } : {}),
      ...(indexMissing ? { indexMissing: true } : {}),
    };
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
  // `custom:<id>` 키(최대 71자)를 64 로 판정해 컬렉션 인라인 요약이 저장되지 않던 문제 — 상한 공유.
  if (typeof type !== 'string' || type.length === 0 || type.length > MAX_SUMMARY_TYPE_LEN) return { ok: false };
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
    // QA24(C-M1): 요약·Q&A 델타 경로는 fsync 한다. writeFileAtomic 의 제외 근거는 "세션 본문/
    // index.bin 은 손상 시 **재계산으로 자가치유**" 인데, 같은 파일에 들어 있는 summaries 와
    // qaMessages 는 재계산이 불가능한 사용자 데이터다(extractedText/pageTexts/인덱스와 다르다).
    // api-keys-store 가 QA21 에서 정확히 이 논증으로 fsync 를 추가했는데 여기엔 이식되지 않았다.
    // 전량 저장(writeSession, 멀티MB × 1.5초 디바운스)은 비용 때문에 종전대로 제외하고,
    // 델타 전용 경로(mergeSessionSummary/patchSession)만 opt-in 한다.
    await writeFileAtomic(jsonPath, jsonStr, { sync: true });

    // manifest: lastAccessed 갱신 + byteSize 재계산(json + 기존 index.bin). 엔트리 없으면 skip(고아 best-effort).
    let blobBytes = 0;
    try { blobBytes = (await fsp.stat(path.join(dir, INDEX_BIN))).size; } catch { blobBytes = 0; }
    try { blobBytes += (await fsp.stat(path.join(dir, INDEX_META))).size; } catch { /* 사이드카 없음 */ }
    const manifest = await loadManifestForWrite(sessionsDir);
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
    // 키 절단 금지: 잘린 키로 저장하면 렌더러가 원본 키로 조회하므로 "저장 성공 + 복원 시 부재"
    // 라는 조용한 소실이 된다. 상한 초과는 정상 경로에서 도달 불가한 malformed 이므로 이 델타만 skip.
    if (summary && typeof summary.type === 'string' && summary.type.length > 0
        && summary.type.length <= MAX_SUMMARY_TYPE_LEN
        && typeof summary.content === 'string' && summary.content.trim().length > 0) {
      const summaries = (session.summaries && typeof session.summaries === 'object')
        ? session.summaries as Record<string, unknown>
        : {};
      summaries[summary.type] = {
        content: summary.content,
        model: typeof summary.model === 'string' ? summary.model.slice(0, 128) : '',
        provider: typeof summary.provider === 'string' ? summary.provider.slice(0, 64) : '',
      };
      session.summaries = summaries;
    }
    if (typeof summaryType === 'string' && summaryType.length > 0 && summaryType.length <= MAX_SUMMARY_TYPE_LEN) {
      session.summaryType = summaryType;
    }
    if (Array.isArray(qaMessages)) session.qaMessages = qaMessages;

    const jsonStr = JSON.stringify(session);
    // QA24(C-M1): 요약·Q&A 델타 경로 — 재계산 불가한 사용자 데이터라 fsync(위 mergeSessionSummary 주석).
    await writeFileAtomic(jsonPath, jsonStr, { sync: true });

    // manifest: lastAccessed 갱신 + byteSize 재계산(json + 기존 index.bin 보존분). 엔트리 없으면
    // skip(고아 best-effort). 인덱스 메타(embedModel/dim/chunkCount)는 무변경이라 그대로 둔다.
    let blobBytes = 0;
    try { blobBytes = (await fsp.stat(path.join(dir, INDEX_BIN))).size; } catch { blobBytes = 0; }
    try { blobBytes += (await fsp.stat(path.join(dir, INDEX_META))).size; } catch { /* 사이드카 없음 */ }
    const manifest = await loadManifestForWrite(sessionsDir);
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
    const manifest = await loadManifestForWrite(sessionsDir);
    const entry = manifest.entries.find((e) => e.docHash === docHash);
    if (!entry) return;
    entry.lastAccessed = new Date(now).toISOString();
    await saveManifest(sessionsDir, manifest);
  } catch { /* best-effort */ }
}

export async function deleteSession(sessionsDir: string, docHash: string): Promise<{ ok: boolean }> {
  if (!isValidDocHash(docHash)) return { ok: false };
  try {
    // QA22(A-LOW): **read 를 파괴 이전에** 한다. QA21 이 loadManifestForWrite 를 throw 가능하게
    // 바꾸면서 호출 순서를 보지 않아, 일시 I/O 오류 시 `rm` 은 이미 끝났는데 manifest 갱신만
    // 실패해 **실체 없는 유령 엔트리**가 남았다. reconcileSessions 는 dirent 를 순회하므로
    // "디렉터리 없는 manifest 엔트리" 는 회수하지 못한다 — LRU 가 그 항목을 evict 후보로 뽑을
    // 때까지 최근목록·통계·byteSize 집계를 오염시킨다. 다른 5개 RMW 경로와 같은
    // read-then-write 순서로 맞추면 일시 오류가 파괴 이전에 중단돼 디스크가 온전히 보존된다.
    const manifest = await loadManifestForWrite(sessionsDir);
    await fsp.rm(sessionDir(sessionsDir, docHash), { recursive: true, force: true });
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
/**
 * 최근 문서 목록 — lastAccessed 내림차순.
 *
 * QA24(C-M2): **일시 I/O 오류를 "세션 없음" 으로 단정하지 않는다**(null 반환). QA23(D-LOW)이
 * `listCollections` 를 같은 이유로 전파형으로 바꿨는데("EBUSY 한 번에 '없습니다' 를 단정적으로
 * 표시하면 사용자가 전량 소실로 읽는다") 세션에는 이식되지 않았다. 여기서 `[]` 를 반환하면:
 *  - 최근 문서 목록이 **빈 채로** 표시되고(사용자는 세션이 날아갔다고 읽는다)
 *  - `use-qa` 의 resolveMembers 가 활성 문서 외 전 멤버를 missing 으로 판정해
 *    **컬렉션 Q&A 가 다른 문서를 빼고 답변한다**(조용한 오답).
 * 부재·손상은 종전대로 빈 목록으로 자가치유한다 — 그건 실제로 "없음" 이 맞다.
 */
export async function listSessions(sessionsDir: string): Promise<SessionManifestEntry[] | null> {
  let manifest: SessionManifest;
  try {
    manifest = await readManifest(sessionsDir, true);
  } catch {
    return null; // 일시 I/O 오류 — "없음" 과 구분해 호출자가 사유를 표시할 수 있게 한다
  }
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
): Promise<{ registered: number; removed: number; repaired: number }> {
  let registered = 0;
  let removed = 0;
  let repaired = 0;
  try {
    let dirents;
    try {
      dirents = await fsp.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      return { registered, removed, repaired }; // 첫 실행(sessions 디렉토리 부재) 등 — 할 일 없음
    }
    const manifest = await loadManifest(sessionsDir);
    const known = new Set(manifest.entries.map((e) => e.docHash));

    // QA7(B-LOW): 크래시/전원차단으로 writeFileAtomic 의 tmp→rename 사이에서 죽으면 stray
    // `*.tmp` 가 남는데, reconcile 은 session.json 존재만 보므로 이들이 영구 잔존했다(정확히
    // 그 파일을 다시 쓸 때까지 자가치유 안 됨). tmp 파일명은 고정이라 readdir 없이 결정적으로
    // unlink 한다 — 루트의 manifest.json.tmp + 각 세션 디렉토리의 3개 사이드카 tmp.
    try { await fsp.unlink(manifestPath(sessionsDir) + '.tmp'); } catch { /* 없으면 무시 */ }
    for (const d of dirents) {
      if (!d.isDirectory() || !DOC_HASH_RE.test(d.name)) continue;
      const cleanupDir = sessionDir(sessionsDir, d.name);
      for (const f of [SESSION_JSON, INDEX_BIN, INDEX_META]) {
        try { await fsp.unlink(path.join(cleanupDir, f) + '.tmp'); } catch { /* 없으면 무시 */ }
      }
      if (known.has(d.name)) {
        // QA26(C-Important): 종전에는 여기서 **무조건** 건너뛰었다. reconcile 이 디렉터리→manifest
        // 방향(고아 재등록)만 보고, manifest→디스크 방향(엔트리 주장의 사실 여부)은 한 번도
        // 검사하지 않았다는 뜻이다.
        //
        // 그런데 "엔트리는 인덱스를 주장하는데 index.bin 이 없는" 상태는 크래시 없이도 생긴다:
        //   - 재파싱 중 전원 차단 — 옛 index.bin 을 먼저 unlink 한 뒤 manifest 를 마지막에 쓴다
        //   - LRU evict 의 부분 삭제 — 재귀 rm 이 자식부터 지우다 EBUSY 로 멈추면 엔트리는 보존된다
        // 이 불일치는 그 문서를 다시 열기 전까지 **영구히** 남고, 전파는 전부 무음이다:
        // 의미검색은 blob 부재로 그 문서를 결과에서 빼면서 excludedCount 에도 넣지 않아 사용자는
        // "관련 내용이 없다" 로 읽고, 컬렉션 Q&A 는 ready 배지를 켠 채 그 문서를 빼고 답한다.
        //
        // writeSession 의 blobBytes===0 정규화와 **같은 규칙**으로 회수한다.
        const entry = manifest.entries.find((e) => e.docHash === d.name);
        const claimsIndex = !!entry && (entry.embedModel !== null || entry.chunkCount > 0);
        if (claimsIndex) {
          let hasBlob = false;
          try {
            const st = await fsp.stat(path.join(sessionDir(sessionsDir, d.name), INDEX_BIN));
            hasBlob = st.size > 0;
          } catch { /* 부재 → 거짓 주장 */ }
          if (!hasBlob) {
            entry.embedModel = null;
            entry.embedDim = null;
            entry.chunkCount = 0;
            // "chunkMeta 는 있고 blob 은 없는" 상태를 남기지 않는다(writeSession 과 동일).
            try { await fsp.unlink(path.join(sessionDir(sessionsDir, d.name), INDEX_META)); } catch { /* 없으면 무시 */ }
            repaired++;
          }
        }
        continue;
      }
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
    if (registered > 0 || repaired > 0) {
      manifest.schemaVersion = SESSION_SCHEMA_VERSION;
      await saveManifest(sessionsDir, manifest);
    }
    return { registered, removed, repaired };
  } catch (err) {
    console.warn('[session] reconcile failed:', (err as Error)?.message);
    return { registered, removed, repaired };
  }
}
