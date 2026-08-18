// 배포물 한정 npm audit 게이트.
//
// QA24(D-I1): `npm audit` 전체 요약은 매 실행 "high+critical 8" 을 출력하는데 그중 어느 것이
// 실제 배포물인지 알 방법이 없어 전체가 노이즈로 학습됐고, pdfjs-dist 의 "악성 PDF 열람 시
// 임의 JS 실행" HIGH 권고가 거기 묻혀 있었다. `--omit=dev` 로 거르는 통상적 필터는 이 저장소에서
// **정확히 반대** 결과를 낸다 — //dependenciesPolicy 가 renderer 라이브러리를 전부
// devDependencies 로 옮겼기 때문이다(인스톨러 13.5MB 축소). 그래서 "배포물에 실제로 들어가는
// 것" 만 따로, 차단성으로 본다. 목록은 package.json 의 shippedDevDependencies 가 단일 출처.
//
// QA25(D-H1): 이전 판은 advisory 의 **패키지 이름**을 shipped 집합과 그대로 대조해서, 배포
// 패키지의 **전이 의존**이 구조적으로 한 건도 매칭되지 않았다. 그 결과
// electron-updater → js-yaml 의 high 권고(GHSA-5p4m-2wfm-xmqj)가 실제로 통과하고 있었다.
// 이제 lockfile 로 shipped 루트들의 의존 폐포를 만들어 그 안의 이름을 전부 본다.
//
// ⚠️ audit JSON 의 `effects` 로 dependent 를 거슬러 올라가는 방식은 **작동하지 않는다**:
// 취약 패키지 자체가 선언 범위 안에서 수정 가능하면 npm 이 `effects` 를 빈 배열로 준다(실측 —
// js-yaml 4.3.0 케이스에서 `effects: []`, `isDirect: false`). 폐포 계산만이 신뢰 가능하다.
//
// 사용법: `npm audit --json | node scripts/audit-shipped.mjs`
// 종료 코드: 0 = 배포물에 high/critical 없음, 1 = 있음(또는 설정 오류).

import fs from 'node:fs';

const NODE_MODULES = 'node_modules/';

/** package-lock 의 중첩 해석(가까운 node_modules 우선)을 흉내내 의존 경로를 찾는다. */
export function resolveDep(nodes, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const cand = (base ? `${base}/` : '') + NODE_MODULES + name;
    if (nodes[cand]) return cand;
    if (!base) return null;
    const i = base.lastIndexOf(`/${NODE_MODULES}`);
    base = i === -1 ? '' : base.slice(0, i);
  }
}

/**
 * shipped 루트들로부터 도달 가능한 모든 패키지 이름(전이 포함)을 구한다.
 * optionalDependencies 도 포함한다 — 설치되면 배포물에 들어가기 때문.
 * peerDependencies 는 제외한다(호스트가 제공하는 것이라 이 트리의 배포물이 아니다).
 */
export function computeReachable(lock, shipped) {
  const nodes = lock.packages || {};
  const closure = new Set();
  const missing = [];
  const queue = [];
  for (const name of shipped) {
    const p = resolveDep(nodes, '', name);
    if (p) queue.push(p);
    else missing.push(name);
  }
  while (queue.length) {
    const p = queue.shift();
    if (closure.has(p)) continue;
    closure.add(p);
    const node = nodes[p] || {};
    const deps = { ...node.dependencies, ...node.optionalDependencies };
    for (const dep of Object.keys(deps)) {
      const r = resolveDep(nodes, p, dep);
      if (r && !closure.has(r)) queue.push(r);
    }
  }
  const names = new Set(
    [...closure].map((p) => p.slice(p.lastIndexOf(NODE_MODULES) + NODE_MODULES.length)),
  );
  return { names, missing };
}

/** audit JSON 에서 배포물에 도달하는 high/critical 만 골라낸다. */
export function findShippedHits(audit, reachable) {
  const hits = [];
  for (const [name, v] of Object.entries(audit.vulnerabilities || {})) {
    if (!reachable.has(name)) continue;
    if (v.severity !== 'high' && v.severity !== 'critical') continue;
    const titles = (v.via || [])
      .map((x) => (typeof x === 'string' ? x : x.title))
      .filter(Boolean);
    hits.push({ name, severity: v.severity, range: v.range, titles: [...new Set(titles)] });
  }
  return hits;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const shipped = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...(pkg.shippedDevDependencies || []),
  ]);
  if (shipped.size === 0) {
    console.error('shipped 목록이 비어 있다 — package.json 설정 확인 필요');
    process.exit(1);
  }

  const raw = readStdin();
  if (!raw.trim()) {
    console.log('::warning::audit JSON 입력 없음(네트워크 등) — shipped audit 미실행');
    process.exit(0);
  }
  let audit;
  try {
    audit = JSON.parse(raw);
  } catch {
    console.log('audit JSON 파싱 실패 — skip');
    process.exit(0);
  }
  if (audit.error) {
    console.log('npm 측 error 응답 — skip');
    process.exit(0);
  }

  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const { names: reachable, missing } = computeReachable(lock, shipped);
  for (const name of missing) console.log(`경고: lockfile 에서 못 찾음 — ${name}`);

  const hits = findShippedHits(audit, reachable);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const lines = ['## npm audit — 배포물 한정 (blocking)', ''];
  if (hits.length === 0) {
    lines.push(':white_check_mark: 배포되는 패키지에 high/critical advisory 없음.');
    lines.push(
      '',
      `검사 대상(루트 ${shipped.size} → 전이 포함 ${reachable.size}): ${[...shipped].sort().join(', ')}`,
    );
    if (summary) fs.appendFileSync(summary, `${lines.join('\n')}\n`);
    process.exit(0);
  }
  lines.push(':rotating_light: **사용자에게 배포되는 패키지**에 high/critical advisory 가 있다.', '');
  lines.push('| 패키지 | 심각도 | 취약 범위 | 내용 |', '|---|---|---|---|');
  for (const h of hits) {
    lines.push(`| \`${h.name}\` | ${h.severity} | \`${h.range}\` | ${h.titles.join('<br>')} |`);
  }
  if (summary) fs.appendFileSync(summary, `${lines.join('\n')}\n`);
  for (const h of hits) {
    console.error(`::error::${h.name} (${h.severity}, ${h.range}): ${h.titles.join(' / ')}`);
  }
  process.exit(1);
}

// 직접 실행될 때만 동작 — 테스트는 위 순수 함수들을 import 한다.
if (process.argv[1] && process.argv[1].endsWith('audit-shipped.mjs')) main();
