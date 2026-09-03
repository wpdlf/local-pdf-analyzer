import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripYamlComments } from './helpers/source-scan';

/**
 * "게이트가 실행되지 않는데 잡은 초록" 클래스의 워크플로 쪽 가드.
 *
 * 이 저장소는 같은 클래스를 반복해서 밟았다: 릴리즈 경로에 커버리지 게이트가 없던 것
 * (post-v0.24.4) · OS 라벨 비교라 라벨만 바꿔도 게이트가 사라지던 것(QA20 D-MED) ·
 * 플래그 자체가 빠지는 것(QA24 D-M2) · audit 이 커버리지 플래그에 얹혀 있던 것(QA26 D-Medium) ·
 * coverage-drift 가 skipIf 로 CI 에서 한 번도 판정되지 않던 것(QA28 D-High).
 *
 * 그 대응은 매번 워크플로 **안**의 셸 가드였는데, 그 가드가 보는 것은 `matrix.include` 의
 * **플래그 존재**뿐이다. 정작 게이트를 실행시키는 것은 그 플래그를 소비하는 `if:` 이고,
 * 그쪽은 아무도 보지 않았다 — `if: matrix.coverage` 를 `if: false` 로 바꾸거나 스텝을 통째로
 * 지워도 플래그는 매트릭스에 그대로 남아 **가드 스텝 자신이 계속 통과**한다.
 * QA31 잔여 백로그의 실측이 그것이다(커버리지·E2E 를 날려도 전량 통과).
 *
 * 여기서는 플래그를 **워크플로에서 도출**해 소비처를 대조한다 — 네 개를 손으로 적으면
 * 다섯 번째 플래그가 생길 때 같은 구멍이 반복된다(이 저장소의 최다 결함 클래스 = 형제 누락).
 */

const ROOT = resolve(import.meta.dirname, '../../..');
const RELEASE = '.github/workflows/release.yml';
const TEST_WF = '.github/workflows/test.yml';

/**
 * 워크플로는 **주석을 걷고** 읽는다. 이 파일들은 라운드마다 결정 산문이 쌓이는 자리라,
 * 원본을 그대로 보면 스텝을 지워도 그것을 설명한 주석이 남아 통과한다(QA29 D1-2 · QA31 B·D).
 */
const wf = (path: string) => stripYamlComments(readFileSync(resolve(ROOT, path), 'utf8'));

/** `matrix.include` 블록에서 의도 플래그 이름을 도출한다(`os`/`node-version` 같은 값 키는 제외). */
function declaredIntentFlags(src: string): string[] {
  const start = src.indexOf('include:');
  const end = src.indexOf('runs-on:', start);
  const block = src.slice(start, end === -1 ? undefined : end);
  return [...new Set([...block.matchAll(/^\s+-?\s*(\w+):\s*true\s*$/gm)].map((m) => m[1]!))].sort();
}

/** 스텝 단위로 자른다 — `if:` 를 그 스텝의 `run:`/`uses:` 와 함께 봐야 "실행되는가" 를 알 수 있다. */
const steps = (src: string) => src.split(/^ {6}- /m).slice(1);

/**
 * `key:` 아래에 매달린 줄들(자식). YAML 의 좁히기는 항상 자식으로 들어오므로, 키 줄만 보는
 * 단언은 공허하다(초판이 `types: [opened]` 뮤테이션을 통과시켰다).
 * 키가 없으면 `null` — 호출부가 "좁아졌다" 와 "사라졌다" 를 구분할 수 있게 한다.
 */
function childLines(block: string, key: string): string[] | null {
  const lines = block.split('\n');
  const i = lines.findIndex((l) => new RegExp(String.raw`^\s*${key}:\s*$`).test(l));
  if (i === -1) return null;
  const indent = lines[i]!.search(/\S/);
  const out: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() === '') continue; // 주석이 걷힌 자리는 빈 줄로 남는다
    if (line.search(/\S/) <= indent) break;
    out.push(line.trim());
  }
  return out;
}

