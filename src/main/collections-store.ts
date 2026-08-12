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
    // QA6-B: rename 전 fsync(best-effort) — 전원 차단 시 0바이트/절단 파일 방지. 컬렉션 파일은
    // 손상 1회에 전량 리셋되는 단일 실패점이라 소형 파일 한정으로 동기화(session-store 와 동일 정책).
    try {
      const fh = await fsp.open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch { /* fsync 불가 환경(테스트 모킹 등) — best-effort */ }
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

/**
 * 실제 I/O 오류(EBUSY/EACCES/EPERM/EMFILE 등)와 "부재(ENOENT)"·"손상(JSON 파싱 실패)"를 구분.
 * session-store.ts / api-keys-store.ts 와 동일 정의 — 세 스토어가 같은 원칙을 공유한다.
 */
function isRealIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== 'ENOENT';
}

/**
 * collections.json 로드 — **일시 I/O 오류를 삼키지 않는다**. 부재(ENOENT)·손상(JSON 파싱 실패)만
 * 빈 목록으로 자가치유한다.
 *
 * QA22(C-MED, 데이터손실): QA21 이 세션 manifest 에 대해 정확히 이 결함을 진단하고
 * `loadManifestForWrite` 로 고쳤는데, **형제 스토어인 이 파일에는 이식하지 않았다**
 * (api-keys-store 의 readForWrite, session-store 의 loadManifestForWrite 는 있고 여기만 없었다).
 *
 * 흡수형(모든 실패 → `[]`) 로더를 read-modify-write 의 read 쪽에 쓰면 읽기가 EBUSY/EPERM 으로
 * **한 번만** 실패해도:
 *  - saveCollection: `[]` + 신규 1건 → 저장돼 있던 **모든 컬렉션이 소실**
 *  - deleteCollection: `[].filter(...)` → `saveFile([])` → **파일을 통째로 비우면서 {ok:true} 반환**
 * 세션은 부팅 시 reconcileSessions 가 디렉터리에서 회수하지만 **collections.json 은 유일한
 * 사본이라 회수 경로가 아예 없다** — 세션보다 나쁘다. 일시 오류면 throw → 호출자의 try/catch 가
 * {ok:false} 로 귀결돼 디스크를 보존한다.
 *
 * QA23(D-LOW, 조용한 오답): 읽기 전용 경로(listCollections)도 같은 규칙을 쓴다. 흡수형이면 UI 가
 * EBUSY 한 번에 "저장된 컬렉션이 없습니다 + 만드는 방법 안내"를 **단정적으로** 표시해 사용자는
 * 전량 소실로 읽는다. 그래서 흡수형 로더는 아예 두지 않는다(잘못 골라 쓸 여지 차단).
 */
