/**
 * QA29(D1-2): 소스 스캔 가드의 공용 주석 제거기.
 *
 * 이 저장소는 electron 을 import 하는 모듈(main/index.ts, preload/index.ts, App.tsx)을
 * 단위 테스트로 띄울 수 없어서, 배선 계약을 **소스 텍스트 정규식**으로 못박아 왔다.
 * 그 가드들이 **원본 소스**에 매칭하면 다음 두 가지가 조용히 일어난다:
 *
 *  1) 코드를 지워도 **주석에 그 토큰이 남아 있으면 통과** — QA24 에서 실제로 겪었다.
 *     실측(QA29): i18n.ts 에 가짜 키 `zzz.probeOrphan` 을 넣으면 고아 키 가드가 빨개지는데
 *     (1 failed | 20 passed), store.ts 에 그 키 문자열을 **주석 한 줄**로만 적어 넣으면
 *     다시 초록이 됐다(21 passed). 코드는 아무것도 참조하지 않는데도.
 *  2) 반대 방향 — 주석 처리된 `t('없는키')` 가 **거짓 실패**를 만든다.
 *
 * 종전에는 window-lifecycle.test.ts 와 window-size.test.ts 두 곳만 `.replace(/\/\*…/)` 를
 * 인라인으로 갖고 있었고 나머지 8곳은 원본을 그대로 봤다. "한 곳씩 열거"가 이 저장소의
 * 최다 결함 클래스이므로(형제 누락), 제거기를 **한 곳**에 두고 모든 가드가 이것을 부른다.
 *
 * 위치 근거: `src/shared/__tests__/` 는 이미 저장소 전역 메타 가드(audit-shipped ·
 * eager-graph · coverage-drift · e2e-ollama-gated)의 집이다. `helpers/` 하위는
 *   - vitest `include: src/**\/*.{test,spec}.{ts,tsx}` 에 걸리지 않아 스위트로 수집되지 않고,
 *   - coverage `exclude: **\/__tests__/**` 라 분모에 들어가지 않으며,
 *   - i18n.test 의 소스 워커가 `__tests__` 디렉터리를 건너뛰므로 스캔 대상도 아니다.
 * 즉 이 파일을 추가하는 것만으로 어떤 게이트의 숫자도 움직이지 않는다.
 */

import { readFileSync } from 'node:fs';

/** 주석 구간을 공백으로 덮는다 — 줄바꿈은 보존해 오프셋과 줄 번호가 원본과 같게 유지된다. */
function blank(out: string[], from: number, to: number): void {
  for (let k = from; k < to; k++) {
    const c = out[k];
    if (c !== '\n' && c !== '\r') out[k] = ' ';
  }
}

/** 정규식 리터럴이 올 수 있는 직전 문자(연산자·구분자). 그 외(식별자·숫자·`)`·`]`)면 나눗셈이다. */
const REGEX_PRECEDERS = new Set([
  '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);
/** 뒤에 정규식이 올 수 있는 키워드. `return /x/` 같은 자리. */
const REGEX_KEYWORDS = [
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else',
  'yield', 'await',
];

/** src[i] 의 `/` 가 정규식 리터럴의 시작인지(=나눗셈이 아닌지) 직전 토큰으로 추정. */
function looksLikeRegexStart(src: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j]!)) j--;
  if (j < 0) return true;
  const prev = src[j]!;
  if (REGEX_PRECEDERS.has(prev)) return true;
  if (/[A-Za-z]/.test(prev)) {
    let k = j;
    while (k >= 0 && /[A-Za-z]/.test(src[k]!)) k--;
    return REGEX_KEYWORDS.includes(src.slice(k + 1, j + 1));
  }
  return false;
}

/**
 * 정규식 리터럴의 끝 `/` 위치(+1)를 찾는다. **같은 줄 안에서** 끝나지 않으면 -1 —
 * 정규식 리터럴은 줄을 넘지 못하므로, 못 찾았다는 것은 애초에 나눗셈이었다는 뜻이다.
 * 이 하한이 없으면 오탐 1건이 파일 나머지를 통째로 삼켜 **조용히** 가드를 비운다.
 */
function findRegexEnd(src: string, start: number): number {
  let inClass = false;
  for (let k = start + 1; k < src.length; k++) {
    const c = src[k]!;
    if (c === '\n') return -1;
    if (c === '\\') { k++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '/') return k + 1;
  }
  return -1;
}

/** `'`/`"` 문자열의 끝 위치(+1). 같은 줄에서 닫히지 않으면 -1(따옴표가 아니라 그냥 문자였다). */
function findQuoteEnd(src: string, start: number): number {
  const q = src[start]!;
  for (let k = start + 1; k < src.length; k++) {
    const c = src[k]!;
    if (c === '\n') return -1;
    if (c === '\\') { k++; continue; }
    if (c === q) return k + 1;
  }
  return -1;
}

/** 템플릿 리터럴의 끝 위치(+1). 여러 줄이 정상이므로 줄 하한을 두지 않는다. */
function findTemplateEnd(src: string, start: number): number {
  for (let k = start + 1; k < src.length; k++) {
    const c = src[k]!;
    if (c === '\\') { k++; continue; }
    if (c === '`') return k + 1;
  }
  return src.length;
}

