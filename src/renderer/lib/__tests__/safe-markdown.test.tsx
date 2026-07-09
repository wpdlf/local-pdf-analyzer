import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';

// R29 (v0.18.13): test fixtures 의 raw 제어/방향 바이트를 명시적 codepoint 로 치환.
// 이전엔 source 에 raw bytes 가 박혀 있어 grep/diff/리뷰가 어렵고 에디터 normalization 으로
// silently 사라질 위험이 있었음.
const RLO = String.fromCharCode(0x202E);
const LRE = String.fromCharCode(0x202A);
const LRI = String.fromCharCode(0x2066);
const NUL = String.fromCharCode(0x0000);
const TAB = String.fromCharCode(0x0009);
const DEL = String.fromCharCode(0x007F);

// safe-markdown 은 렌더링 없이 컴포넌트 팩토리를 직접 호출해 React element shape 만 검사한다.
// react-testing-library 의존성 없이도 XSS 방어 로직을 빠짐없이 검증 가능.
//
// 내부적으로 i18n/CitationButton/store 가 transitively import 되므로 stub 필요.
vi.stubGlobal('window', {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
});
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
vi.stubGlobal('crypto', { randomUUID: () => 'uuid' });

import { safeComponents } from '../safe-markdown';

type AnchorRender = (props: { href?: string; children?: unknown }) => ReactElement;
type ImgRender = (props: { alt?: string; src?: string }) => ReactElement;

const A = safeComponents.a as unknown as AnchorRender;
const Img = safeComponents.img as unknown as ImgRender;

/** href 를 준 <a> 렌더가 실제 앵커(<a href>) 로 나오는지 검사 */
function isRealAnchor(el: ReactElement, href: string): boolean {
  return el.type === 'a'
    && typeof el.props === 'object'
    && el.props !== null
    && (el.props as { href?: string }).href === href;
}

/** 차단된 링크는 <span title={blockedLink}> 으로 fallback */
function isBlockedSpan(el: ReactElement): boolean {
  return el.type === 'span'
    && typeof el.props === 'object'
    && el.props !== null
    && typeof (el.props as { title?: string }).title === 'string';
}

// ─── href allowlist 테이블 ───
// [input, expected: 'allow' | 'block']
const hrefCases: Array<[string, 'allow' | 'block']> = [
  // 허용
  ['https://example.com', 'allow'],
  ['http://example.com', 'allow'],
  ['https://example.com/path?q=1#frag', 'allow'],
  ['mailto:user@example.com', 'allow'],
  ['#section-id', 'allow'],

  // 명시적 차단 (대표 XSS vector)
  ['javascript:alert(1)', 'block'],
  ['JavaScript:alert(1)', 'block'], // 대소문자 혼합
  ['  javascript:alert(1)', 'block'], // 앞 공백 padding — trim 후 lower
  ['\tjavascript:alert(1)', 'block'],
  ['vbscript:msgbox', 'block'],
  ['VBScript:msgbox', 'block'],
  ['data:text/html,<script>alert(1)</script>', 'block'],
  ['data:image/png;base64,AAAA', 'block'], // data: 는 전체 차단 정책
  ['file:///C:/Windows/System32', 'block'],
  ['File:///etc/passwd', 'block'],

  // scheme 없음 / 상대경로 / 빈 값 — 차단
  ['', 'block'],
  ['   ', 'block'],
  ['./relative', 'block'],
  ['/absolute/path', 'block'],
  ['no-scheme-text', 'block'],
  ['ftp://example.com', 'block'], // 화이트리스트 외 scheme
];

