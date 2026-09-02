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
import { stripYamlComments, readGeneratedText } from './helpers/source-scan';

/**
 * 자식 프로세스 상한.
 *
 * QA26(D-Important): 이 파일은 저장소에서 **유일하게 실제 자식 프로세스를 띄우는** 유닛 파일이다
 * (다른 child_process 사용처는 전부 vi.mock). timeout 이 없으면 자식이 매달릴 때 vitest 의 기본
 * 테스트 상한(5s)을 통째로 먹고, 실패 메시지도 "타임아웃" 뿐이라 원인을 알 수 없다.
 * QA26 라운드에서 커버리지 실행 1회가 원인 미상으로 실패했고 이름을 잡지 못했는데, 이 파일이
 * 유력 후보였다(단독 실행은 커버리지 하에서도 1.0초 — 단정할 근거는 아니지만 방어 비용이 0이다).
 * 자식 상한을 테스트 상한보다 짧게 두어, 매달림이면 자식 쪽에서 먼저 이름 붙은 실패가 나온다.
 */
const SPAWN_TIMEOUT_MS = 15000;

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
  // QA27(D-High): 성공 경로에서 **검사 범위**(폐포 크기·대상 이름)는 stdout 이 아니라
  // GITHUB_STEP_SUMMARY 에만 적힌다. 그것을 주지 않으면 테스트는 종료코드만 보게 되고,
  // 폐포가 통째로 쪼그라들어도(= 취약점을 못 보게 돼도) 전부 초록이다. 파일을 물려 관측한다.
  const summaryPath = join(dir, 'step-summary.md');
  writeFileSync(summaryPath, '');
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    input: JSON.stringify(audit),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
  });
  // 자식이 매달리면 vitest 의 테스트 타임아웃을 통째로 먹고 "어느 단계에서 멈췄는지" 단서 없이
  // 끝난다. 여기서 먼저 끊고 원인을 이름 붙여 던진다.
  if (r.error) throw new Error(`게이트 실행 실패: ${r.error.message}`);
  return {
    code: r.status,
    out: r.stdout ?? '',
    err: r.stderr ?? '',
    // QA30(D2): 생성 산출물(스텝 요약 마크다운) — 소스가 아님을 확장자로 증명하는 통로로 읽는다.
    summary: readGeneratedText(summaryPath),
  };
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