async function loadCollections(filePath: string): Promise<SavedCollection[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CollectionStoreFile;
    if (!parsed || !Array.isArray(parsed.collections)) return [];
    // QA24(C-M3): **상위 스키마 다운그레이드 방어**. normalizeCollection 은 알려진 5개 필드만
    // 재구성하므로, 상위 버전에서 필드가 추가된 파일을 이 버전이 읽고 다시 쓰면 신규 필드가
    // 디스크에서 **영구 제거**된다. 종전에는 저장·삭제 때만 그 위험이 있었는데, v1.0.1 이
    // `touchCollection`(열기마다 전체 목록 재기록)을 추가하면서 **읽기 성격의 동작으로 확대**됐다 —
    // 컬렉션을 열기만 해도 파일이 정규화된 형태로 덮어써진다. collections.json 은 유일 사본이라
    // 회수 경로가 없으므로, 모르는 상위 버전은 읽지도 쓰지도 않는다(호출자는 "불러오지 못함"
    // 으로 표시 — 빈 목록으로 단정하는 것보다 정직하다).
    if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > COLLECTION_SCHEMA_VERSION) {
      // `code` 를 붙여야 아래 catch 의 isRealIoError 가 전파시킨다 — 붙이지 않으면 "손상 JSON"
      // 으로 흡수돼 빈 목록이 반환되고, 그 위에 저장이 얹히면 방어하려던 파괴가 그대로 일어난다.
      throw Object.assign(
        new Error(
          `collections.json schemaVersion ${parsed.schemaVersion} > ${COLLECTION_SCHEMA_VERSION} — 상위 버전 파일이라 읽지 않습니다`,
        ),
        { code: 'ESCHEMAVERSION' },
      );
    }
    // COLLECTION_SCHEMA_VERSION 을 올릴 때는 여기서 parsed.schemaVersion 에 따라 마이그레이션을
    // 수행할 것 — 지금은 normalizeCollection 이 누락 필드를 보정하므로 v1 한정으로 무손실.
    return parsed.collections
      .map(normalizeCollection)
      .filter((c): c is SavedCollection => c !== null);
  } catch (err) {
    // JSON 파싱 오류는 code 가 없어 isRealIoError=false → 종전대로 빈 목록으로 자가치유.
    if (isRealIoError(err)) throw err;
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

/**
 * 컬렉션 목록 — lastAccessed 내림차순(최근 먼저). 일시 I/O 오류는 전파한다(loadCollections 주석).
 */
export async function listCollections(filePath: string): Promise<SavedCollection[]> {
  const all = await loadCollections(filePath);
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
): Promise<{ ok: boolean; id?: string; evicted?: string[] }> {
  const docHashes = sanitizeHashes(input?.docHashes);
  const name = typeof input?.name === 'string' ? input.name.trim().slice(0, COLLECTION_NAME_MAX) : '';
  if (docHashes.length === 0 || name.length === 0) return { ok: false }; // 빈 멤버/이름은 거부
  const nowIso = new Date(now).toISOString();
  try {
    let collections = await loadCollections(filePath);
    // C5-L(QA cycle5): 저장 시점에도 로드측(normalizeCollection)과 동일한 128자 절단 적용.
    // 비대칭이면 초과 id 저장 시 {ok:true, id:원본} 을 돌려주고 다음 list 는 절단 id 를 반환해
    // 렌더러의 후속 갱신이 별개 항목으로 갈라졌다(정상 흐름은 randomUUID 36자 — 정합성 결함).
    const id = typeof input.id === 'string' && input.id.length > 0 ? input.id.slice(0, 128) : randomUUID();
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
    // QA23(D-MED): 축출은 **완전 무음**이었다 — 세션 LRU 는 QA21 에서 evicted 이름을 반환해
    // 고지하게 했는데 컬렉션만 빠져 있었다. 저장된 컬렉션이 조용히 사라지면 회수 경로가 없다.
    const evicted: string[] = [];
    if (collections.length > COLLECTION_MAX_COUNT) {
      const evictCount = collections.length - COLLECTION_MAX_COUNT;
      const victims = [...collections]
        .filter((c) => c.id !== id)
        .sort((a, b) => a.lastAccessed.localeCompare(b.lastAccessed))
        .slice(0, evictCount);
      const evictIds = new Set(victims.map((c) => c.id));
      evicted.push(...victims.map((c) => c.name));
      collections = collections.filter((c) => !evictIds.has(c.id));
    }
    await saveFile(filePath, collections);
    return { ok: true, id, ...(evicted.length > 0 ? { evicted } : {}) };
  } catch (err) {
    console.warn('[collections] save failed:', (err as Error)?.message);
    return { ok: false };
  }
}

/**
 * 열기 시 `lastAccessed` 갱신(최근 사용 표시) — session-store 의 `touchSession` 과 동일 계약.
 *
 * QA23 에서 "명시 보류" 로 남겼던 항목. `lastAccessed` 는 목록 정렬 키인 **동시에 LRU 축출 키**인데
 * 갱신 지점이 `saveCollection` 하나뿐이었다. 즉 순서가 "최근 연 순" 이 아니라 **"최근 편집한 순"**
 * 이라, 매일 열지만 멤버를 바꾸지 않는 컬렉션은 계속 목록 아래로 밀리다가 50개 상한에서 **가장
 * 먼저 축출**된다. 세션은 load 시 touch 하므로 같은 문제가 없다 — 형제 스토어 중 여기만 빠져 있었다.
 * collections.json 은 유일 사본이라 축출 후 회수 경로가 아예 없다(세션의 reconcileSessions 같은
 * 디렉터리 회수가 불가능).
 *
 * 없는 id 는 **디스크를 다시 쓰지 않고** ok:false — 삭제와 달리 idempotent 성공으로 볼 이유가 없고,
 * 불필요한 재기록은 손상 위험만 늘린다.
 * @param now 갱신 시각(ms) — 테스트 결정성 위해 주입.
 */
export async function touchCollection(
  filePath: string,
  id: unknown,
  now: number,
): Promise<{ ok: boolean }> {
  if (typeof id !== 'string' || id.length === 0) return { ok: false };
  try {
    const collections = await loadCollections(filePath);
    const target = collections.find((c) => c.id === id);
    if (!target) return { ok: false };
    target.lastAccessed = new Date(now).toISOString();
    await saveFile(filePath, collections);
    return { ok: true };
  } catch (err) {
    // best-effort — 일시 I/O 오류로 전체 목록을 잃지 않는다(loadCollections 가 throw → 디스크 보존).
    console.warn('[collections] touch failed:', (err as Error)?.message);
    return { ok: false };
  }
}

/** 컬렉션 삭제. 없는 id 도 ok(idempotent). */
export async function deleteCollection(filePath: string, id: unknown): Promise<{ ok: boolean }> {
  if (typeof id !== 'string' || id.length === 0) return { ok: false };
  try {
    const collections = await loadCollections(filePath);
    const next = collections.filter((c) => c.id !== id);
    await saveFile(filePath, next);
    return { ok: true };
  } catch (err) {
    console.warn('[collections] delete failed:', (err as Error)?.message);
    return { ok: false };
  }
}
