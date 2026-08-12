import fsp from 'fs/promises';

/**
 * Settings 영속화 — 순수 파일 I/O 헬퍼.
 *
 * v0.18.22 Top5 #3 (test coverage): R34 P2 의 settings-keys 단일 출처화 이후에도 loadSettings /
 * saveSettings 자체는 index.ts 내부 함수라 단위 테스트가 불가능했다. 본 모듈은 동일 로직을
 * electron 의존성 없는 pure function 으로 분리하여 fs 모킹 기반 테스트를 가능하게 한다.
 *
 * 책임:
 * - load: 파일 부재(ENOENT) → defaults 반환, 손상 JSON → defaults 로 안전 fallback,
 *   `validKeys` 에 포함된 키만 허용해 임의 속성 주입 차단.
 *   **일시 I/O 오류(EBUSY/EACCES/…)는 삼키지 않고 throw** — QA24(C-H1) 참조.
 * - save: `.tmp` 경유 + `rename` 으로 원자적 교체, 중간 실패 시 `.tmp` 정리.
 */

/**
 * 실제 I/O 오류(EBUSY/EACCES/EPERM/EMFILE 등)와 "부재(ENOENT)"·"손상(JSON 파싱 실패)"를 구분.
 * session-store.ts / collections-store.ts / api-keys-store.ts 와 동일 정의 — 네 스토어가 같은
 * 원칙을 공유한다.
 */
function isRealIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code !== 'ENOENT';
}

export async function loadSettings(
  filePath: string,
  defaults: Record<string, unknown>,
  validKeys: ReadonlySet<string>,
  /**
   * QA22(C-LOW): 값 검증기(선택). 이전에는 키 화이트리스트만 적용하고 **값은 그대로 통과**시켜,
   * 수기 편집/부분 손상된 settings.json 이 렌더러로 유입됐다 — `customSummaryTemplates: "x"`(비배열)
   * 는 `.filter` TypeError 로 설정 화면 렌더를 크래시시키고, `maxChunkSize: "abc"` 는 통합요약
   * 예산 비교를 전부 무력화한다(조용한 품질 저하). settings:set 은 같은 값을 엄격히 검증하는데
   * 로드 경로만 무방비였던 비대칭. 미전달 시 종전 동작(키 필터만).
   */
  validateValue?: (key: string, val: unknown) => { ok: true; value: unknown } | { ok: false },
): Promise<Record<string, unknown>> {
  try {
    const data = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    // 허용된 키만 로드하여 임의 속성 주입 방지
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      if (!validKeys.has(key)) continue;
      if (!validateValue) { filtered[key] = parsed[key]; continue; }
      const r = validateValue(key, parsed[key]);
      // 검증 실패 키는 담지 않는다 → 아래 스프레드에서 defaults 값이 그대로 쓰인다.
      if (r.ok) filtered[key] = r.value;
      else console.warn(`[settings] invalid value for "${key}", using default`);
    }
    return { ...defaults, ...filtered };
  } catch (err) {
    // QA24(C-H1): 일시 I/O 오류를 defaults 로 흡수하면 **설정 전량이 영구 소실**된다.
    // settings:get 이 defaults 를 반환 → 렌더러 스토어가 통째로 기본값 → 사용자가 무엇이든
    // 하나 바꾸는 순간 updateSettings 가 **전체 설정 객체**를 보내고 settings:set 이 그것을
    // 원자적으로 확정한다. 커스텀 요약 템플릿은 유일 사본이라 회수 경로가 없다.
    // 형제 3종(session/collections/api-keys)은 이미 같은 구분을 갖고 있었고 settings 만
    // 네 번째 형제로 남아 있었다. 부재(ENOENT)·손상(JSON 파싱)만 defaults 로 자가치유한다.
    if (isRealIoError(err)) throw err;
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error('[settings] load failed, using defaults:', err);
    }
    return { ...defaults };
  }
}

export async function saveSettings(
  filePath: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const tmpPath = filePath + '.tmp';
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(settings, null, 2), 'utf-8');
    // QA6-B: rename 전 fsync(best-effort) — 전원 차단 시 0바이트/절단 settings 방지
    // (session-store/collections-store 와 동일 정책, 소형 크리티컬 파일 한정).
    try {
      const fh = await fsp.open(tmpPath, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch { /* fsync 불가 환경(테스트 모킹 등) — best-effort */ }
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch { /* 이미 삭제됨 */ }
    throw err;
  }
}