describe('릴리즈 매트릭스의 의도 플래그는 실행되는 소비처를 갖는다', () => {
  const src = wf(RELEASE);
  const flags = declaredIntentFlags(src);

  it('의도 플래그를 워크플로에서 도출한다 (열거 금지 — 도출이 비면 가드가 공허해진다)', () => {
    expect(flags, `${RELEASE}: matrix.include 에서 의도 플래그를 찾지 못했다 — 이 가드가 무력화된 상태다`)
      .toEqual(['audit', 'coverage', 'e2e', 'unitOnly']);
  });

  it.each(['audit', 'coverage', 'e2e', 'unitOnly'])(
    '`%s` 플래그를 조건으로 실제 명령을 실행하는 스텝이 있다',
    (flag) => {
      // 플래그가 도출 집합에서 사라졌다면 위 테스트가 먼저 실패한다. 여기서는 소비처만 본다.
      expect(flags).toContain(flag);
      // `failure() && matrix.X` 는 실패 포렌식(아티팩트 업로드)이라 게이트가 아니다 —
      // 게이트 스텝을 지우고 업로드 스텝만 남겨도 통과하면 이 가드는 의미가 없다.
      const gate = new RegExp(String.raw`^\s*if:\s*matrix\.${flag}\s*$`, 'm');
      const consumers = steps(src).filter((s) => gate.test(s));
      expect(consumers.length, `${RELEASE}: \`if: matrix.${flag}\` 를 조건으로 하는 게이트 스텝이 없다 — 플래그는 매트릭스에 남아 있어 워크플로 안의 셸 가드는 계속 통과한다`)
        .toBeGreaterThanOrEqual(1);
      expect(
        consumers.some((s) => /^\s*(run|uses):/m.test(s)),
        `${RELEASE}: \`if: matrix.${flag}\` 스텝이 아무것도 실행하지 않는다`,
      ).toBe(true);
    },
  );

  it('커버리지 레그는 커버리지 게이트를, e2e 레그는 E2E 를 실제로 돌린다', () => {
    // 소비처의 존재만으로는 부족하다 — `if: matrix.coverage` 스텝의 명령이 다른 것으로 바뀌면
    // 릴리즈 경로가 커버리지 게이트를 건너뛰던 post-v0.24.4 상태로 조용히 되돌아간다.
    const withFlag = (flag: string) =>
      steps(src).filter((s) => new RegExp(String.raw`^\s*if:\s*matrix\.${flag}\s*$`, 'm').test(s)).join('\n');
    expect(withFlag('coverage')).toMatch(/npm run test:coverage/);
    // QA32(D-4): 초판은 `npm run (test:e2e|build)` 라 **대안 `build` 가 E2E 실행을 면제**했다 —
    // playwright 줄만 지워도 통과했다(실측). 실제로 도는 명령을 직접 못박는다.
    expect(withFlag('e2e')).toMatch(/npm run build/);
    expect(withFlag('e2e'), 'E2E 실행이 사라졌다 — build 만 남아도 이 스텝은 초록이다')
      .toMatch(/playwright test/);
    expect(withFlag('audit')).toMatch(/npm audit/);
  });
});

/**
 * QA32(D-1, High): 위 도출은 **매트릭스 의도 플래그**에서 출발한다. 그런데 `build-windows`
 * 잡에는 매트릭스가 없어 **그 잡의 게이트는 도출 대상 자체가 아니었다** — 이 클래스를 닫으려고
 * 만든 가드 안에서 같은 형제 누락이 재발했다. 실측: 세 스텝을 통째로 지워도 91/91 통과.
 *
 * 이 잡의 게이트는 성격이 다르다. 셋 다 **없어도 빌드는 성공하고 릴리즈도 정상으로 보이는데**
 * 사용자 쪽에서만 조용히 깨진다:
 *  - packaged smoke: asar 내용물 검증(소스트리 E2E 가 못 보는 층). memory 의 "실행 없이 초록이
 *    되는 3경로" 를 막으려고 게이트화한 스펙이다.
 *  - auto-update 메타: latest.yml/blockmap 이 없으면 **전 사용자 자동 업데이트가 정지**한다.
 *  - 태그↔버전: 어긋나면 latest.yml 이 구버전을 가리켜 "최신 버전입니다" 로 영구 고착된다.
 */
