import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeComponents } from './safe-markdown';

// react-markdown + remark-gfm 를 담는 지연 청크 타깃.
//
// 이 모듈은 safe-markdown 의 `SafeMarkdown` 이 `React.lazy(() => import('./markdown-renderer'))`
// 로만 끌어온다 — 정적 import 가 어디에도 없으므로 react-markdown(≈50KB gzip)·remark-gfm 이
// cold-start eager 번들에서 빠지고, 요약/Q&A 첫 렌더 직전에 비동기 로드된다.
// (export-html 은 이미 별도 lazy 청크라 자체적으로 react-markdown 을 정적 import 한다.)

/** remark 플러그인 — 모듈 스코프 상수로 매 렌더 새 참조 생성 방지 */
const REMARK_PLUGINS = [remarkGfm];

export default function MarkdownRenderer({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={safeComponents}>{children}</ReactMarkdown>
  );
}
