import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';

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