/**
 * TS/TSX 소스에서 `/* *\/` 와 `//` 주석을 지운다(공백으로 치환, 오프셋 보존).
 *
 * 문자열·템플릿·정규식 리터럴 **안**의 `//` 는 건드리지 않는다 — 이걸 안 하면
 * `'https://…'` 의 뒤쪽이 통째로 날아가 가드가 거짓 실패한다(예: preload 의 openExternal
 * https 가드, App.tsx 의 릴리즈 URL).
 */
export function stripJsComments(src: string): string {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (c === '`') { i = findTemplateEnd(src, i); continue; }
    if (c === '"' || c === "'") {
      const end = findQuoteEnd(src, i);
      i = end === -1 ? i + 1 : end;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blank(out, i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      // 정규식 안의 `\/\/`(예: /https?:\/\//) 나 문자열 밖의 `://` 는 주석이 아니다.
      // 리터럴 추적으로 대부분 걸러지지만, 오탐이 조용한 손실을 만드는 자리라 한 겹 더 둔다.
      const prev = i > 0 ? src[i - 1] : '';
      if (prev === '\\' || prev === ':') { i += 1; continue; }
      let j = src.indexOf('\n', i);
      if (j === -1) j = n;
      blank(out, i, j);
      i = j;
      continue;
    }
    if (c === '/') {
      if (looksLikeRegexStart(src, i)) {
        const end = findRegexEnd(src, i);
        if (end !== -1) { i = end; continue; }
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 한 줄에서 YAML/셸 `#` 주석을 지운다. 따옴표 추적이 실패하면(줄 안에서 안 닫힘) 무시하고 재시도. */
function stripYamlLine(line: string, trackQuotes: boolean): string | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (quote === '"' && c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (trackQuotes && (c === '"' || c === "'")) { quote = c; continue; }
    // YAML/셸 모두 `#` 는 줄 처음이거나 공백 뒤에서만 주석이다.
    // (`${VAR#prefix}` · `sha256#...` 처럼 붙어 있는 것은 주석이 아니다.)
    if (c === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) {
      return line.slice(0, i) + ' '.repeat(line.length - i);
    }
  }
  return quote === null ? line : null;
}

/**
 * 워크플로 YAML(그 안의 `run:` 셸 블록 포함)에서 `#` 주석을 지운다.
 *
 * JS 쪽과 분리한 이유는 문법이 다르기 때문만이 아니다 — 워크플로 스캔 가드
 * (audit-shipped.test 의 "워크플로 배선")가 보는 토큰(`audit-shipped.mjs`)은 **주석 안에도
 * 여러 번 등장**한다. 즉 스텝을 통째로 지워도 설명 주석만 남으면 통과하는, D1-2 와 정확히
 * 같은 구멍이 그쪽에도 있었다.
 */
export function stripYamlComments(src: string): string {
  return src
    .split('\n')
    .map((line) => stripYamlLine(line, true) ?? stripYamlLine(line, false) ?? line)
    .join('\n');
}

/**
 * HTML 주석(`<!-- ... -->`)을 공백으로 덮는다 — 줄 번호와 오프셋은 원본과 같게 보존한다.
 *
 * QA31(수렴 B·D): `index.html` 의 CSP 를 검사하는 가드가 원본을 그대로 읽어, **주석 처리된 옛
 * CSP** 를 검사하고 있었다. 실물 meta 가 `script-src 'unsafe-inline'` 이어도 2/2 통과한다.
 * `.html` 이 아래 확장자 목록과 source-scan.test 의 파생 규칙 **양쪽 모두**에서 빠져 있었던 것이
 * 뿌리다(QA24→29→30 에 이은 같은 클래스 네 번째 재발이고, 이번엔 보안 컨트롤 위였다).
 *
 * ※ `<script>` 본문에 리터럴 `<!--` 가 있으면 그 뒤를 주석으로 보고 지운다. HTML 명세상으로는
 *   주석이 아니지만, 그 경우 해시 단언이 **시끄럽게 실패**하므로 조용한 오검출은 아니다.
 */
export function stripHtmlComments(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const to = end === -1 ? src.length : end + 3;
      blank(out, i, to);
      i = to;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 주석 문법을 가진 소스 확장자 — 이것들은 반드시 제거기를 거쳐야 한다. */
const COMMENTED_SOURCE_EXT = /\.(?:[mc]?tsx?|[mc]?jsx?|ya?ml|html?)$/i;

/**
 * QA30(D2): **소스가 아닌** 산출물(생성된 요약·리포트 등)을 텍스트로 읽는 유일한 통로.
 *
 * source-scan.test 의 파생 가드는 "파생된 가드 파일 안의 모든 `readFileSync` 는 제거기나
 * `JSON.parse` 로 감싸여 있어야 한다" 를 강제한다 — 그 규칙에 예외를 뚫는 대신, 소스가
 * **아님을 확장자로 증명**하는 함수를 하나 둔다. 여기에 `.ts`/`.yml` 을 넘기면 던진다.
 */
export function readGeneratedText(path: string): string {
  if (COMMENTED_SOURCE_EXT.test(path)) {
    throw new Error(`readGeneratedText 는 소스 파일에 쓸 수 없습니다(주석이 걸러지지 않는다): ${path}`);
  }
  return readFileSync(path, 'utf8');
}
