// R29 #1 (v0.18.11): postbuild 스크립트 분리.
// 이전에는 package.json 의 build 스크립트에 `node -e "require('fs').cpSync(...)"` 형태로
// 인라인 작성되어 있어서 Windows PowerShell heredoc 인용 처리가 fragile 했다.
// `node scripts/postbuild.mjs` 단일 호출로 분리해 셸 인용 표면을 제거한다.
//
// pdfjs-dist 의 cmaps 디렉터리를 renderer 빌드 산출물에 복사해야 한국어/중국어/일본어
// 등 CJK PDF 글리프가 정상적으로 표시된다. pdfjs 메이저 업그레이드 (4 → 5) 시 cmaps
// 경로가 바뀔 수 있으므로 변경 시 본 스크립트 확인 필요.

import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = resolve(root, 'node_modules/pdfjs-dist/cmaps');
const dest = resolve(root, 'out/renderer/cmaps');

if (!existsSync(src)) {
  console.error(`[postbuild] pdfjs-dist cmaps not found at ${src}`);
  console.error('[postbuild] pdfjs-dist 의 cmaps 경로가 바뀌었거나 의존성이 설치되지 않았습니다.');
  process.exit(1);
}

// R31 P2 (v0.18.19): cpSync 실패 시 친절한 메시지로 종료.
// 이전엔 ENOENT/EACCES/EEXIST 등이 raw stack trace 로 노출돼 빌드 실패 원인 파악이 어려웠다.
try {
  cpSync(src, dest, { recursive: true });
} catch (err) {
  console.error(`[postbuild] cmaps copy failed: ${src} -> ${dest}`);
  console.error(`[postbuild] reason: ${err instanceof Error ? err.message : String(err)}`);
  console.error('[postbuild] dest 디렉터리에 read-only 파일이 남아 있거나 권한 문제일 수 있습니다. out/ 을 비우고 재시도하세요.');
  process.exit(1);
}

// v0.18.19 patch R32 P3: cpSync 가 ENOSPC / 중간 실패로 부분 복사된 채 빠져나오면 NSIS 가
// 깨진 cmap 세트로 패키징되어 사용자가 설치 후에야 CJK 글리프 깨짐을 발견하는 silent
// 결함이 가능. 대표 cmap 파일 존재 확인을 smoke test 로 둠 (Surface 4 P5).
// R34 P2: Adobe-CNS1-UCS2.bcmap (번체 중국어 — 대만/홍콩 PDF) 추가.
// 부분 복사가 정확히 CNS1 만 빠뜨리는 ENOSPC edge 에서도 smoke 가 catch 하도록.
const SMOKE_FILES = ['Adobe-Japan1-UCS2.bcmap', 'Adobe-Korea1-UCS2.bcmap', 'Adobe-GB1-UCS2.bcmap', 'Adobe-CNS1-UCS2.bcmap'];
for (const name of SMOKE_FILES) {
  const probe = resolve(dest, name);
  if (!existsSync(probe)) {
    console.error(`[postbuild] cmaps smoke check FAILED: missing ${probe}`);
    console.error('[postbuild] cmaps 복사가 부분적으로 실패했을 가능성. out/ 을 비우고 재시도하세요.');
    process.exit(1);
  }
  // QA(low): existsSync 만으로는 ENOSPC 가 inode 는 만들고 데이터는 못 쓴 0바이트 파일을
  // 못 잡는다. 크기까지 검증해 0바이트 cmap 이 패키징되는 silent 결함을 차단.
  if (statSync(probe).size === 0) {
    console.error(`[postbuild] cmaps smoke check FAILED: zero-byte ${probe}`);
    console.error('[postbuild] cmaps 가 0바이트로 복사됨(디스크 공간 부족 등). out/ 을 비우고 재시도하세요.');
    process.exit(1);
  }
}
console.log(`[postbuild] copied cmaps: ${src} -> ${dest} (smoke check ok)`);

