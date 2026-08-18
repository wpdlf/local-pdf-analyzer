// @vitest-environment happy-dom

// 수식 렌더링 통합 검증 — 목 없이 실제 SafeMarkdown(React.lazy → markdown-renderer →
// react-markdown + remark-math + rehype-katex)을 렌더해 `\(…\)` 가 MathML 로 나오는지 본다.
//
// math-normalize.test.ts 는 문자열 변환만 증명한다. 그것만으로는 **플러그인 배선이 빠져도
// 그린**이 되므로(정규화된 `$$…$$` 가 그대로 평문으로 남을 뿐), 실제 DOM 을 보는 이 테스트가
// 배선의 유일한 가드다. export-html(PDF 내보내기) 경로는 export-html.test.ts 가 따로 본다.
//
// ⚠️ 대기 조건 주의: SafeMarkdown 의 Suspense 폴백은 **원문 문자열을 그대로** 표시한다. 따라서
// `findByText(/일부문구/)` 는 파싱 전 폴백에 즉시 매칭돼 버려, "수식이 없다" 류의 부정 단언이
// 통째로 공허해진다(실제로 이 테스트를 처음 쓸 때 그 함정에 빠졌다). 폴백이 사라진 것을 먼저
// 확인한 뒤에만 DOM 을 단언한다.

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MATH_REHYPE_PLUGINS } from '../math-plugins';
import { SafeMarkdown } from '../safe-markdown';

afterEach(() => cleanup());

/** 폴백(원문 plain text)이 사라져 실제 파싱 결과가 DOM 에 들어온 뒤 컨테이너를 돌려준다. */
async function renderResolved(content: string): Promise<HTMLElement> {
  const { container } = render(<SafeMarkdown content={content} />);
  await waitFor(
    () => {
      // 폴백과 ErrorBoundary 강등이 공유하는 마커 — 둘 다 사라져야 파싱 성공이다.
      expect(container.querySelector('div.whitespace-pre-wrap')).toBeNull();
    },
    { timeout: 5000 },
  );
  return container;
}

describe('수식 렌더링 (통합)', () => {
  it('`\\(…\\)` 가 MathML 로 렌더된다', async () => {
    const container = await renderResolved('수식 \\(E=mc^2\\) 확인');
    const math = container.querySelector('math');
    expect(math).not.toBeNull();
    // katex 가 실제로 파싱했다는 증거 — 변수/지수가 MathML 원소로 분해된다.
    expect(math!.querySelectorAll('mi').length).toBeGreaterThan(0);
    expect(math!.querySelector('msup')).not.toBeNull(); // c^2
  });

  it('구분자가 각각 다른 줄에 있는 display 표준형도 렌더된다', async () => {
    const container = await renderResolved('앞\n\n\\[\nE = mc^2\n\\]\n\n뒤');
    expect(container.querySelector('math')).not.toBeNull();
  });

  it('LLM 이 직접 낸 `$$…$$` 도 렌더된다', async () => {
    const container = await renderResolved('앞 $$a^2 + b^2$$ 뒤');
    expect(container.querySelector('math')).not.toBeNull();
  });

  it('홑 `$` 통화 표기는 수식이 되지 않는다', async () => {
    // singleDollarTextMath: false 의 회귀 가드. 켜지면 "100 에서 " 가 수식으로 둔갑한다.
    const container = await renderResolved('가격은 $100 에서 $200 로 올랐다');
    expect(container.querySelector('p')).not.toBeNull(); // 파싱은 됐고
    expect(container.querySelector('math')).toBeNull();  // 수식은 아니다
  });

  it('깨진 LaTeX 은 그 수식만 오류 표시로 강등되고 문서는 살아남는다', async () => {
    // 수식 하나가 깨졌다고 MarkdownErrorBoundary 가 **요약 전체를 원문 plain text 로** 떨어뜨리면
    // 원래 문제(수식이 리터럴로 보임)보다 나쁘다. 국소 강등이 유지되는지 본다.
    //
    // ※ 이 성질의 실제 근거는 math-plugins 의 throwOnError 가 아니라 rehype-katex 의 내부
    //   ParseError 처리다(실측: 옵션을 뒤집어도 출력 동일). 그래서 옵션이 아니라 **관측 가능한
    //   결과**(katex-error 국소화 + 나머지 마크다운 생존)를 단언한다.
    const container = await renderResolved('**굵게** 그리고 \\(\\frac{a\\) 깨진 수식');
    const strong = container.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe('굵게');           // 마크다운 파싱이 살아 있고
    const err = container.querySelector('.katex-error'); // 깨진 수식은 국소 오류 표시
    expect(err).not.toBeNull();
    expect(err!.textContent).toContain('\\frac{a');      // 원문을 잃지 않는다
  });

  it('수식 옆의 인용 [p.N] 이 그대로 CitationButton 으로 남는다', async () => {
    await renderResolved('수식 \\(E=mc^2\\)은 등가성이다[p.8].');
    const cite = await screen.findByText('[p.8]', {}, { timeout: 5000 });
    expect(['SPAN', 'BUTTON']).toContain(cite.tagName);
  });

  it('코드블록 안의 `\\(` 는 수식이 되지 않는다', async () => {
    const container = await renderResolved('설명\n\n```js\nconst re = /\\(a\\)/;\n```\n');
    expect(container.querySelector('code')).not.toBeNull(); // 코드블록으로 파싱됐고
    expect(container.querySelector('math')).toBeNull();     // 수식은 아니다
  });
});

// QA25(C-LOW): `trust: false` 회귀 가드.
//
// math-plugins 는 본문이 LLM 출력이므로 `\href`/`\url`/`\includegraphics` 를 절대 켜지
// 않는다고 명시하는데, 그 의도를 지키는 테스트가 없었다 — 뒤집혀도 유닛 10건·E2E 1건이
// 전부 그린이었다.
//
// ⚠️ 처음에는 `javascript:` URL 로 썼는데 **뮤테이션이 잡히지 않았다**: 2차 방어선인
// safeComponents 의 스킴 화이트리스트가 그 스킴을 어차피 <span> 으로 강등하므로 trust 를
// 켜든 끄든 <a> 가 없다 — 단언이 공허했다. 두 설정이 실제로 갈리는 입력(허용 스킴)으로 쓴다.
describe('KaTeX trust 옵션 (QA25)', () => {
  it('\\href 가 링크를 만들지 않는다 (허용 스킴이어도)', async () => {
    const container = await renderResolved('$$\\href{https://example.com}{클릭}$$');
    expect(container.querySelector('a')).toBeNull();
  });

  it('플러그인 옵션에 trust 가 꺼져 있다', () => {
    // DOM 단언만으로는 2차 방어선에 가려질 수 있으므로 설정 자체도 고정한다.
    const [, options] = MATH_REHYPE_PLUGINS[0] as unknown as [unknown, { trust?: unknown }];
    expect(options.trust).toBe(false);
  });
});
