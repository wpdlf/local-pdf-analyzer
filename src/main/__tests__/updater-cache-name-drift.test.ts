import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { APP_PACKAGE_NAME, UPDATER_CACHE_DIR_NAME } from '../../shared/constants';

/**
 * QA24(A-L2/B-M2): `clearUpdaterCache` 는 `%LOCALAPPDATA%\<name>-updater` 를 **재귀 삭제**한다.
 * electron-updater 가 이 경로를 API 로 노출하지 않아 규약으로 계산할 수밖에 없는데, 종전
 * 가드는 자기가 붙인 리터럴을 검사하는 항진명제라 실제 위험(이름이 빌더와 어긋남)을 전혀
 * 막지 못했다. 어긋나면 결과는 **무음 no-op** — 손상 캐시가 그대로 남아 이 함수가 고치려던
 * 버그가 재현되고, 아무 로그도 남지 않는다.
 *
 * 규약 출처(실물 대조, app-builder-lib/out/appInfo.js):
 *   updaterCacheDirName = sanitizeFileName(metadata.name).toLowerCase() + '-updater'
 * 여기서 metadata.name 은 **package.json 의 `name`** 이다 — `productName` 이 아니다.
 * electron 의 `app.getName()` 은 productName 이 있으면 그쪽을 반환하므로 출처로 쓸 수 없다.
 */
describe('updater 캐시 디렉터리 이름 — package.json drift 가드', () => {
  const pkg = JSON.parse(
    readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
  ) as { name: string; productName?: string; build?: { productName?: string } };

  it('APP_PACKAGE_NAME 이 package.json 의 name 과 일치한다', () => {
    expect(
      APP_PACKAGE_NAME,
      'package.json 의 name 을 바꿨다면 이 상수도 함께 바꿔야 한다 — 어긋나면 캐시 정리가 영구 no-op 이 된다',
    ).toBe(pkg.name);
  });

  it('electron-builder 의 updaterCacheDirName 규약(name 소문자 + "-updater")을 재현한다', () => {
    expect(UPDATER_CACHE_DIR_NAME).toBe(`${pkg.name.toLowerCase()}-updater`);
  });

  // 루트 productName 이 생기면 app.getName() 이 그쪽을 반환하게 되어, 과거 구현처럼
  // app.getName() 을 쓰는 코드가 다시 들어오면 무음으로 어긋난다. 승격 시도 자체를 잡는다.
  // (build.productName = "PDF 자료 분석기" 가 있어 루트로 올리고 싶은 유혹이 실재한다.)
  it('루트 package.json 에 productName 이 없다 — 있으면 캐시 이름 계산의 전제가 깨진다', () => {
    expect(
      pkg.productName,
      '루트에 productName 을 추가하려면 clearUpdaterCache 의 이름 계산을 함께 재검토할 것',
    ).toBeUndefined();
  });

  it('name 에 대문자가 없다 — 빌더만 toLowerCase 를 적용하므로 갈릴 수 있다', () => {
    expect(pkg.name).toBe(pkg.name.toLowerCase());
  });
});
