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
// QA29(D2-1): 이 게이트는 **축퇴 입력에서 무증상 통과**했다. 워크플로가
// `AUDIT_JSON=$(npm audit --json 2>/dev/null || true)` 로 종료코드와 stderr 를 함께 삼키므로,
// 레지스트리 인증 실패·네트워크 플레이크·npm 출력 형식 변경이 전부 빈 문자열이나 `{}` 로
// 도착한다. 실측: `''`→경고 후 exit 0, `not json`→평문 skip exit 0, `{}`→**출력 한 줄 없이**
// exit 0, `{"error":{...}}`→평문 skip exit 0. 즉 태그 경로의 유일한 blocking 공급망 게이트가
// 아무 흔적 없이 사라질 수 있었다. 이제 모든 skip 경로가 `::warning::` 를 내고, 종료코드를
// 갈라 **정책은 워크플로가** 정한다(test.yml=경고 후 통과 / release.yml=1회 재시도 후 실패).
//
// 사용법: `npm audit --json | node scripts/audit-shipped.mjs`
// 종료 코드: 0 = 배포물에 high/critical 없음, 1 = 있음(또는 설정 오류),
//            2 = audit JSON 이 쓸 수 없는 형태라 **검사하지 못함**(통과가 아니다).

import fs from 'node:fs';

const NODE_MODULES = 'node_modules/';

/** 검사 불가(축퇴 입력) 종료코드. 0(통과)과 1(위반) 어느 쪽도 아니라는 것이 요지다. */
export const EXIT_UNUSABLE_INPUT = 2;

/**
 * audit JSON 원문이 실제로 판정 가능한 형태인지 본다.
 * `npm audit --json` 은 항상 `vulnerabilities` 객체를 포함한다(권고가 0건이면 `{}`).
 * 그것이 없다는 것은 실패 응답이거나 출력 형식이 바뀌었다는 뜻이지, "취약점 없음" 이 아니다.
 *
 * @returns {{ ok: true, audit: object } | { ok: false, reason: string }}
 */
export function parseAuditInput(raw) {
  if (!raw || !raw.trim()) return { ok: false, reason: 'audit JSON 입력이 비어 있습니다(네트워크·인증 실패 등)' };
  let audit;
  try {
    audit = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'audit JSON 파싱 실패 — npm 이 JSON 이 아닌 출력을 냈습니다' };
  }
  if (!audit || typeof audit !== 'object') return { ok: false, reason: 'audit JSON 이 객체가 아닙니다' };
  if (audit.error) {
    const code = audit.error.code || audit.error.summary || 'unknown';
    return { ok: false, reason: `npm 측 error 응답(${code})` };
  }
  if (!audit.vulnerabilities || typeof audit.vulnerabilities !== 'object') {
    return { ok: false, reason: 'audit JSON 에 vulnerabilities 필드가 없습니다 — 실패 응답이거나 출력 형식이 바뀌었습니다' };
  }
  return { ok: true, audit };
}

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

/**
 * audit JSON 에서 배포물에 도달하는 high/critical 만 골라낸다.
 *
 * 판정 대상은 두 종류다:
 *  - `reachable` — vite 가 번들해 asar 에 들어가는 것의 **의존 폐포**(전이 포함)
 *  - `runtimeBinaries` — electron 처럼 배포물에 **바이너리로** 실리는 것의 **이름만**.
 *    이쪽은 폐포를 넓히지 않는다. npm 의존이 설치 시점 전용이라 배포물에 없기 때문이고,
 *    넓히면 이 게이트가 없애려던 빌드툴 노이즈가 되살아난다(QA26 D-High).
 */
export function findShippedHits(audit, reachable, runtimeBinaries = new Set()) {
  const hits = [];
  for (const [name, v] of Object.entries(audit.vulnerabilities || {})) {
    if (!reachable.has(name) && !runtimeBinaries.has(name)) continue;
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

  const parsed = parseAuditInput(readStdin());
  if (!parsed.ok) {
    // 모든 축퇴 경로가 같은 형태로, 반드시 한 줄을 남긴다 — 종전에는 `{}` 가 아무 출력도
    // 남기지 않아 로그만 보고는 게이트가 돌았는지조차 알 수 없었다.
    console.log(`::warning::배포물 audit 을 실행하지 못했습니다 — ${parsed.reason}`);
    process.exit(EXIT_UNUSABLE_INPUT);
  }
  const audit = parsed.audit;

  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const { names: reachable, missing } = computeReachable(lock, shipped);
  // QA26(B-Low): 오타·이름 변경으로 루트를 못 찾으면 **검사 범위가 조용히 줄어든다**.
  // 이 게이트의 실패 모드가 '빨간불' 이 아니라 '조용한 통과' 라는 점이 QA25 의 출발점이었다.
  // Actions 로그에 경고로 띄워 최소한 눈에는 걸리게 한다.
  for (const name of missing) console.log(`::warning::shipped 목록의 ${name} 을 lockfile 에서 찾지 못했습니다 — 검사 범위에서 빠집니다`);

  const runtimeBinaries = new Set(pkg.shippedRuntimeBinaries || []);
  const hits = findShippedHits(audit, reachable, runtimeBinaries);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  const lines = ['## npm audit — 배포물 한정 (blocking)', ''];
  if (hits.length === 0) {
    lines.push(':white_check_mark: 배포되는 패키지에 high/critical advisory 없음.');
    lines.push(
      '',
      `검사 대상(번들: 루트 ${shipped.size} → 전이 포함 ${reachable.size}) ${[...shipped].sort().join(', ')}`,
      `검사 대상(런타임 바이너리, 이름 대조): ${[...runtimeBinaries].sort().join(', ') || '(없음)'}`,
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
