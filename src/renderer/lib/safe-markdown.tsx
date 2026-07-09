import { Component, Fragment, Suspense, lazy, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import { t } from './i18n';
import { parseCitations } from './citation';
import { CitationButton } from '../components/CitationButton';

/** ReactMarkdown 파싱 실패 시 원본 텍스트를 fallback으로 표시하는 Error Boundary */
export class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallbackText?: string },
  { hasError: boolean }
> {
  override state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  // v0.18.19 patch R34 P1 (R33 회귀 fix): 비교 대상을 `children` 에서 `fallbackText` 로 교체.
  //
  // R32 P2 가 추가한 본 hook 은 "스트리밍 도중 한번 latch 된 hasError 가 콘텐츠 완성 후에도
  // 풀리지 않던 결함" 을 해결하려 했으나, 부모(SummaryViewer / QaChat) 가 매 렌더마다 JSX 로
  // `<ReactMarkdown>` 을 새로 생성하기 때문에 `prevProps.children !== this.props.children` 은
  // 매 렌더 true. 결과적으로 hasError 가 latch 되더라도 다음 렌더에서 즉시 reset → 같은
  // throw 발생 → 다시 latch 의 thrash 루프 가능 (R33 Surface 3 P2).
  //
  // 올바른 신호는 "콘텐츠 문자열이 바뀌었는가" — 양쪽 호출자가 `fallbackText` 에 본 콘텐츠
  // (`debouncedContent` 또는 메시지 본문) 를 전달하므로 이 prop 의 변화만이 "새 시도 가치가
  // 있다" 는 표시. 일시적 mid-stream 오류가 다음 debounced content 로 자연 회복되는 의도된
  // 동작은 그대로 유지하면서, 영구 오류 컨텐츠에서의 thrash 만 차단.
  override componentDidUpdate(prevProps: { children: ReactNode; fallbackText?: string }) {
    if (this.state.hasError && prevProps.fallbackText !== this.props.fallbackText) {
      this.setState({ hasError: false });
    }
  }
  override render() {
    if (this.state.hasError) {
      // t()는 store에서 현재 uiLanguage를 읽음 — 렌더 시점 언어로 표시됨.
      // QA: Suspense fallback 과 동일하게 <div> 사용 — 상위 prose 타이포그래피가 <pre> 를 다크
      // 코드블록으로 스타일링하는 것을 피해, 파싱 실패 시에도 원본을 plain text 로 표시(일관).
      return <div className="whitespace-pre-wrap text-sm">{this.props.fallbackText ?? t('common.renderError')}</div>;
    }
    return this.props.children;
  }
}

// R28 P2 (v0.18.12) / R29 (v0.18.13): href 에 포함된 위험 제어/방향 문자 검출.
// - 제어문자 (U+0000~U+001F, U+007F): null-byte injection / 헤더 split 류 방지
// - bidi override (U+202A~U+202E, U+2066~U+2069): visual spoofing 방지
//   (LLM 응답이 [github.com](https://attacker.com<U+202E>/...) 형태로
//    툴팁 / 표시 텍스트와 실제 destination 을 어긋나게 위장하는 경로를 사전 차단)
//
// R29: 정규식 리터럴에 직접 박혀 있던 raw 제어 바이트를 명시적 `\uXXXX` escape 로
// 교체. 이전엔 grep 이 binary 파일로 분류하고 에디터/linter 의 normalization 으로
// silently 보호가 사라질 위험이 있었음.
// eslint-disable-next-line no-control-regex -- 제어문자 차단이 본 정규식의 목적
const DANGEROUS_URL_CHAR = new RegExp(
  '[' +
  '\\u0000-\\u001F' +  // C0 control chars (null byte / 헤더 split 방지)
  '\\u007F' +          // DEL
  '\\u202A-\\u202E' +  // bidi formatting (LRE/RLE/PDF/LRO/RLO)
  '\\u2066-\\u2069' +  // bidi isolates (LRI/RLI/FSI/PDI)
  ']',
);

/**
 * URL scheme 이 안전한지 검사.
 * - 허용: https://, http://, mailto:, #anchor
 * - 차단(명시): javascript:, data:, vbscript:, file:
 * - 그 외: scheme 자체가 없는 상대경로는 차단 (Electron file:// origin 에서 로컬 네비게이션 방지)
 */
function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  // R28 P2 (v0.18.12): bidi/제어문자 포함 URL 은 무조건 거부.
  if (DANGEROUS_URL_CHAR.test(trimmed)) return false;
  if (trimmed.startsWith('#')) return true;
  const lower = trimmed.toLowerCase();
  // 명시적 차단 scheme — 알려진 XSS vector
  if (
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('file:')
  ) {
    return false;
  }
  if (lower.startsWith('https://') || lower.startsWith('http://') || lower.startsWith('mailto:')) {
    return true;
  }
  return false;
}

/**
 * text-containing 컴포넌트의 children 배열을 순회하며 문자열을 parseCitations 로 분해.
 * - 문자열 → text/citation 세그먼트 → 텍스트는 원본, citation 은 <CitationButton>
 * - ReactNode 요소(예: <strong>, <em>) → 그대로 유지 (재귀는 React 가 알아서 처리)
 * - 인용이 없는 일반 텍스트는 원본 문자열 그대로 반환 (불필요한 Fragment 생성 회피)
 *
 * Design Ref: §3.3.2 parseCitations 통합, §5.4 PageUIChecklist (Q&A 인용 전역)
 */