describe('safe-markdown <a> href scheme allowlist', () => {
  for (const [href, expected] of hrefCases) {
    it(`${expected === 'allow' ? '✓' : '✗'} ${JSON.stringify(href)} → ${expected}`, () => {
      const el = A({ href, children: 'link text' }) as ReactElement;
      if (expected === 'allow') {
        expect(isRealAnchor(el, href), `expected <a href="${href}"> but got <${String(el.type)}>`).toBe(true);
        const props = el.props as { target?: string; rel?: string };
        expect(props.target).toBe('_blank');
        expect(props.rel).toBe('noopener noreferrer');
      } else {
        expect(isBlockedSpan(el), `expected blocked <span> but got <${String(el.type)}>`).toBe(true);
      }
    });
  }

  it('href 가 없는 <a> 도 span 으로 fallback (undefined guard)', () => {
    const el = A({ children: 'no href' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });

  it('허용 앵커는 원본 children 을 그대로 전달한다', () => {
    const el = A({ href: 'https://example.com', children: 'hello' }) as ReactElement;
    expect((el.props as { children?: unknown }).children).toBe('hello');
  });
});

describe('safe-markdown <img> — 외부 이미지 로드 차단', () => {
  it('<img> 는 항상 <span> 으로 치환된다 (트래킹 픽셀/외부 리소스 로드 방지)', () => {
    const el = Img({ alt: 'figure 1', src: 'https://example.com/pixel.gif' }) as ReactElement;
    expect(el.type).toBe('span');
  });

  it('<img> 에 alt 가 있으면 placeholder 로 alt 를 표시', () => {
    const el = Img({ alt: 'figure 1', src: 'x' }) as ReactElement;
    expect((el.props as { children?: unknown }).children).toBe('figure 1');
  });

  it('<img> alt 누락이어도 빈 placeholder 로 안전하게 렌더', () => {
    const el = Img({ src: 'x' }) as ReactElement;
    expect(el.type).toBe('span');
    // placeholder 는 i18n 번역키이므로 정확 문자열은 고정할 수 없지만, 비어있지 않아야 함
    expect(typeof (el.props as { children?: unknown }).children).toBe('string');
  });
});

describe('safe-markdown — 허용 scheme 끝에 이어붙인 payload 우회 차단', () => {
  // isSafeHref 는 explicit block list 를 startsWith 로 확인하므로
  // "https://safe.com" 뒤에 "javascript:" 가 붙은 형태는 여전히 https 접두부이기에 허용된다.
  // 하지만 browser/electron 이 해석하지 못해 네비게이션이 안 되므로 실질 위협 없음.
  // 확실한 위협인 "javascript:x;//https://safe" 같은 형태만 명시 차단 여부 확인.
  it('"javascript:x;https://safe" 는 javascript: prefix 로 판정되어 차단', () => {
    const el = A({ href: 'javascript:x;https://safe', children: 'x' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });
});

// R28 P2 (v0.18.12): href 에 bidi override / 제어문자 포함 시 차단.
// 정상적인 https 접두부를 갖더라도 표시 텍스트와 실제 destination 을 시각적으로 위장하는
// LLM 응답 (예: "[github.com](https://attacker.com<U+202E>/...)") 을 거부.
describe('safe-markdown — dangerous unicode in href', () => {
  it('U+202E (RLO) 포함 href 는 차단', () => {
    const el = A({ href: `https://example.com${RLO}/attacker`, children: 'click' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });

  it('U+202A (LRE) 포함 href 는 차단', () => {
    const el = A({ href: `https://example.com/${LRE}phishing`, children: 'click' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });

  it('U+2066 (LRI isolate) 포함 href 는 차단', () => {
    const el = A({ href: `https://example.com/${LRI}x`, children: 'click' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });

  it('null byte (U+0000) 포함 href 는 차단', () => {
    const el = A({ href: `https://example.com/x${NUL}.attacker.com`, children: 'click' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });

  it('tab (U+0009) 포함 href 는 차단', () => {
    const el = A({ href: 'https://example.com/\tx', children: 'click' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });

  it('DEL (U+007F) 포함 href 는 차단', () => {
    const el = A({ href: `https://example.com/${DEL}x`, children: 'click' }) as ReactElement;
    expect(isBlockedSpan(el)).toBe(true);
  });

  it('일반 https URL 은 정상 허용 (회귀 가드)', () => {
    const el = A({ href: 'https://example.com/path?q=1', children: 'click' }) as ReactElement;
    expect(isRealAnchor(el, 'https://example.com/path?q=1')).toBe(true);
  });
});

// v0.18.19 patch R34 P1: MarkdownErrorBoundary 의 componentDidUpdate 동작 회귀 가드.
//
// R32 P2 가 추가한 componentDidUpdate 는 hasError=true latch 후 콘텐츠가 변경되면 reset
// 하여 자연 회복을 시도하는 의도였다. 그러나 R33 Surface 3 에서 발견된 결함은 비교 prop 이
// 잘못 선택된 것: parent (SummaryViewer / QaChat) 가 매 렌더마다 JSX 로 <ReactMarkdown> 을
// 새로 생성하므로 `prevProps.children !== this.props.children` 은 매 렌더 true → hasError 가
// latch 되어도 즉시 reset → 같은 throw 발생 → thrash. R34 fix 는 비교 대상을 fallbackText
// (실제 content 문자열) 로 교체.
import { MarkdownErrorBoundary } from '../safe-markdown';

describe('MarkdownErrorBoundary reset gating (R34 P1)', () => {
  // React component 의 라이프사이클 메서드를 직접 호출해 검증 — 렌더링 없이.
  it('fallbackText 동일 + children identity 변경 시 hasError 유지 (R32→R33 회귀 fix)', () => {
    const boundary = new MarkdownErrorBoundary({
      children: { unique: 1 } as unknown as ReactElement,
      fallbackText: 'same content',
    });
    boundary.state = { hasError: true };
    let nextState: { hasError: boolean } | null = null;
    boundary.setState = (s: { hasError: boolean }) => { nextState = s; };

    // children 이 새 객체이지만 fallbackText 는 동일 → reset 하지 않아야 함
    boundary.componentDidUpdate({
      children: { unique: 0 } as unknown as ReactElement,
      fallbackText: 'same content',
    });
    expect(nextState).toBeNull();
  });

  it('fallbackText 가 실제로 바뀌면 hasError 를 reset', () => {
    const boundary = new MarkdownErrorBoundary({
      children: 'unused' as unknown as ReactElement,
      fallbackText: 'new content',
    });
    boundary.state = { hasError: true };
    let nextState: { hasError: boolean } | null = null;
    boundary.setState = (s: { hasError: boolean }) => { nextState = s; };

    boundary.componentDidUpdate({
      children: 'unused' as unknown as ReactElement,
      fallbackText: 'old content',
    });
    expect(nextState).toEqual({ hasError: false });
  });

  it('hasError=false 상태에선 fallbackText 가 바뀌어도 setState 호출 안 함 (무관 trigger 차단)', () => {
    const boundary = new MarkdownErrorBoundary({
      children: 'x' as unknown as ReactElement,
      fallbackText: 'new',
    });
    boundary.state = { hasError: false };
    let setStateCalled = false;
    boundary.setState = () => { setStateCalled = true; };

    boundary.componentDidUpdate({
      children: 'x' as unknown as ReactElement,
      fallbackText: 'old',
    });
    expect(setStateCalled).toBe(false);
  });

  it('fallbackText 가 양쪽 undefined 면 reset 하지 않음 (불필요 thrash 방지)', () => {
    const boundary = new MarkdownErrorBoundary({
      children: { x: 1 } as unknown as ReactElement,
      // fallbackText omitted both
    });
    boundary.state = { hasError: true };
    let nextState: { hasError: boolean } | null = null;
    boundary.setState = (s: { hasError: boolean }) => { nextState = s; };

    boundary.componentDidUpdate({
      children: { x: 2 } as unknown as ReactElement,
    });
    expect(nextState).toBeNull();
  });

  // QA(③LOW-2): 파싱 실패 fallback 은 <pre> 가 아닌 <div> — 상위 prose 타이포그래피가 <pre> 를
  // 다크 코드블록으로 스타일링하는 것을 피해, Suspense fallback 과 일관되게 원본을 plain text 로 표시.
  it('hasError 시 fallback 은 <div>(pre 아님) 로 원본 텍스트를 표시', () => {
    const boundary = new MarkdownErrorBoundary({
      children: 'unused' as unknown as ReactElement,
      fallbackText: '원본 텍스트',
    });
    boundary.state = { hasError: true };
    const el = boundary.render() as ReactElement;
    expect(el.type).toBe('div');
    expect((el.props as { children: unknown }).children).toBe('원본 텍스트');
  });
});