describe('audit-shipped 게이트', { timeout: 30000 }, () => {
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

  it('QA28(D1-4): optionalDependencies 로만 도달하는 취약 패키지도 폐포에 든다', () => {
    // optional 의존은 설치 실패 시 빠질 뿐, 설치되면 번들·asar 에 똑같이 실린다(pdfjs 의
    // @napi-rs/canvas 가 그 예). dependencies 만 따라가면 이 경로가 조용히 검사 밖이 된다.
    const r = runGate(
      { dependencies: {}, shippedDevDependencies: ['bundled-lib'] },
      {
        packages: {
          '': { name: 'app' },
          'node_modules/bundled-lib': { version: '1.0.0', optionalDependencies: { 'opt-native': '^1.0.0' } },
          'node_modules/opt-native': { version: '1.0.0', optional: true },
        },
      },
      { vulnerabilities: { 'opt-native': highVuln('optional 경유 취약점') } },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('opt-native');
    expect(r.err).toContain('optional 경유 취약점');
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

  /**
   * QA29(D2-1): 축퇴 입력 전수.
   *
   * 워크플로는 `AUDIT_JSON=$(npm audit --json 2>/dev/null || true)` 로 **종료코드와 stderr 를
   * 함께 삼킨다**. 그래서 레지스트리 인증 실패·네트워크 플레이크·npm 출력 형식 변경이 전부
   * 여기 있는 네 가지 형태로 도착한다. 실측(수정 전): `''`→exit 0, `not json`→평문 skip exit 0,
   * `{}`→**출력 한 줄 없이** exit 0, `{"error":{…}}`→평문 skip exit 0. 즉 태그 경로의 유일한
   * blocking 공급망 게이트가 흔적 없이 사라질 수 있었다.
   *
   * 이제 넷 다 (a) `::warning::` 를 남기고 (b) 통과(0)도 위반(1)도 아닌 **2**로 끝난다.
   * 2 를 skip 으로 볼지 실패로 볼지는 워크플로가 정한다(아래 "워크플로 배선" 참조).
   */
  const DEGENERATE: [name: string, input: string][] = [
    ['빈 입력(네트워크·인증 실패)', ''],
    ['공백만 있는 입력', '   \n  '],
    ['JSON 이 아닌 출력', 'not json'],
    ['필드가 빠진 빈 객체 — 종전에는 로그에 한 줄도 남지 않았다', '{}'],
    ['npm 측 error 응답', '{"error":{"code":"ENETUNREACH"}}'],
    ['vulnerabilities 가 객체가 아님(형식 변경)', '{"vulnerabilities":"none"}'],
  ];

  it.each(DEGENERATE)('축퇴 입력 [%s] 은 통과가 아니라 "검사 못 함"(exit 2)이다', (_name, input) => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { a: '^1' } }));
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages: {} }));
    const r = spawnSync(process.execPath, [SCRIPT], { cwd: dir, input, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS });
    expect(r.error, '게이트 실행 실패').toBeUndefined();
    expect(r.status, '축퇴 입력이 통과(0)로 끝났다 — 게이트가 무증상으로 사라진다').toBe(2);
    // Actions UI 에 보이는 형태여야 한다. 평문 로그는 스크롤백에 묻힌다.
    expect(r.stdout, '경고 주석(::warning::)이 없다 — 로그만 보고는 게이트가 돌았는지 알 수 없다')
      .toContain('::warning::');
  });

  it('정상 audit JSON(권고 0건)은 축퇴 입력과 구분된다', () => {
    // `{}` 를 실패로 보는 판정이 "취약점 없음" 까지 실패로 만들면 게이트가 상시 빨개진다.
    const r = runGate(
      { dependencies: {}, shippedDevDependencies: ['bundled-lib'] },
      { packages: { '': { name: 'app' }, 'node_modules/bundled-lib': { version: '1.0.0' } } },
      { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: {} } },
    );
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('::warning::');
  });

  it('실제 저장소의 프로덕션 트리가 게이트를 통과한다', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
    // advisory 없는 입력이므로 여기서 보는 것은 "폐포 계산이 실제 lockfile 에서 터지지 않는가".
    const r = runGate(pkg, lock, { vulnerabilities: {} });
    expect(r.code).toBe(0);
    // QA27(D-High): 종전 단언은 `not.toContain('lockfile 에서 못 찾음')` 이었는데, 그 문자열은
    // **저장소 어디에도 없다**(스크립트가 내는 것은 'lockfile 에서 찾지 못했습니다'). 즉 발화가
    // 구조적으로 불가능한 단언이었고, 이 게이트의 유일한 "범위 축소" 감시가 비어 있었다.
    // 실제로 내는 경고 형태로 고정한다.
    expect(r.out).not.toContain('lockfile 에서 찾지 못했습니다');
    expect(r.out).not.toContain('::warning::');
  });

  // QA27(D-High): 위 테스트가 죽은 문자열을 보는 동안, 폐포가 11개 루트에서 1개로 쪼그라들어도
  // 전부 초록이었다(예: 폐포 진입 조건에 `!nodes[cand].dev` 를 더하면 shippedDevDependencies 가
  // 전부 lockfile 상 dev:true 라 통째로 빠진다). 그러면 QA24 가 닫은 pdfjs-dist "악성 PDF →
  // 임의 JS 실행" 사각이 **블로킹 게이트가 초록인 채로** 되살아난다. 실제 검사 범위를 관측한다.
  it('실제 저장소에서 검사 범위가 조용히 줄어들지 않는다 (폐포 하한)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8'));
    const r = runGate(pkg, lock, { vulnerabilities: {} });

    // 배포 표면의 핵심 루트들이 검사 대상 목록에 실제로 들어 있어야 한다.
    for (const name of ['pdfjs-dist', 'react', 'katex', 'electron-updater']) {
      expect(r.summary, `${name} 이 검사 범위에서 빠졌다`).toContain(name);
    }
    // 앱 셸(QA26 D-High 로 편입)도 범위 안이어야 한다.
    expect(r.summary).toContain('electron');

    // 전이 폐포는 루트 수보다 훨씬 커야 한다 — "루트 N → 전이 포함 M" 에서 M 이 무너지면
    // 전이 의존 취약점(QA25 의 js-yaml)이 다시 보이지 않게 된다.
    const m = /루트 (\d+) → 전이 포함 (\d+)/.exec(r.summary);
    expect(m, '검사 범위 요약이 출력되지 않았다').not.toBeNull();
    const roots = Number(m![1]);
    const closure = Number(m![2]);
    expect(roots).toBeGreaterThanOrEqual(8);
    expect(closure, '전이 폐포가 루트 수준으로 붕괴했다').toBeGreaterThan(roots * 3);
  });
});