function renderWithCitations(children: ReactNode): ReactNode {
  // React.Children.map 은 key 를 자동 주입 — 배열 children 에서 안전
  const toArray = Array.isArray(children) ? children : [children];
  const out: ReactNode[] = [];
  toArray.forEach((child, idx) => {
    if (typeof child !== 'string') {
      out.push(child);
      return;
    }
    const segments = parseCitations(child);
    if (segments.length <= 1 && segments[0]?.type === 'text') {
      // 인용 없음 — 원본 문자열 그대로
      out.push(child);
      return;
    }
    segments.forEach((seg, segIdx) => {
      if (seg.type === 'citation' && seg.page !== undefined) {
        out.push(<CitationButton key={`${idx}-${segIdx}`} page={seg.page} docName={seg.docName} />);
      } else if (seg.type === 'text' && seg.content) {
        out.push(<Fragment key={`${idx}-${segIdx}`}>{seg.content}</Fragment>);
      }
    });
  });
  return out;
}

/**
 * Markdown 렌더링 시 XSS 방지용 컴포넌트 오버라이드.
 * - <a>: https/http/mailto/#anchor 허용, javascript/data/vbscript/file 명시 차단
 * - <img>: 외부 이미지 로드 차단 (트래킹 픽셀/데이터 유출 방지)
 * - <p>, <li>, <td>, <th>, <em>, <strong>: parseCitations 적용하여 [p.N] 을 CitationButton 으로 변환
 * - <code>: 인용 변환 적용 안 함 (코드 블록 내부 [p.N] 은 원본 유지)
 */
export const safeComponents: Components = {
  // props spread 제거: remark 플러그인 경유 위험 속성(dangerouslySetInnerHTML 등) 전파 방지
  a: ({ href, children }) => {
    if (href && isSafeHref(href)) {
      return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    }
    // 차단된 URL 은 툴팁으로 사용자에게 명시 (정상 링크가 침묵 차단되는 문제 가시화)
    return <span title={t('common.blockedLink')}>{children}</span>;
  },
  img: ({ alt }) => {
    return <span>{alt || t('common.imagePlaceholder')}</span>;
  },
  // page-citation-viewer: 인용 렌더링 주입.
  // v0.18.19 patch R32 P3: heading / blockquote 도 커버. LLM 이 종종 "## 결론 [p.12]" 같이
  // 헤딩에 인용을 다는데 이전엔 literal text 로 렌더되어 클릭 불가였다 (Surface 3 P5).
  p: ({ children }) => <p>{renderWithCitations(children)}</p>,
  li: ({ children }) => <li>{renderWithCitations(children)}</li>,
  td: ({ children }) => <td>{renderWithCitations(children)}</td>,
  th: ({ children }) => <th>{renderWithCitations(children)}</th>,
  em: ({ children }) => <em>{renderWithCitations(children)}</em>,
  strong: ({ children }) => <strong>{renderWithCitations(children)}</strong>,
  h1: ({ children }) => <h1>{renderWithCitations(children)}</h1>,
  h2: ({ children }) => <h2>{renderWithCitations(children)}</h2>,
  h3: ({ children }) => <h3>{renderWithCitations(children)}</h3>,
  h4: ({ children }) => <h4>{renderWithCitations(children)}</h4>,
  h5: ({ children }) => <h5>{renderWithCitations(children)}</h5>,
  h6: ({ children }) => <h6>{renderWithCitations(children)}</h6>,
  blockquote: ({ children }) => <blockquote>{renderWithCitations(children)}</blockquote>,
};

// react-markdown(≈50KB gzip)·remark-gfm 은 cold-start 부담을 줄이기 위해 지연 청크로 분리한다.
// `markdown-renderer` 만이 이들을 정적 import 하고, 본 컴포넌트가 React.lazy 로 그 모듈을 끌어온다.
const importMarkdownRenderer = () => import('./markdown-renderer');
const MarkdownRenderer = lazy(importMarkdownRenderer);

/**
 * 지연 청크(react-markdown/remark-gfm)를 유휴 시점에 미리 로드(warm)한다.
 * 신규 앱 기동 후 세션 복원·최초 요약 렌더 시, 청크가 아직 없으면 Suspense fallback(원본 텍스트)이
 * 한 프레임 노출됐다(재오픈 첫 화면이 잠깐 코드블록처럼 보이던 현상). import() 는 모듈 단위로 캐시되므로
 * 초기 페인트 이후 유휴에 한 번 호출해 두면 이후 SafeMarkdown 이 즉시 렌더돼 깜빡임이 사라진다.
 * cold-start 부담은 없다 — 호출 시점을 초기 렌더 이후로 미루기 때문(App 마운트 시 requestIdleCallback).
 */
export function prefetchMarkdownRenderer(): void {
  void importMarkdownRenderer();
}

/**
 * 안전 마크다운 렌더러 — 지연 로딩(Suspense) + 파싱 실패 fallback(ErrorBoundary)을 한데 묶은 진입점.
 * - 청크 로드 전 짧은 순간 및 파싱 실패 시 모두 `content` 원본을 plain text 로 표시(레이아웃 유지).
 * - `content` 가 ErrorBoundary 의 reset 신호도 겸함([[MarkdownErrorBoundary]] R34 P1 참조).
 */
export function SafeMarkdown({ content }: { content: string }) {
  return (
    <MarkdownErrorBoundary fallbackText={content}>
      {/* 청크 로드 전 짧은 순간의 fallback — 상위 prose 타이포그래피가 <pre> 를 코드블록(다크·모노스페이스)
          으로 스타일링하므로, 원본을 plain text 로 보여주려는 의도대로 <div> 로 렌더한다(레이아웃 유지). */}
      <Suspense fallback={<div className="whitespace-pre-wrap text-sm">{content}</div>}>
        <MarkdownRenderer>{content}</MarkdownRenderer>
      </Suspense>
    </MarkdownErrorBoundary>
  );
}
