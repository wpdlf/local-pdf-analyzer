// 커버리지 게이트 드리프트 가드 — `npm run test:coverage` 의 post-step(package.json
// `posttest:coverage`)으로 실행된다.
//
// QA28(D-High): 이 판정은 원래 coverage-drift.test.ts 안의 `it.skipIf(!existsSync(summary))` 였는데,
// vitest 는 `coverage.clean` 기본값(true)으로 **실행 시작 시 coverage/ 를 지우므로** 요약 파일을
// 만드는 유일한 경로(`--coverage`)에서는 수집 시점에 파일이 없어 **항상 skip** 이었고, CI 는 fresh
// checkout 이라 두 잡(test.yml coverage · release.yml coverage 레그) 어디서도 한 번도 판정하지
// 않았다(전체 스위트의 "2 skipped" 가 정확히 그 둘). 스위트 **밖**에서, 리포트가 쓰인 뒤에 돈다.
//
// 판정 로직은 순수 함수(checkDrift)로 분리해 coverage-drift.test.ts 가 합성 입력으로 뮤테이션
// 가능하게 검증한다 — 파일 유무에 의존하는 skipIf 는 더 이상 없다.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_MARGIN_PP = 5;
export const METRICS = ['statements', 'branches', 'functions', 'lines'];

/** vitest.config 소스의 thresholds 블록에서 게이트 4종을 읽는다. 추출 실패는 throw(조용한 무력화 금지). */
export function parseThresholds(configSrc) {
  const block = /thresholds:\s*\{([\s\S]*?)\}/.exec(configSrc);
  if (!block) throw new Error('vitest.config.mts 에서 thresholds 블록을 찾지 못했습니다');
  const out = {};
  for (const m of METRICS) {
    const hit = new RegExp(`${m}:\\s*(\\d+(?:\\.\\d+)?)`).exec(block[1]);
    if (!hit) throw new Error(`thresholds 에 ${m} 이 없습니다`);
    out[m] = Number(hit[1]);
  }
  return out;
}

/**
 * 측정치(total.{metric}.pct)와 게이트를 대조한다.
 * @returns {{ drifted: string[]; below: string[]; missing: string[] }}
 *   drifted = 측정 − 게이트 > maxMargin(게이트가 뒤처짐), below = 측정 < 게이트, missing = 측정치 없음
 */
export function checkDrift(total, gates, maxMargin = MAX_MARGIN_PP) {
  const drifted = [];
  const below = [];
  const missing = [];
  for (const m of METRICS) {
    const measured = total?.[m]?.pct;
    if (typeof measured !== 'number' || !Number.isFinite(measured)) { missing.push(m); continue; }
    const margin = measured - gates[m];
    if (margin > maxMargin) drifted.push(`${m}: 측정 ${measured.toFixed(2)} vs 게이트 ${gates[m]} (마진 ${margin.toFixed(2)}pp)`);
    if (margin < 0) below.push(`${m}: 측정 ${measured.toFixed(2)} < 게이트 ${gates[m]}`);
  }
  return { drifted, below, missing };
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const summaryPath = resolve(root, 'coverage/coverage-summary.json');
  if (!existsSync(summaryPath)) {
    // 요약이 없다는 것은 json-summary 리포터가 빠졌거나 coverage 가 돌지 않은 것 — 가드가
    // 조용히 사라지는 상태이므로 통과시키지 않는다.
    console.error(`[coverage-drift] ${summaryPath} 가 없습니다 — vitest coverage.reporter 에 json-summary 가 있는지, --coverage 로 실행됐는지 확인하세요.`);
    process.exit(1);
  }
  const total = JSON.parse(readFileSync(summaryPath, 'utf-8')).total;
  const gates = parseThresholds(readFileSync(resolve(root, 'vitest.config.mts'), 'utf-8'));
  const { drifted, below, missing } = checkDrift(total, gates);
  if (missing.length > 0) {
    console.error(`[coverage-drift] 측정치가 없는 지표: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (below.length > 0) {
    // vitest 자체 thresholds 가 먼저 잡지만, 리포터 설정이 바뀌어 thresholds 가 꺼졌을 때의 백스톱.
    console.error(`[coverage-drift] 측정치가 게이트 아래입니다:\n  ${below.join('\n  ')}`);
    process.exit(1);
  }
  if (drifted.length > 0) {
    console.error(`[coverage-drift] 게이트가 실측에 뒤처져 그만큼의 회귀가 무감지 통과합니다(정책 -${MAX_MARGIN_PP}pp). vitest.config.mts thresholds 를 올리세요:\n  ${drifted.join('\n  ')}`);
    process.exit(1);
  }
  const line = METRICS.map((m) => `${m} ${total[m].pct.toFixed(2)}/${gates[m]}`).join(' · ');
  console.log(`[coverage-drift] OK — ${line}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
