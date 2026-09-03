import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripJsComments } from './helpers/source-scan';
// @ts-expect-error — 순수 JS 스크립트(타입 선언 없음). 스위트 밖에서 실행되는 게이트의 판정 로직을 같은 소스로 검증한다.
import { checkDrift, parseGates, MAX_MARGIN_PP, METRICS } from '../../../scripts/coverage-drift.mjs';

/**
 * QA27(D-MED): 커버리지 게이트가 실측을 따라가는지 **사람이** 대조해 왔고, 그 대조는
 * QA13·QA22·QA24·QA27 에서 매번 "뒤처진 채" 발견됐다. 정책은 `-5pp`.
 *
 * QA28(D-High): QA27 이 넣은 판정은 `it.skipIf(!existsSync(summary))` 였는데 vitest 의
 * `coverage.clean`(기본 true)이 실행 시작 시 coverage/ 를 지워 `--coverage` 실행에서도 **항상 skip**
 * 이었다 — CI 어디에서도 한 번도 판정하지 않았다. 판정은 scripts/coverage-drift.mjs 로 옮겨
 * `posttest:coverage` 로 리포트가 쓰인 **뒤에** 돌고, 이 파일은 그 순수 함수를 합성 입력으로
 * 검증한다(파일 유무에 의존하는 skip 없음).
 *
 * QA30(D1): 그 다음 구멍은 **게이트 숫자를 어디서 읽는가** 였다. 스크립트는 vitest.config.mts
 * 소스를 비탐욕 정규식으로 파싱했는데, 이 config 는 라운드마다 임계 논의 산문이 쌓이는 파일이라
 * **실제 블록보다 위의 주석**에 `thresholds: { … }` 가 한 줄만 생겨도 그쪽을 잡았다. 그러면
 * vitest 가 강제하는 값이 아닌 숫자와 대조하면서 드리프트를 영원히 못 잡는 채로 초록이 된다
 * (실측: 주석 한 줄로 exit 0 + 이 파일 6/6 통과). 이제 숫자는 `scripts/coverage-gates.json` 이
 * 단일 출처이고 config 가 그것을 import 한다 — 파싱할 문법이 없다. 아래 마지막 describe 가
 * "config 가 정말 그 파일을 쓰는가" 만 못박는다.
 */

const ROOT = resolve(import.meta.dirname, '../../..');
type Metric = 'statements' | 'branches' | 'functions' | 'lines';
const total = (pct: Partial<Record<Metric, number>>) =>
  Object.fromEntries(Object.entries(pct).map(([k, v]) => [k, { pct: v }]));
const GATES = { statements: 79, branches: 71, functions: 79, lines: 82 };

describe('커버리지 게이트 드리프트 (QA27 D-MED → QA28 D-High 재배선)', () => {
  it('게이트 4종을 실제 게이트 파일에서 읽을 수 있다', () => {
    const raw: unknown = JSON.parse(readFileSync(resolve(ROOT, 'scripts/coverage-gates.json'), 'utf-8'));
    const t = parseGates(raw);
    for (const m of METRICS as Metric[]) expect(t[m], `${m} 게이트를 읽지 못했다`).toBeGreaterThan(0);
  });

  it('지표가 빠지거나 숫자가 아니면 통과가 아니라 throw 한다 (조용한 무력화 금지)', () => {
    expect(() => parseGates({})).toThrow(/statements/);
    expect(() => parseGates({ statements: 79 })).toThrow(/branches/);
    expect(() => parseGates({ statements: '79', branches: 71, functions: 79, lines: 82 })).toThrow(/statements/);
    expect(() => parseGates(null)).toThrow(/객체/);
  });

  it('측정 − 게이트 > 5pp 면 drifted 로 잡는다 (경계 5.00 은 통과)', () => {
    const ok = checkDrift(total({ statements: 84, branches: 76, functions: 84, lines: 87 }), GATES);
    expect(ok.drifted).toEqual([]);
    const bad = checkDrift(total({ statements: 84.01, branches: 71, functions: 79, lines: 82 }), GATES);
    expect(bad.drifted).toHaveLength(1);
    expect(bad.drifted[0]).toMatch(/^statements: 측정 84\.01 vs 게이트 79/);
  });

  it('측정치가 게이트 아래면 below 로 잡는다', () => {
    const r = checkDrift(total({ statements: 78.99, branches: 71, functions: 79, lines: 82 }), GATES);
    expect(r.below).toEqual(['statements: 측정 78.99 < 게이트 79']);
    expect(r.drifted).toEqual([]);
  });

  it('측정치가 없는 지표는 통과시키지 않고 missing 으로 보고한다', () => {
    const r = checkDrift(total({ statements: 80 }), GATES);
    expect(r.missing).toEqual(['branches', 'functions', 'lines']);
    expect(checkDrift(undefined, GATES).missing).toEqual(METRICS);
  });

  it('posttest:coverage 로 실제 배선돼 있다 (스크립트가 스위트 밖에서 실행되는 유일한 경로)', () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:coverage']).toMatch(/--coverage/);
    expect(pkg.scripts['posttest:coverage']).toBe('node scripts/coverage-drift.mjs');
    // json-summary 리포터가 빠지면 스크립트는 파일 부재로 실패한다 — 그 전제를 여기서도 고정.
    const cfg = stripJsComments(readFileSync(resolve(ROOT, 'vitest.config.mts'), 'utf-8'));
    expect(cfg).toMatch(/reporter:\s*\[[^\]]*'json-summary'/);
    expect(MAX_MARGIN_PP).toBe(5);
  });
});

