import { Component, Fragment, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from './i18n';
import { parseCitations } from './citation';
import { CitationButton } from '../components/CitationButton';

/** ReactMarkdown 파싱 실패 시 원본 텍스트를 fallback으로 표시하는 Error Boundary */
export class MarkdownErrorBoundary extends Component<
  { children: ReactNode; fallbackText?: string },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() { return { hasError: true }; }
  render() {
    if (this.state.hasError) {
      // t()는 store에서 현재 uiLanguage를 읽음 — 렌더 시점 언어로 표시됨
      return <pre className="whitespace-pre-wrap text-sm">{this.props.fallbackText ?? t('common.renderError')}</pre>;
    }
    return this.props.children;
  }
}

/** remark 플러그인 — 모듈 스코프 상수로 매 렌더 새 참조 생성 방지 */
export const REMARK_PLUGINS = [remarkGfm];

/**
 * URL scheme 이 안전한지 검사.
 * - 허용: https://, http://, mailto:, #anchor
 * - 차단(명시): javascript:, data:, vbscript:, file:
 * - 그 외: scheme 자체가 없는 상대경로는 차단 (Electron file:// origin 에서 로컬 네비게이션 방지)
 */
function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
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
        out.push(<CitationButton key={`${idx}-${segIdx}`} page={seg.page} />);
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
  // page-citation-viewer: 인용 렌더링 주입
  p: ({ children }) => <p>{renderWithCitations(children)}</p>,
  li: ({ children }) => <li>{renderWithCitations(children)}</li>,
  td: ({ children }) => <td>{renderWithCitations(children)}</td>,
  th: ({ children }) => <th>{renderWithCitations(children)}</th>,
  em: ({ children }) => <em>{renderWithCitations(children)}</em>,
  strong: ({ children }) => <strong>{renderWithCitations(children)}</strong>,
};
