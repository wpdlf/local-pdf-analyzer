/**
 * 수식 렌더링 플러그인 — 화면(markdown-renderer)과 PDF 내보내기(export-html)의 **단일 출처**.
 *
 * 두 경로가 각자 플러그인 배열을 들면 drift 가 난다(화면에는 수식이 나오는데 내보낸 PDF 에는
 * `\(E=mc^2\)` 가 찍히는 식). 실제로 이 저장소는 같은 이유로 REMARK_PLUGINS 를 두 번 선언해
 * 두고 있었으므로, math 는 처음부터 한 곳에 둔다.
 *
 * 두 호출자 모두 이미 지연 청크(React.lazy / 동적 import)라 katex 가 cold-start eager 번들에
 * 들어가지 않는다.
 */
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import type { Options } from 'react-markdown';

// PluggableList 의 출처는 `unified` 지만 그건 react-markdown 의 전이 의존이다. 직접 import 하면
// 선언하지 않은 패키지에 타입 의존이 생기므로, 실제 소비 지점의 타입을 그대로 끌어 쓴다.
type PluggableList = NonNullable<Options['remarkPlugins']>;

/**
 * `singleDollarTextMath: false` — 홑 `$` 를 수식 구분자에서 제외한다.
 * 켜면 "가격은 $100 에서 $200 로" 가 수식으로 둔갑한다. [[math-normalize]] 가 `\(…\)` 를
 * `$$…$$` 로 바꿔 주므로 인라인 수식은 이 설정과 무관하게 동작한다.
 */
const REMARK_MATH_OPTIONS = { singleDollarTextMath: false };

const KATEX_OPTIONS = {
  /**
   * MathML 단독 출력. Chromium 은 MathML Core 를 네이티브 지원하므로(Electron 43 = 훨씬 상위)
   * katex.css 와 woff2 폰트 20여 개(~350KB)를 번들할 필요가 없다. 그 자산들은 file:// origin
   * 에서 CSP `font-src` 를 새로 열어야 하는데, 수식이 가끔 나오는 요약 뷰어에 그만한 표면을
   * 추가할 이유가 없다. MathML 은 스크린리더가 구조를 그대로 읽는다는 a11y 이점도 있다.
   */
  output: 'mathml' as const,
  /**
   * 방어적 명시. **실측 확인(2026-08-14)**: rehype-katex 7 은 ParseError 를 자체적으로 잡아
   * `<span class="katex-error">` 로 렌더하므로 이 값을 true 로 뒤집어도 동작이 바뀌지 않는다
   * (뮤테이션 테스트에서 아무 테스트도 실패하지 않아 확인했다). 즉 "깨진 수식이 요약 전체를
   * 강등시키지 않는다" 는 성질의 실제 근거는 이 옵션이 아니라 rehype-katex 의 내부 처리다.
   * 그래도 상위 버전에서 그 처리가 바뀌면 katex 의 throw 가 MarkdownErrorBoundary 까지 올라가
   * **요약 전체가 plain text 로 강등**되므로, 의도를 못박아 둔다.
   */
  throwOnError: false,
  /** `\href`·`\url`·`\includegraphics` 차단. 본문이 LLM 출력이므로 절대 켜지 않는다. */
  trust: false,
  /** 콘솔 경고 억제 — LLM 이 낸 비표준 LaTeX 이 매 렌더 콘솔을 채우는 것을 막는다. */
  strict: 'ignore' as const,
  /** 매크로 확장·크기 상한 — LLM 출력이 `\def` 폭탄이나 거대 `\rule` 을 내는 경우의 바운드. */
  maxExpand: 100,
  maxSize: 50,
};

export const MATH_REMARK_PLUGINS: PluggableList = [[remarkMath, REMARK_MATH_OPTIONS]];
export const MATH_REHYPE_PLUGINS: PluggableList = [[rehypeKatex, KATEX_OPTIONS]];