describe('릴리즈 빌드 잡의 게이트는 명령까지 살아 있어야 한다', () => {
  const src = wf(RELEASE);
  /** `build-windows` 잡 본문만 자른다(다음 최상위 잡 키 또는 파일 끝까지). */
  const buildJob = (() => {
    const start = src.indexOf('\n  build-windows:');
    expect(start, `${RELEASE}: build-windows 잡을 찾지 못했다 — 이 가드가 무력화된 상태다`)
      .toBeGreaterThan(-1);
    const rest = src.slice(start + 1);
    const nextJob = rest.search(/\n {2}[a-z][\w-]*:\n/);
    return nextJob === -1 ? rest : rest.slice(0, nextJob);
  })();

  it.each([
    ['Packaged app smoke gate', /playwright test e2e\/packaged-smoke\.spec\.ts/],
    ['Verify auto-update metadata exists', /dist\/latest\.yml/],
  ])('`%s` 스텝이 실제 명령과 함께 남아 있다', (name, command) => {
    const jobSteps = buildJob.split(/^ {6}- /m).slice(1);
    const step = jobSteps.find((s) => s.startsWith(`name: ${name}`));
    expect(step, `${RELEASE}: "${name}" 스텝이 사라졌다 — 빌드는 성공하고 사용자 쪽만 조용히 깨진다`)
      .toBeDefined();
    expect(step!, `"${name}" 스텝이 남아 있지만 명령이 바뀌었다`).toMatch(command);
  });

  // 태그↔버전 게이트는 `test` 잡에 있다(빌드 이전에 걸러야 하므로) — 잡 스코프가 다르니
  // 파일 전체에서 본다. 어긋나면 latest.yml 이 구버전을 가리켜 전 사용자가 "최신 버전입니다"
  // 로 고착된다(QA19 가 이 게이트를 만든 사유).
  it('태그↔package.json 버전 게이트가 남아 있다', () => {
    const gate = steps(src).find((s) => s.startsWith('name: Verify tag matches package.json version'));
    expect(gate, `${RELEASE}: 태그↔버전 게이트가 사라졌다`).toBeDefined();
    expect(gate!).toMatch(/GITHUB_REF_NAME/);
    expect(gate!, '불일치를 실패로 다루지 않는다').toMatch(/exit 1/);
  });
});

describe('test.yml 트리거는 좁아지지 않는다 (skip 은 required check 를 통과시킨다)', () => {
  const src = wf(TEST_WF);
  const on = src.slice(src.indexOf('\non:'), src.indexOf('\npermissions:'));

  it('트리거 블록을 추출했다', () => {
    expect(on, `${TEST_WF}: on: 블록을 찾지 못했다 — 이 가드가 무력화된 상태다`).not.toBe('');
    expect(on).toContain('push:');
  });

  // GitHub 은 실행되지 않은 required check 를 실패로 세지 않는다. 트리거를 한 줄로 좁히면
  // 유닛·tsc·lockfile 게이트가 전부 조용히 사라지는데 PR 은 머지 가능 상태로 남는다.
  //
  // ⚠️ 이 두 단언의 초판은 `pull_request:` **줄**만 정규식으로 봤고, 그래서 바로 아래 줄에
  // `types: [opened]` 를 넣는 뮤테이션을 통과시켰다(줄 자체는 그대로 비어 있으므로).
  // 좁히기는 언제나 **하위 줄**로 들어온다 — 이벤트 키의 자식을 봐야 한다.
  it('push 트리거의 하위는 main 브랜치 지정뿐이다 (paths/tags 필터가 붙으면 잡이 skip 된다)', () => {
    expect(childLines(on, 'push'), `${TEST_WF}: push 트리거가 좁아졌다`).toEqual(['branches: [main]']);
  });

  it('pull_request 트리거에는 하위 필터가 없다 (types 로 좁히면 일부 PR 이 검증 없이 통과한다)', () => {
    expect(childLines(on, 'pull_request'), `${TEST_WF}: pull_request 트리거가 좁아졌다`).toEqual([]);
  });
});

