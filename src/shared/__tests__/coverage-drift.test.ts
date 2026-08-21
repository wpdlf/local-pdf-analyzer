import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * QA27(D-MED): 커버리지 게이트가 실측을 따라가는지 **사람이** 대조해 왔고, 그 대조는
 * QA13·QA22·QA24·QA27 에서 매번 "뒤처진 채" 발견됐다. 정책은 `-5pp`(측정치보다 5pp 아래까지
 * 허용) 인데, 테스트가 늘어 베이스라인이 오르면 게이트는 그대로 남아 간격이 벌어지고 그만큼의
 * 회귀가 무감지로 통과한다.
 *
 * 이 테스트는 그 대조를 자동화한다. `coverage/coverage-summary.json` 이 있을 때만 판정하므로
 * (커버리지 없이 도는 `npm test` 에서는 skip) 일상 실행을 느리게 하지 않고,
 * `npm run test:coverage` 를 도는 CI 게이트에서 드리프트를 잡는다.
 *
 * ⚠️ vitest 는 스위트가 끝난 뒤 리포트를 쓰므로 이 파일이 읽는 것은 **직전 실행**의 산출물이다.
 * 게이트를 올린 직후 한 번은 이전 수치를 볼 수 있다 — 판정이 한 실행 늦을 뿐, 드리프트가
 * 누적되면 반드시 걸린다(그 지연을 이유로 단언을 느슨하게 두지는 않는다).
 */

const MAX_MARGIN_PP = 5;
const ROOT = resolve(import.meta.dirname, '../../..');
const SUMMARY = resolve(ROOT, 'coverage/coverage-summary.json');
const CONFIG = resolve(ROOT, 'vitest.config.mts');

type Metric = 'statements' | 'branches' | 'functions' | 'lines';
const METRICS: Metric[] = ['statements', 'branches', 'functions', 'lines'];

/** vitest.config.mts 의 thresholds 블록에서 게이트 값을 읽는다. */
function readThresholds(): Record<Metric, number> {
  const src = readFileSync(CONFIG, 'utf-8');
  const block = /thresholds:\s*\{([\s\S]*?)\}/.exec(src);
  // 추출 실패를 통과시키면 이 가드가 조용히 무력화된다 — 즉시 실패시킨다.
  if (!block) throw new Error('vitest.config.mts 에서 thresholds 블록을 찾지 못했습니다');
  const out = {} as Record<Metric, number>;
  for (const m of METRICS) {
    const hit = new RegExp(`${m}:\\s*(\\d+(?:\\.\\d+)?)`).exec(block[1]!);
    if (!hit) throw new Error(`thresholds 에 ${m} 이 없습니다`);
    out[m] = Number(hit[1]);
  }
  return out;
}

describe('커버리지 게이트 드리프트 (QA27 D-MED)', () => {
  it('게이트 4종을 config 에서 실제로 읽을 수 있다', () => {
    const t = readThresholds();
    for (const m of METRICS) expect(t[m], `${m} 게이트를 읽지 못했다`).toBeGreaterThan(0);
  });

  it.skipIf(!existsSync(SUMMARY))('측정치와 게이트의 간격이 -5pp 정책을 넘지 않는다', () => {
    const total = JSON.parse(readFileSync(SUMMARY, 'utf-8')).total as Record<Metric, { pct: number }>;
    const gates = readThresholds();
    const drifted: string[] = [];
    for (const m of METRICS) {
      const measured = total[m]?.pct;
      if (typeof measured !== 'number') continue;
      const margin = measured - gates[m];
      if (margin > MAX_MARGIN_PP) {
        drifted.push(`${m}: 측정 ${measured.toFixed(2)} vs 게이트 ${gates[m]} (마진 ${margin.toFixed(2)}pp)`);
      }
    }
    expect(drifted, `게이트가 실측에 뒤처져 그만큼의 회귀가 무감지 통과한다:\n  ${drifted.join('\n  ')}`).toEqual([]);
  });

  it.skipIf(!existsSync(SUMMARY))('측정치가 게이트 아래로 내려가지 않았다 (게이트 자체의 정합성)', () => {
    const total = JSON.parse(readFileSync(SUMMARY, 'utf-8')).total as Record<Metric, { pct: number }>;
    const gates = readThresholds();
    for (const m of METRICS) {
      const measured = total[m]?.pct;
      if (typeof measured !== 'number') continue;
      expect(measured, `${m} 이 게이트 아래다`).toBeGreaterThanOrEqual(gates[m]);
    }
  });
});