describe('워크플로 배선 (QA25 후속)', () => {
  // ⚠️ 이 게이트는 첫 릴리즈 시도에서 **CI 를 통째로 실패시켰다**. 스텝이 bash -o pipefail 로
  // 도는데 `npm audit` 은 권고를 하나라도 찾으면 exit 1 이고(빌드툴 권고는 항상 존재한다),
  // 파이프로 직결하면 게이트 판정과 무관하게 그 코드가 스텝의 결과가 된다. 로컬 셸에는
  // pipefail 이 없어 드러나지 않았다. 두 워크플로가 같은 관용구를 쓰는지 고정한다.
  // QA29(D1-2): 워크플로 스캔도 **주석을 걷고** 한다. 여기서 보는 토큰(`audit-shipped.mjs`)은
  // 설명 주석에도 여러 번 등장하므로, 스텝을 통째로 지워도 주석만 남으면 통과했다 — 소스 스캔
  // 가드 8곳과 같은 구멍이 워크플로 쪽에도 있었다. `#` 주석 제거는 공용 헬퍼가 소유한다.
  const wfSrc = (wf: string) => stripYamlComments(readFileSync(join(REPO_ROOT, wf), 'utf8'));
  const WORKFLOWS = ['.github/workflows/test.yml', '.github/workflows/release.yml'];

  it('두 워크플로 모두 audit 종료코드를 삼키고 본문만 파이프한다', () => {
    for (const wf of WORKFLOWS) {
      const src = wfSrc(wf);
      expect(src, `${wf}: 게이트 호출이 주석에만 남았다`).toContain('node scripts/audit-shipped.mjs');
      // 파이프 직결이 없어야 한다 — 있으면 npm audit 의 exit 1 이 그대로 스텝 결과가 된다.
      expect(src).not.toContain('npm audit --json 2>/dev/null | node scripts/audit-shipped.mjs');
      // 대신 종료코드를 삼킨 캡처 형태여야 한다.
      expect(src).toMatch(/AUDIT_JSON=\$\(npm audit --json[^)]*\|\| true\)/);
    }
  });

  // QA29(D2-1): 종료코드 2("검사 못 함")를 두 워크플로가 **서로 다르게** 다루는 것이 이 수정의
  // 요지다. 한쪽만 반영되면(이 저장소의 최다 결함 클래스=형제 누락) 태그 경로가 다시 조용해진다.
  it('push/PR 경로(test.yml)는 검사 불가를 경고로 표면화하고 통과시킨다', () => {
    const src = wfSrc('.github/workflows/test.yml');
    expect(src).toMatch(/rc=\$\?/);
    expect(src).toMatch(/if \[ "\$rc" = "2" \]; then/);
    // 조용한 통과가 아니라 **보이는** 통과여야 한다.
    const branch = /if \[ "\$rc" = "2" \]; then[\s\S]{0,400}?fi/.exec(src)?.[0] ?? '';
    expect(branch, '검사 불가 분기를 추출하지 못했다 — 가드가 무력화된 상태다').not.toBe('');
    expect(branch).toContain('::warning::');
    expect(branch).toMatch(/exit 0/);
  });

  it('릴리즈 태그 경로(release.yml)는 재시도 뒤에도 검사 불가면 실패시킨다', () => {
    const src = wfSrc('.github/workflows/release.yml');
    // 1회 재시도가 실제로 있어야 한다 — 없이 바로 실패시키면 플레이크로 릴리즈가 막힌다.
    expect(src, '재시도 호출이 없다').toMatch(/run_gate\(\)\s*\{/);
    expect((src.match(/^\s*run_gate$/gm) ?? []).length, '재시도(2회 호출)가 아니다').toBeGreaterThanOrEqual(2);
    // 그리고 최종 판정은 skip 이 아니라 실패여야 한다.
    const fail = /if \[ "\$rc" = "2" \]; then[\s\S]{0,400}?exit 1/.exec(src)?.[0] ?? '';
    expect(fail, '태그 경로가 검사 불가를 실패로 다루지 않는다 — 유일한 blocking 공급망 게이트가 무증상으로 사라진다').not.toBe('');
    expect(fail).toContain('::error::');
  });

  // QA29(D2-2): 두 blocking audit 스텝은 node_modules 부재 시 `exit 0` 이었다. npm ci 실패면
  // 잡 자체는 빨갛지만 **게이트 스텝은 초록**으로 남아 "검사가 통과했다" 는 기록을 만든다.
  it('node_modules 부재를 통과로 처리하지 않는다 (test.yml 의 두 blocking 스텝)', () => {
    const src = wfSrc('.github/workflows/test.yml');
    // 같은 잡의 **비차단** advisory 요약 스텝도 같은 가드를 갖고 있고 그쪽은 exit 0 이 맞다
    // (advisory 는 가시성 목적이라 빌드를 막지 않는다). 스텝 단위로 잘라 blocking 만 본다.
    const blocking = src
      .split(/^ {6}- name: /m)
      .slice(1)
      .filter((s) => /(?<!non-)blocking\)/.test(s.split('\n')[0]!));
    expect(blocking.length, 'blocking audit 스텝을 찾지 못했다 — 가드가 무력화된 상태다').toBe(2);
    for (const step of blocking) {
      const g = /if \[ ! -d node_modules \]; then[\s\S]{0,300}?fi/.exec(step)?.[0] ?? '';
      expect(g, 'node_modules 가드를 추출하지 못했다').not.toBe('');
      expect(g, 'node_modules 부재가 조용한 통과로 남아 있다').not.toMatch(/exit 0/);
      expect(g).toContain('::error::');
      expect(g).toMatch(/exit 1/);
    }
  });
});