/**
 * QA32(D-3): 위 도출은 매트릭스 플래그를 소비하는 `if:` 를 본다. 그런데 **test.yml 에는 의도
 * 플래그가 없어** 잡 본문이 통째로 도출 밖이었다 — `npm run test:coverage` 를 `echo` 로
 * 바꿔도 91/91 통과했다(실측). push/PR 경로의 blocking 게이트는 이 파일이 전부이므로,
 * 여기가 조용히 사라지면 main 에 회귀가 그대로 쌓인다.
 *
 * 개별 스텝 이름을 열거하지 않고 **명령**을 본다 — 스텝을 재배치하거나 이름을 바꾸는 정상
 * 리팩터에는 걸리지 않고, 게이트가 실제로 사라질 때만 걸린다.
 */
describe('test.yml 의 blocking 게이트 명령이 살아 있다', () => {
  const src = wf(TEST_WF);

  it.each([
    ['타입 체크(src)', /npx tsc --noEmit/],
    ['타입 체크(e2e)', /npx tsc -p tsconfig\.e2e\.json/],
    ['유닛 테스트', /npm test --/],
    ['커버리지 게이트', /npm run test:coverage/],
    ['lockfile 동기 검사', /package-lock\.json/],
    ['E2E', /playwright test/],
  ])('%s 가 남아 있다', (_label, command) => {
    expect(src, `${TEST_WF}: 게이트 명령이 사라졌다 — push/PR 경로가 그만큼 비어 있게 된다`)
      .toMatch(command);
  });
});

/**
 * QA32(D-5): CI 보안 컨트롤이 산문 주석으로만 지켜지고 있었다 — 워크플로 수준 최소권한
 * (QA20 B-MED)과 `persist-credentials: false`(QA24 D-I3 · QA28 D-Low)를 되돌려도 91/91
 * 통과했다(실측). QA31 의 CSP 게이트와 같은 클래스: 보안 컨트롤의 유일한 보호가 주석.
 */
describe('CI 보안 컨트롤 (권한 최소화 · 토큰 잔류 방지)', () => {
  it.each([TEST_WF, RELEASE])('%s: 워크플로 수준 권한이 넓어지지 않는다', (path) => {
    const src = wf(path);
    const top = src.slice(0, src.indexOf('\njobs:'));
    expect(top, `${path}: 워크플로 수준 permissions 선언이 사라졌다`).toMatch(/permissions:/);
    // 쓰기 권한은 그것이 꼭 필요한 **잡**에서만 승격한다(릴리즈 업로드·attestation).
    expect(top, `${path}: 워크플로 수준에 쓰기 권한이 생겼다 — 모든 잡이 그것을 상속한다`)
      .not.toMatch(/^\s+(contents|id-token|attestations|packages):\s*write/m);
  });

  it.each([TEST_WF, RELEASE])('%s: 모든 checkout 이 토큰을 남기지 않는다', (path) => {
    const src = wf(path);
    const steps = src.split(/^ {6}- /m).slice(1).filter((s) => s.includes('actions/checkout@'));
    expect(steps.length, `${path}: checkout 스텝을 찾지 못했다 — 이 가드가 무력화된 상태다`)
      .toBeGreaterThan(0);
    for (const s of steps) {
      expect(s, `${path}: persist-credentials:false 가 빠진 checkout 이 있다 — npm ci 가 돌리는 서드파티 스크립트에 .git/config 토큰이 남는다`)
        .toMatch(/persist-credentials:\s*false/);
    }
  });
});