// ─────────────────────────────────────────────────────────────────────────────
// QA25(D-MED): eager 청크 경계 게이트.
//
// v1.1.0 의 핵심 전제는 "katex 는 **지연** 마크다운 청크에만 들어간다" 이다(math-plugins.ts
// 가 명문화). 그 전제 덕에 지연 청크가 157→435KB 로 커져도 cold start 가 무영향이었다.
// 그런데 이 전제를 지키는 장치가 **사람 눈뿐**이었다 — 누군가 컴포넌트에서 MATH_REMARK_PLUGINS
// 를 정적 import 하면 435KB 가 조용히 eager 로 이동하고, 빌드·유닛·E2E 가 전부 초록이다.
//
// index.html 이 **정적으로 참조하는** 스크립트만 훑어 무거운 지연 전용 라이브러리가 섞였는지
// 본다(동적 import 로 갈라진 async 청크는 참조되지 않으므로 자연히 제외된다).
// packaged-smoke 의 ASAR_MAX_BYTES 와 같은 idiom — 역방향 회귀 가드.
const EAGER_FORBIDDEN = [
  // ⚠️ 청크 **이름**에 여기 패턴이 들어가면 오탐이 난다 — entry 가 동적 import 대상의 파일명을
  // 문자열로 담기 때문이다. manualChunks 에 'katex' 같은 이름을 쓰지 말 것(현재는 math-plugins).
  { name: 'katex', re: /katex/i },
];

/**
 * eager 그래프에 속하는 JS 파일 전부를 모은다.
 *
 * QA26(B/D-Important): 종전에는 `<script src>` 만 훑었다. 그런데 Vite 는 entry 를 `<script>` 로,
 * **entry 가 정적 import 하는 공유 청크**를 `<link rel="modulepreload">` 로 낸다. 실측상 eager
 * JS 446KB 중 253KB(entry)만 검사되고 react-vendor 192KB(43%)는 한 번도 열리지 않았다.
 *
 * 더 나쁜 것은 그것이 **이 게이트가 상정한 시나리오 그 자체**라는 점이다 — 누군가 컴포넌트에서
 * math 플러그인을 정적 import 하면 katex 는 entry 와 async 청크의 공유 모듈이 되어 rollup 이
 * 별도 청크로 뽑고, 그 청크는 entry 의 정적 import 이므로 modulepreload 로 실린다. 게이트가
 * 자기 목적의 시나리오를 통과시킬 수 있었다.
 *
 * html 의 두 출처에서 시작해 **정적 import 를 재귀로 따라간다**. 동적 import(`import("./x")`)는
 * 따라가지 않는다 — 그것이 지연 경계이고, 이 게이트가 지키려는 것이 바로 그 경계다.
 */
function collectEagerFiles(html, dir) {
  // html 의 참조는 문서 기준 상대경로(`./assets/x.js`), 청크 안의 import 는 **그 청크 기준**
  // 상대경로(`./y.js`)다. 둘을 섞으면 경로가 어긋나므로 큐에는 절대경로만 넣는다.
  const queue = [
    ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ...[...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1]),
  ].map((ref) => resolve(dir, ref));

  const seen = new Map(); // 절대경로 → 코드
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!existsSync(file)) {
      // 무음 skip 금지 — 경로 해석이 깨지면 게이트가 조용히 통과한다.
      console.error(`[postbuild] eager 그래프의 파일을 찾지 못했습니다: ${file}`);
      process.exit(1);
    }
    const code = readFileSync(file, 'utf8');
    seen.set(file, code);
    // 정적 import 만 — `from"./x.js"` / `import"./x.js"`. `import("./x.js")` 는 괄호가 오므로
    // 이 패턴에 걸리지 않는다(의도: 동적 경계가 곧 이 게이트가 지키려는 것이다).
    for (const m of code.matchAll(/(?:from|import)\s*["'](\.[^"']+\.js)["']/g)) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  return seen;
}

const indexHtml = resolve(root, 'out/renderer/index.html');
if (!existsSync(indexHtml)) {
  console.error(`[postbuild] out/renderer/index.html 없음 — eager 경계 검사를 건너뛸 수 없습니다`);
  process.exit(1);
}
const eager = collectEagerFiles(readFileSync(indexHtml, 'utf8'), resolve(root, 'out/renderer'));
const failures = [];
const outDir = resolve(root, 'out/renderer');
for (const [abs, code] of eager) {
  const rel = relative(outDir, abs);
  for (const { name, re } of EAGER_FORBIDDEN) {
    if (re.test(code)) failures.push(`${name} in ${rel}`);
  }
}
if (failures.length > 0) {
  console.error('[postbuild] eager 청크 경계 위반:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('[postbuild] 지연 전용 라이브러리가 eager 그래프로 이동했습니다.');
  console.error('[postbuild] 원인은 대개 정적 import 혼입입니다 — math-plugins/markdown-renderer 를');
  console.error('[postbuild] 동적 import 경계(safe-markdown) 밖에서 import 하지 않았는지 확인하세요.');
  process.exit(1);
}
const totalBytes = [...eager.values()].reduce((n, c) => n + Buffer.byteLength(c), 0);
console.log(`[postbuild] eager 청크 경계 ok (파일 ${eager.size}개 / ${(totalBytes / 1024).toFixed(0)}KB 검사)`);
