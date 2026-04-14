import { Component, type ReactNode } from 'react';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { t } from './i18n';

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
 * Markdown 렌더링 시 XSS 방지용 컴포넌트 오버라이드.
 * - <a>: https/http/mailto/#anchor 허용, javascript/data/vbscript/file 명시 차단
 * - <img>: 외부 이미지 로드 차단 (트래킹 픽셀/데이터 유출 방지)
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
};
