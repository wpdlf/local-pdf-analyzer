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
    expect(withFlag('e2e')).toMatch(/npm run (test:e2e|build)/);
    expect(withFlag('audit')).toMatch(/npm audit/);
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
