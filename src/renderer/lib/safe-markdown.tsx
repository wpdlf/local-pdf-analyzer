import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** remark 플러그인 — 모듈 스코프 상수로 매 렌더 새 참조 생성 방지 */
export const REMARK_PLUGINS = [remarkGfm];

/**
 * Markdown 렌더링 시 XSS 방지용 컴포넌트 오버라이드.
 * - <a>: https:// 와 # 앵커만 허용, 나머지는 <span>으로 대체
 * - <img>: 외부 이미지 로드 차단 (트래킹 픽셀/데이터 유출 방지)
 */
export const safeComponents: Components = {
  // props spread 제거: remark 플러그인 경유 위험 속성(dangerouslySetInnerHTML 등) 전파 방지
  a: ({ href, children }) => {
    const isSafe = href && (href.startsWith('https://') || href.startsWith('#'));
    return isSafe
      ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span>{children}</span>;
  },
  img: ({ alt }) => {
    return <span>{alt || '[이미지]'}</span>;
  },
};