describe('런타임 바이너리 이름 대조 (QA26 D-High)', { timeout: 30000 }, () => {
  const lock = {
    packages: {
      '': { name: 'app' },
      'node_modules/bundled-lib': { version: '1.0.0' },
      // electron 은 폐포에 넣지 않는다 — 이름만 대조하는 것이 이 기능의 요지다.
      'node_modules/electron': { version: '43.4.1', dev: true, dependencies: { got: '^11' } },
      'node_modules/got': { version: '11.0.0', dev: true },
    },
  };
  const pkg = {
    dependencies: {},
    shippedDevDependencies: ['bundled-lib'],
    shippedRuntimeBinaries: ['electron'],
  };
  const vuln = (title: string) => ({ severity: 'high', range: '<9', effects: [], via: [{ title }] });

  it('런타임 바이너리의 advisory 를 차단한다', () => {
    const r = runGate(pkg, lock, { vulnerabilities: { electron: vuln('Chromium 취약점') } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('electron');
  });

  it('그 바이너리의 설치 시점 의존은 무시한다 (폐포를 넓히지 않는다)', () => {
    // got 은 electron 이 바이너리를 내려받을 때만 쓰는 의존이라 배포물에 없다. 폐포에 넣으면
    // 이 게이트가 없애려던 빌드툴 노이즈가 그대로 되살아난다.
    const r = runGate(pkg, lock, { vulnerabilities: { got: { ...vuln('설치 시점 전용'), severity: 'critical' } } });
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('got');
  });

  it('목록이 비어 있어도 번들 폐포 판정은 그대로 동작한다', () => {
    const r = runGate(
      { ...pkg, shippedRuntimeBinaries: [] },
      lock,
      { vulnerabilities: { 'bundled-lib': vuln('번들 취약점') } },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('bundled-lib');
  });
});

describe('배포 분류 드리프트 가드 (QA26 D-High/D-Important)', () => {
  /**
   * 배포물에 **닿지 않는** devDependency. 여기 없고 shipped 목록에도 없으면 테스트가 실패한다.
   *
   * 왜 필요한가: QA25 가 shipped 폐포 게이트를 만들었지만 **목록 자체가 맞는지 보는 장치는
   * 없었다**. 그 결과 배포 표면의 대부분인 `electron` 이 두 blocking 게이트 어디에도 없는 상태로
   * 남았다(인스톨러 101MB 중 asar 는 4.67MB — 나머지가 electron 런타임). 목록에서 pdfjs-dist 를
   * 지워도 기존 테스트는 전부 그린이었다. 이 가드는 새 devDependency 를 추가할 때 "이건
   * 사용자에게 배포되는가"를 **한 번 답하도록 강제**한다.
   */
  const BUILD_ONLY = [
    '@playwright/test',        // E2E 러너
    '@tailwindcss/typography', // CSS 생성 — 산출물은 CSS 이고 패키지는 배포되지 않는다
    '@tailwindcss/vite',
    '@testing-library/react',
    '@testing-library/user-event',
    '@types/react',            // 타입 전용, 런타임 0
    '@types/react-dom',
    '@vitejs/plugin-react',
    '@vitest/coverage-v8',
    'electron-builder',        // 패키징 도구
    'electron-vite',
    'happy-dom',
    'pdf-lib',                 // QA28(D-Low): e2e 픽스처 전용(src 에 import 0건) — shipped 목록에 있던 오분류
    'tailwindcss',
    'typescript',
    'vite',
    'vitest',
  ];

  it('모든 devDependency 가 배포 여부로 분류돼 있다', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const classified = new Set([
      ...(pkg.shippedDevDependencies ?? []),
      ...(pkg.shippedRuntimeBinaries ?? []),
      ...BUILD_ONLY,
    ]);
    const unclassified = Object.keys(pkg.devDependencies ?? {}).filter((d) => !classified.has(d));
    expect(
      unclassified,
      '새 devDependency 는 shippedDevDependencies(번들에 들어감) / shippedRuntimeBinaries(바이너리로 실림) / BUILD_ONLY 중 하나로 분류해야 한다',
    ).toEqual([]);
  });

  it('분류 목록에 이제 없는 패키지가 남아 있지 않다', () => {
    // 반대 방향 — 의존성을 제거했는데 목록에만 남으면 "검사하고 있다"는 착각을 준다.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const declared = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    const stale = [
      ...(pkg.shippedDevDependencies ?? []),
      ...(pkg.shippedRuntimeBinaries ?? []),
      ...BUILD_ONLY,
    ].filter((d) => !declared.has(d));
    expect(stale).toEqual([]);
  });

  it('electron 이 게이트의 검사 범위 안에 있다 (QA26 D-High 회귀)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const covered = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...(pkg.shippedDevDependencies ?? []),
      ...(pkg.shippedRuntimeBinaries ?? []),
    ]);
    expect(covered.has('electron'), '앱 셸이 audit 게이트 밖에 있으면 배포 표면의 대부분이 무방비다').toBe(true);
  });
});
