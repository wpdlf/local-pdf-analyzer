// eager 청크 경계 게이트의 순수 부분 — index.html 에서 **정적으로 도달 가능한** JS 그래프 수집.
//
// QA27(D-Important): postbuild.mjs 안에 인라인돼 있어 단위 테스트가 불가능했다. 그런데 이
// 게이트는 이미 한 번(QA26) "자기 목적의 시나리오를 통과시키는" 상태로 출시된 전력이 있고,
// 실패 모드가 빨간불이 아니라 **조용한 축소**라 회귀를 눈으로 알아챌 수 없다. 순수 부분을
// 분리해 추출 규칙 자체를 고정한다(update-policy·window-flush-policy 와 같은 처리).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * index.html 의 정적 참조에서 시작해 eager 그래프의 JS 파일을 전부 모은다.
 *
 * 두 출처를 본다 — entry 의 `<script src>` 와 entry 가 정적 import 하는 공유 청크의
 * `<link rel="modulepreload">`. 후자를 빼면 실측상 eager 의 43%(react-vendor)가 검사되지
 * 않았고, 그것이 정확히 이 게이트가 잡아야 할 시나리오였다(QA26 B/D-Important).
 *
 * 동적 import(`import("./x.js")`)는 따라가지 않는다 — 그 경계가 이 게이트가 지키려는 것이다.
 *
 * @param html index.html 내용
 * @param dir  html 이 있는 디렉터리(절대경로)
 * @param io   파일 접근 주입(테스트용). 미지정 시 실제 fs.
 * @returns {{ files: Map<string,string>, error: string | null }}
 *          error 가 null 이 아니면 호출자가 빌드를 실패시켜야 한다.
 */
export function collectEagerFiles(html, dir, io = { existsSync, readFileSync }) {
  // QA27(D-Important): modulepreload 추출은 **속성 순서에 의존**한다(`rel` 이 `href` 보다 먼저).
  // Vite 가 순서를 바꾸거나 `as="script"` 를 끼워 넣으면 매칭이 0 이 되고, 게이트는 entry 만
  // 검사한 채 통과한다 — QA26 이 고친 회귀와 글자 그대로 같은 상태다. 조용한 축소를 막는다.
  const preloads = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map((m) => m[1]);
  // QA28(A-Low): "전부 실패" 만 잡으면 일부 링크에만 속성이 끼어든 **부분** 추출 실패는 통과한다.
  // modulepreload 링크의 개수와 추출 수를 대조해 하나라도 빠지면 실패시킨다.
  const linkCount = (html.match(/<link\b[^>]*\bmodulepreload\b/g) ?? []).length;
  if (preloads.length !== linkCount) {
    return {
      files: new Map(),
      error: `index.html 의 modulepreload 링크 ${linkCount}개 중 ${preloads.length}개만 추출했습니다 — 속성 순서가 바뀌었을 가능성(게이트 범위가 조용히 줄어듭니다).`,
    };
  }

  // html 의 참조는 문서 기준 상대경로(`./assets/x.js`), 청크 안의 import 는 **그 청크 기준**
  // 상대경로(`./y.js`)다. 둘을 섞으면 경로가 어긋나므로 큐에는 절대경로만 넣는다.
  const queue = [
    ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ...preloads,
  ].map((ref) => resolve(dir, ref));

  const seen = new Map(); // 절대경로 → 코드
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    if (!io.existsSync(file)) {
      // 무음 skip 금지 — 경로 해석이 깨지면 게이트가 조용히 통과한다.
      return { files: seen, error: `eager 그래프의 파일을 찾지 못했습니다: ${file}` };
    }
    const code = io.readFileSync(file, 'utf8');
    seen.set(file, code);
    // 정적 import 만 — `from"./x.js"` / `import"./x.js"`. `import("./x.js")` 는 괄호가 오므로
    // 이 패턴에 걸리지 않는다(의도: 동적 경계가 곧 이 게이트가 지키려는 것이다).
    for (const m of code.matchAll(/(?:from|import)\s*["'](\.[^"']+\.js)["']/g)) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  return { files: seen, error: null };
}

/**
 * 검사 범위가 조용히 줄어들지 않았는지 본다.
 *
 * 이 게이트의 실패 모드는 '빨간불' 이 아니라 **조용한 축소**다 — 범위가 entry 하나로 줄어도
 * 금지 패턴 검사는 아무 위반도 못 찾고 통과한다. 실측(2026-08-21) eager 는 파일 2개 / 436KB.
 * 그 절반 아래로 떨어지면 추출이 깨진 것으로 본다(정상 증감에는 걸리지 않는 느슨한 하한).
 */
export const EAGER_MIN_FILES = 2;
export const EAGER_MIN_BYTES = 400 * 1024;

/** @returns {string | null} 위반 사유(있으면 빌드 실패) */
export function checkEagerScope(fileCount, totalBytes) {
  if (fileCount >= EAGER_MIN_FILES && totalBytes >= EAGER_MIN_BYTES) return null;
  return `eager 검사 범위가 비정상적으로 작습니다: 파일 ${fileCount}개 / ${(totalBytes / 1024).toFixed(0)}KB `
    + `(하한 ${EAGER_MIN_FILES}개 / ${(EAGER_MIN_BYTES / 1024).toFixed(0)}KB)`;
}
