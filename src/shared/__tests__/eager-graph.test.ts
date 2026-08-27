import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
// @ts-expect-error — 빌드 스크립트(.mjs)에는 타입 선언이 없다. 계약이 단순해 런타임 검증으로 충분.
import { collectEagerFiles, checkEagerScope, EAGER_MIN_FILES, EAGER_MIN_BYTES } from '../../../scripts/eager-graph.mjs';

/**
 * QA27(D-Important): eager 청크 경계 게이트에 테스트가 **한 건도 없었다**.
 *
 * 이 게이트는 이미 한 번(QA26 B/D-Important) "자기 목적의 시나리오를 통과시키는" 상태로
 * 출시된 전력이 있다 — `<script src>` 만 훑어 eager 의 43%(react-vendor)를 못 봤고, 정확히
 * 그 청크가 katex 정적 import 시 katex 를 싣는 자리였다. 고친 뒤에도 규칙을 지키는 것은
 * 사람 눈뿐이었다.
 *
 * 실패 모드가 '빨간불' 이 아니라 **조용한 축소**라는 점이 핵심이다: 추출이 0건이 되어도
 * 금지 패턴 검사는 아무 위반도 못 찾고 빌드는 초록으로 끝난다. 그래서 여기서 고정하는 것은
 * "위반을 잡는가" 뿐 아니라 **"범위가 줄면 실패하는가"** 다.
 */

const DIR = resolve('/out/renderer');
const abs = (name: string) => resolve(DIR, name);

/** 가상 파일 시스템 주입 — 실제 빌드 산출물 없이 추출 규칙만 본다. */
function io(files: Record<string, string>) {
  const map = new Map(Object.entries(files).map(([k, v]) => [abs(k), v]));
  return {
    existsSync: (p: string) => map.has(p),
    readFileSync: (p: string) => map.get(p) ?? '',
  };
}

describe('collectEagerFiles — eager 그래프 수집', () => {
  it('entry(script)와 공유 청크(modulepreload)를 모두 훑는다', () => {
    const html = '<script type="module" src="./assets/index.js"></script>'
      + '<link rel="modulepreload" href="./assets/react-vendor.js">';
    const r = collectEagerFiles(html, DIR, io({
      'assets/index.js': 'console.log(1)',
      'assets/react-vendor.js': 'console.log(2)',
    }));
    expect(r.error).toBeNull();
    // QA26 의 결함: modulepreload 를 빼면 여기가 1이 되고 게이트는 그대로 통과했다.
    expect(r.files.size).toBe(2);
  });

  it('정적 import 는 재귀로 따라간다', () => {
    const html = '<script src="./assets/index.js"></script>';
    const r = collectEagerFiles(html, DIR, io({
      'assets/index.js': 'import"./shared.js";',
      'assets/shared.js': 'export const a=1;',
    }));
    expect(r.error).toBeNull();
    expect(r.files.size).toBe(2);
  });

  it('동적 import 는 따라가지 않는다 — 그 경계가 이 게이트가 지키려는 것이다', () => {
    const html = '<script src="./assets/index.js"></script>';
    const r = collectEagerFiles(html, DIR, io({
      'assets/index.js': 'const m=()=>import("./lazy.js");',
      'assets/lazy.js': 'katex',
    }));
    expect(r.error).toBeNull();
    expect(r.files.size).toBe(1);
    expect([...r.files.keys()].some((k: string) => String(k).includes('lazy'))).toBe(false);
  });

  it('modulepreload 속성 순서가 바뀌어 추출이 0건이면 실패한다 (조용한 축소 차단)', () => {
    // Vite 가 `<link href=... rel="modulepreload">` 로 내거나 as="script" 를 끼우면 정규식이
    // 빗나간다. 종전 구현은 그 경우 entry 만 검사한 채 **exit 0** 으로 통과했다.
    const html = '<script src="./assets/index.js"></script>'
      + '<link href="./assets/react-vendor.js" rel="modulepreload">';
    const r = collectEagerFiles(html, DIR, io({
      'assets/index.js': 'console.log(1)',
      'assets/react-vendor.js': 'console.log(2)',
    }));
    expect(r.error, '추출 실패를 통과시키면 게이트가 조용히 반쪽이 된다').toBeTruthy();
    expect(String(r.error)).toContain('modulepreload');
  });

  it('QA28(A-Low): modulepreload 3개 중 1개만 속성 순서가 달라도 부분 추출로 보고 실패한다', () => {
    // 종전 "0건일 때만" 검사는 일부 링크에만 속성이 끼어든 **부분** 축소를 통과시켰다.
    const html = '<script src="./assets/index.js"></script>'
      + '<link rel="modulepreload" href="./assets/a.js">'
      + '<link href="./assets/b.js" rel="modulepreload">'
      + '<link rel="modulepreload" href="./assets/c.js">';
    const r = collectEagerFiles(html, DIR, io({
      'assets/index.js': '1', 'assets/a.js': '2', 'assets/b.js': '3', 'assets/c.js': '4',
    }));
    expect(r.error).toBeTruthy();
    expect(String(r.error)).toContain('3개 중 2개');
  });

  it('참조된 파일이 없으면 무음 skip 하지 않고 실패한다', () => {
    const html = '<script src="./assets/index.js"></script>';
    const r = collectEagerFiles(html, DIR, io({}));
    expect(r.error).toBeTruthy();
  });

  it('modulepreload 가 애초에 없는 html 은 정상 통과한다 (오탐 방지)', () => {
    const html = '<script src="./assets/index.js"></script>';
    const r = collectEagerFiles(html, DIR, io({ 'assets/index.js': 'x' }));
    expect(r.error).toBeNull();
    expect(r.files.size).toBe(1);
  });
});

describe('checkEagerScope — 검사 범위 하한', () => {
  it('실측 규모(2파일/436KB)는 통과한다', () => {
    expect(checkEagerScope(2, 436 * 1024)).toBeNull();
  });

  it('entry 하나로 줄면(QA26 회귀 재현) 실패한다', () => {
    expect(checkEagerScope(1, 253 * 1024)).toBeTruthy();
  });

  it('파일 수는 맞아도 바이트가 붕괴하면 실패한다', () => {
    expect(checkEagerScope(2, 10 * 1024)).toBeTruthy();
  });

  it('하한은 실측보다 낮게 잡혀 정상 증감에 걸리지 않는다', () => {
    expect(EAGER_MIN_FILES).toBeLessThanOrEqual(2);
    expect(EAGER_MIN_BYTES).toBeLessThan(436 * 1024);
  });
});
