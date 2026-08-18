/**
 * QA25(D-H1/D-I2): 배포물 audit 게이트의 회귀 넷.
 *
 * 이 테스트가 존재하는 이유는 게이트가 **조용히 아무것도 안 잡는 상태로 퇴화**한 전례 때문이다.
 * 이전 게이트는 advisory 의 패키지 이름을 shipped 집합과 그대로 대조해서, 배포 패키지의
 * 전이 의존이 구조적으로 한 건도 매칭되지 않았다(electron-updater → js-yaml high 통과).
 * 그때도 CI 는 초록이었다 — 게이트가 "검사 대상 없음"으로 통과하는 것과 "문제 없음"으로
 * 통과하는 것을 아무도 구분하지 않았기 때문이다.
 *
 * 그래서 이 테스트는 스크립트를 **CI 가 부르는 방식 그대로**(node 서브프로세스 + stdin 파이프)
 * 실행한다. import 해서 순수 함수만 부르면 entry 배선이 죽어도 그린이 되는데, 그 실패 모드가
 * 바로 v1.1.0 에서 겪은 것이다(순수 함수 19건 그린 + 배선 무동작).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../../scripts/audit-shipped.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** CI 와 동일한 호출 형태: `npm audit --json | node scripts/audit-shipped.mjs` */
function runGate(pkg: unknown, lock: unknown, audit: unknown) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock));
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    input: JSON.stringify(audit),
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const highVuln = (title: string) => ({
  severity: 'high',
  range: '<2.0.0',
  // ⚠️ effects 는 의도적으로 비워 둔다. 취약 패키지가 선언 범위 안에서 수정 가능하면 npm 이
  // 실제로 빈 배열을 준다(js-yaml 4.3.0 실측). effects 를 거슬러 올라가는 구현은 이 케이스를
  // 놓치므로, 그런 구현으로 되돌아가면 이 테스트가 빨개져야 한다.
  effects: [],
  via: [{ title }],
});

describe('audit-shipped 게이트', () => {
  it('배포 패키지의 전이 의존에 high 가 있으면 차단한다 (QA25 회귀)', () => {
    const r = runGate(
      { dependencies: { 'root-pkg': '^1.0.0' }, shippedDevDependencies: [] },
      {
        packages: {
          '': { name: 'app' },
          'node_modules/root-pkg': { version: '1.0.0', dependencies: { 'deep-dep': '^1.0.0' } },
          'node_modules/deep-dep': { version: '1.0.0' },
        },
      },
      { vulnerabilities: { 'deep-dep': highVuln('전이 의존 취약점') } },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('deep-dep');
    expect(r.err).toContain('전이 의존 취약점');
  });

  it('shippedDevDependencies 의 전이 의존도 본다', () => {
    const r = runGate(
      { dependencies: {}, shippedDevDependencies: ['bundled-lib'] },
      {
        packages: {
          '': { name: 'app' },
          'node_modules/bundled-lib': { version: '1.0.0', dependencies: { helper: '^1.0.0' } },
          'node_modules/helper': { version: '1.0.0' },
        },
      },
      { vulnerabilities: { helper: highVuln('번들 경유 취약점') } },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('helper');
  });

  it('배포되지 않는 빌드툴의 취약점은 통과시킨다 (노이즈 차단이 이 게이트의 존재 이유)', () => {
    const r = runGate(
      { dependencies: { 'root-pkg': '^1.0.0' }, shippedDevDependencies: [] },
      {
        packages: {
          '': { name: 'app' },
          'node_modules/root-pkg': { version: '1.0.0' },
          'node_modules/build-tool': { version: '1.0.0', dev: true },
        },
      },
      {
        vulnerabilities: {
          'build-tool': { ...highVuln('빌드툴 취약점'), severity: 'critical' },
        },
      },
    );
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('build-tool');
  });

  it('중첩 설치본을 npm 해석 규칙대로 따라간다 (가까운 node_modules 우선)', () => {
    const r = runGate(
      { dependencies: { 'root-pkg': '^1.0.0' }, shippedDevDependencies: [] },
      {
        packages: {
          '': { name: 'app' },
          'node_modules/root-pkg': { version: '1.0.0', dependencies: { shared: '^2.0.0' } },
          // 최상위에도 같은 이름이 있지만 root-pkg 는 자기 밑의 사본을 쓴다.
          'node_modules/shared': { version: '1.0.0' },
          'node_modules/root-pkg/node_modules/shared': {
            version: '2.0.0',
            dependencies: { 'nested-dep': '^1.0.0' },
          },
          'node_modules/nested-dep': { version: '1.0.0' },
        },
      },
      { vulnerabilities: { 'nested-dep': highVuln('중첩 경유 취약점') } },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('nested-dep');
  });

  it('shipped 목록이 비면 설정 실수로 보고 실패시킨다', () => {
    const r = runGate({ dependencies: {}, shippedDevDependencies: [] }, { packages: {} }, {});
    expect(r.code).toBe(1);
    expect(r.err).toContain('shipped 목록이 비어 있다');
  });

  it('audit 입력이 비었으면 skip 한다 (네트워크 실패가 빌드를 막지 않도록)', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '^1' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {} }));
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, input: '', encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('입력 없음');
  });

  it('실제 저장소의 프로덕션 트리가 게이트를 통과한다', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
    // advisory 없는 입력이므로 여기서 보는 것은 "폐포 계산이 실제 lockfile 에서 터지지 않는가".
    const r = runGate(pkg, lock, { vulnerabilities: {} });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('lockfile 에서 못 찾음');
  });
});

describe('워크플로 배선 (QA25 후속)', () => {
  // ⚠️ 이 게이트는 첫 릴리즈 시도에서 **CI 를 통째로 실패시켰다**. 스텝이 bash -o pipefail 로
  // 도는데 `npm audit` 은 권고를 하나라도 찾으면 exit 1 이고(빌드툴 권고는 항상 존재한다),
  // 파이프로 직결하면 게이트 판정과 무관하게 그 코드가 스텝의 결과가 된다. 로컬 셸에는
  // pipefail 이 없어 드러나지 않았다. 두 워크플로가 같은 관용구를 쓰는지 고정한다.
  it('두 워크플로 모두 audit 종료코드를 삼키고 본문만 파이프한다', () => {
    for (const wf of ['.github/workflows/test.yml', '.github/workflows/release.yml']) {
      const src = readFileSync(join(REPO_ROOT, wf), 'utf8');
      expect(src).toContain('audit-shipped.mjs');
      // 파이프 직결이 없어야 한다 — 있으면 npm audit 의 exit 1 이 그대로 스텝 결과가 된다.
      expect(src).not.toContain('npm audit --json 2>/dev/null | node scripts/audit-shipped.mjs');
      // 대신 종료코드를 삼킨 캡처 형태여야 한다.
      expect(src).toMatch(/AUDIT_JSON=\$\(npm audit --json[^)]*\|\| true\)/);
    }
  });
});
