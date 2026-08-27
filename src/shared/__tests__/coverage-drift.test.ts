import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — 순수 JS 스크립트(타입 선언 없음). 스위트 밖에서 실행되는 게이트의 판정 로직을 같은 소스로 검증한다.
import { checkDrift, parseThresholds, MAX_MARGIN_PP, METRICS } from '../../../scripts/coverage-drift.mjs';

/**
 * QA27(D-MED): 커버리지 게이트가 실측을 따라가는지 **사람이** 대조해 왔고, 그 대조는
 * QA13·QA22·QA24·QA27 에서 매번 "뒤처진 채" 발견됐다. 정책은 `-5pp`.
 *
 * QA28(D-High): QA27 이 넣은 판정은 `it.skipIf(!existsSync(summary))` 였는데 vitest 의
 * `coverage.clean`(기본 true)이 실행 시작 시 coverage/ 를 지워 `--coverage` 실행에서도 **항상 skip**
 * 이었다 — CI 어디에서도 한 번도 판정하지 않았다. 판정은 scripts/coverage-drift.mjs 로 옮겨
 * `posttest:coverage` 로 리포트가 쓰인 **뒤에** 돌고, 이 파일은 그 순수 함수를 합성 입력으로
 * 검증한다(파일 유무에 의존하는 skip 없음).
 */

const ROOT = resolve(import.meta.dirname, '../../..');
type Metric = 'statements' | 'branches' | 'functions' | 'lines';
const total = (pct: Partial<Record<Metric, number>>) =>
  Object.fromEntries(Object.entries(pct).map(([k, v]) => [k, { pct: v }]));
const GATES = { statements: 79, branches: 71, functions: 79, lines: 82 };

describe('커버리지 게이트 드리프트 (QA27 D-MED → QA28 D-High 재배선)', () => {
  it('게이트 4종을 실제 config 에서 읽을 수 있다', () => {
    const t = parseThresholds(readFileSync(resolve(ROOT, 'vitest.config.mts'), 'utf-8'));
    for (const m of METRICS as Metric[]) expect(t[m], `${m} 게이트를 읽지 못했다`).toBeGreaterThan(0);
  });

  it('thresholds 블록이 없으면 통과가 아니라 throw 한다 (조용한 무력화 금지)', () => {
    expect(() => parseThresholds('export default {}')).toThrow(/thresholds/);
    expect(() => parseThresholds('thresholds: { statements: 79 }')).toThrow(/branches/);
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
    const cfg = readFileSync(resolve(ROOT, 'vitest.config.mts'), 'utf-8');
    expect(cfg).toMatch(/reporter:\s*\[[^\]]*'json-summary'/);
    expect(MAX_MARGIN_PP).toBe(5);
  });
});