/**
 * QA30(D1): 게이트 숫자의 단일 출처 배선. 이 세 단언이 함께여야 "스크립트가 대조하는 값 =
 * vitest 가 강제하는 값" 이 성립한다 — 하나라도 빠지면 두 숫자가 조용히 갈라질 수 있다.
 * 소스는 **주석을 걷고** 본다(D2 규칙): 그러지 않으면 배선을 지워도 그것을 설명한 주석이
 * 남아 통과한다 — 이 파일이 고치고 있는 결함과 정확히 같은 것이다.
 */
describe('게이트 숫자의 단일 출처 (QA30 D1)', () => {
  const CFG = stripJsComments(readFileSync(resolve(ROOT, 'vitest.config.mts'), 'utf-8'));

  it('vitest.config 이 게이트 파일을 import 한다', () => {
    expect(CFG).toMatch(/import\s+COVERAGE_GATES\s+from\s+'\.\/scripts\/coverage-gates\.json'/);
  });

  it('vitest.config 의 thresholds 가 그 import 를 그대로 쓴다 (리터럴 재기입 금지)', () => {
    expect(CFG).toMatch(/thresholds:\s*COVERAGE_GATES\s*,/);
    // 숫자를 다시 적는 순간 두 출처가 갈라진다. 리터럴 블록의 부활을 막는다.
    expect(CFG).not.toMatch(/thresholds:\s*\{/);
  });

  it('게이트 파일은 4개 지표의 숫자만 갖는다 (주석을 쓸 수 없는 JSON 인 것도 의도다)', () => {
    const raw = JSON.parse(readFileSync(resolve(ROOT, 'scripts/coverage-gates.json'), 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual([...(METRICS as string[])].sort());
    for (const v of Object.values(raw)) expect(typeof v).toBe('number');
  });
});

/**
 * QA30·QA31 이 게이트의 **분자**(숫자의 단일 출처)를 닫는 동안 **분모**는 무가드로 남아 있었다.
 *
 * `coverage.exclude` 에 한 줄을 더하면 그 코드가 측정에서 빠져 비율이 **올라간다** — 게이트는
 * 당연히 통과하고, 드리프트 스크립트는 오히려 "게이트가 뒤처졌다" 며 상향을 권한다. 즉 측정
 * 범위가 줄어드는 방향의 변경은 어떤 신호도 만들지 않고, 숫자만 좋아진다.
 *
 * 그래서 목록을 통째로 못박는다. 이 목록은 **줄어드는 방향**으로만 관리돼 왔고(QA25 가 App.tsx 를
 * 절차대로 분모에 편입시켰고, preload 도 테스트 도입 후 제거됐다) 그 절차의 유일한 강제 지점이
 * 여기다. 한 줄을 더하려면 이 핀을 함께 고쳐야 하고, 그 diff 가 리뷰에서 보인다.
 */
describe('커버리지 분모 (coverage.exclude) 는 조용히 자라지 않는다', () => {
  // 파일 안에 `exclude:` 는 둘이다(테스트 제외 / 커버리지 제외) — coverage 블록 쪽만 본다.
  const CFG = stripJsComments(readFileSync(resolve(ROOT, 'vitest.config.mts'), 'utf-8'));
  const coverageBlock = CFG.slice(CFG.indexOf('coverage: {'));
  const start = coverageBlock.indexOf('exclude: [');
  const entries = [...coverageBlock.slice(start, coverageBlock.indexOf(']', start)).matchAll(/'([^']+)'/g)]
    .map((m) => m[1]!);

  /**
   * QA32(D-2): `exclude` 만 핀하고 **`include` 는 무핀**이었다 — 분모의 나머지 절반이다.
   * 실측: `include` 를 renderer 하위만 보도록 좁혀 **src/main 전량을 분모에서
   * 빼도** 메타 가드 91/91 통과하고, 비율은 오히려 **오르며**(85.9→86.7 등) 드리프트
   * 스크립트는 "게이트를 올리세요" 라고 권한다. 결함 밀도가 가장 높은 메인 프로세스를 한 줄로
   * 측정에서 제외해도 아무 신호가 없다. exclude 핀을 만든 그 블록의 형제 누락이다.
   */
  it('측정 대상(include)이 좁아지지 않는다', () => {
    const start = coverageBlock.indexOf('include: [');
    expect(start, 'coverage.include 를 찾지 못했다 — 이 가드가 무력화된 상태다').toBeGreaterThan(-1);
    const entries = [...coverageBlock.slice(start, coverageBlock.indexOf(']', start)).matchAll(/'([^']+)'/g)]
      .map((m) => m[1]!);
    expect(entries, 'src 전체가 아닌 하위만 측정하면 나머지는 회귀가 무감지로 통과한다')
      .toEqual(['src/**/*.{ts,tsx}']);
  });

  it('목록을 추출했다 (추출이 비면 아래 핀이 공허해진다)', () => {
    expect(start, 'vitest.config 의 coverage.exclude 를 찾지 못했다 — 이 가드가 무력화된 상태다')
      .toBeGreaterThan(-1);
    expect(entries.length).toBeGreaterThanOrEqual(10);
  });

  it('제외 목록이 핀과 정확히 일치한다', () => {
    expect(entries).toEqual([
      'node_modules/**', 'out/**', 'dist/**', 'test/**', 'scripts/**',
      '**/*.config.*', '**/*.d.ts', '**/__tests__/**',
      '**/coverage/**',
      'src/renderer/main.tsx',
    ]);
  });
});
