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
 * - save: `.tmp` 경유 + `rename` 으로 원자적 교체, 중간 실패 시 `.tmp` 정리.
 */

export async function loadSettings(
  filePath: string,
  defaults: Record<string, unknown>,
  validKeys: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  try {
    const data = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    // 허용된 키만 로드하여 임의 속성 주입 방지
    const filtered: Record<string, unknown> = {};
    for (const key of Object.keys(parsed)) {
      if (validKeys.has(key)) {
        filtered[key] = parsed[key];
      }
    }
    return { ...defaults, ...filtered };
  } catch (err) {
    // ENOENT(최초 실행 시 파일 없음)는 정상이므로 로그 제외. 그 외(손상된 JSON, 권한 오류 등)는
    // 사용자 리포트 시 진단에 필요 — 한 줄 경고로 가시성 확보.
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
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    try { await fsp.unlink(tmpPath); } catch { /* 이미 삭제됨 */ }
    throw err;
  }
}
