// R29 #1 (v0.18.11): postbuild 스크립트 분리.
// 이전에는 package.json 의 build 스크립트에 `node -e "require('fs').cpSync(...)"` 형태로
// 인라인 작성되어 있어서 Windows PowerShell heredoc 인용 처리가 fragile 했다.
// `node scripts/postbuild.mjs` 단일 호출로 분리해 셸 인용 표면을 제거한다.
//
// pdfjs-dist 의 cmaps 디렉터리를 renderer 빌드 산출물에 복사해야 한국어/중국어/일본어
// 등 CJK PDF 글리프가 정상적으로 표시된다. pdfjs 메이저 업그레이드 (4 → 5) 시 cmaps
// 경로가 바뀔 수 있으므로 변경 시 본 스크립트 확인 필요.

import { cpSync, existsSync, readFileSync, statSync } from 'node:fs';
import { collectEagerFiles, checkEagerScope } from './eager-graph.mjs';
import { relative, resolve } from 'node:path';

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

// QA27(D-Low): 의도적으로 지연 경계 밖에 둔 무거운 청크는 katex 만이 아니다 — pdfjs(~1MB)도
// electron.vite.config.ts 가 별도 청크로 분리해 **첫 PDF 업로드 직전까지** 로드되지 않게 해
// 두었는데, 그 전제를 지키는 장치가 없었다.
//
// 다만 내용 매칭(`GlobalWorkerOptions` 등)은 오탐이다 — entry 는 그 심볼을 **동적 import 의
// 콜백 안에서** 참조하므로 문자열이 entry 코드에 그대로 남는다(실측 확인). 지켜야 할 불변식은
// "그 청크가 eager 그래프에 **들어왔는가**" 이고, collectEagerFiles 는 정적 import 만 따라가므로
// 그 청크가 목록에 나타나는 것 자체가 곧 위반이다. 파일명으로 판정한다.
const EAGER_FORBIDDEN_CHUNKS = [/(^|[\\/])pdfjs-[^\\/]*\.js$/];

// 그래프 수집 규칙(어디까지가 eager 인가)은 eager-graph.mjs 가 소유한다 — QA27(D-Important)
// 에서 순수 분리해 단위 테스트 대상이 됐다. 여기서는 금지 패턴 판정과 종료 처리만 한다.
const indexHtml = resolve(root, 'out/renderer/index.html');
if (!existsSync(indexHtml)) {
  console.error(`[postbuild] out/renderer/index.html 없음 — eager 경계 검사를 건너뛸 수 없습니다`);
  process.exit(1);
}
const { files: eager, error: collectError } = collectEagerFiles(
  readFileSync(indexHtml, 'utf8'),
  resolve(root, 'out/renderer'),
);
if (collectError) {
  console.error(`[postbuild] ${collectError}`);
  process.exit(1);
}
const failures = [];
const outDir = resolve(root, 'out/renderer');
for (const [abs, code] of eager) {
  const rel = relative(outDir, abs);
  for (const { name, re } of EAGER_FORBIDDEN) {
    if (re.test(code)) failures.push(`${name} in ${rel}`);
  }
  for (const re of EAGER_FORBIDDEN_CHUNKS) {
    if (re.test(rel)) failures.push(`지연 전용 청크가 eager 그래프에 있음: ${rel}`);
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
// QA27(D-Important): 이 게이트의 실패 모드는 '빨간불' 이 아니라 **조용한 축소**다 — 범위가
// entry 하나로 줄어도 위 루프는 아무 위반도 못 찾고 exit 0 으로 끝난다.
const scopeError = checkEagerScope(eager.size, totalBytes);
if (scopeError) {
  console.error(`[postbuild] ${scopeError}`);
  console.error('[postbuild] 번들 구조가 의도적으로 바뀐 것이라면 eager-graph.mjs 의 하한을 함께 갱신하세요.');
  process.exit(1);
}
console.log(`[postbuild] eager 청크 경계 ok (파일 ${eager.size}개 / ${(totalBytes / 1024).toFixed(0)}KB 검사)`);
