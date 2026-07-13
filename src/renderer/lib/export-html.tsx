import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeComponents } from './safe-markdown';

// export-html 은 PDF 내보내기 시점에만 동적 import 되는 별도 lazy 청크라, react-markdown·
// remark-gfm 을 직접 정적 import 해도 cold-start eager 번들에 들어가지 않는다.
// (요약/Q&A 화면 렌더는 safe-markdown 의 SafeMarkdown → markdown-renderer 경로를 쓴다.)
const REMARK_PLUGINS = [remarkGfm];

// PDF 내보내기용 마크다운 → 정적 HTML 변환.
//
// 보안: 본문은 LLM 출력이지만 react-markdown(9, rehype-raw 미사용)이 raw HTML 을 렌더하지 않고,
// 아래 컴포넌트가 a(스킴 화이트리스트)/img(외부 로드 차단, alt 만)를 safe-markdown 과 동일하게
// 처리한다. 인쇄 창은 추가로 JS 비활성 + sandbox 잠금(main 의 file:export-pdf 핸들러).
//
// 인용([p.N])은 인터랙티브 CitationButton(store 의존·클릭 점프) 대신 소스의 plain text 그대로
// 둔다 — 정적 PDF 에선 클릭이 무의미하고 텍스트로 충분히 읽힌다.
const exportComponents: Components = {
  a: safeComponents.a,
  img: safeComponents.img,
};

/** title 속성/타이틀 텍스트용 최소 HTML 이스케이프 (본문은 react-markdown 이 안전 렌더). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}

// 인쇄 친화 CSS — 시스템 한글 폰트 우선, @page 여백, 코드/표/인용 가독 스타일,
// 헤딩 page-break 회피. 외부 리소스(웹폰트 등) 미참조 — 오프라인/오프스크린 렌더 안정성.
const PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: #1a1a1a; line-height: 1.65; font-size: 11.5pt; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .doc { max-width: 100%; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.2em 0 0.5em; break-after: avoid; font-weight: 700; }
  h1 { font-size: 1.7em; border-bottom: 2px solid #e5e7eb; padding-bottom: 0.2em; }
  h2 { font-size: 1.35em; border-bottom: 1px solid #eee; padding-bottom: 0.15em; }
  h3 { font-size: 1.15em; }
  p, ul, ol, blockquote, table, pre { margin: 0.6em 0; }
  ul, ol { padding-left: 1.4em; }
  li { margin: 0.2em 0; }
  a { color: #2563eb; text-decoration: underline; word-break: break-all; }
  code { background: #f3f4f6; padding: 0.1em 0.35em; border-radius: 3px; font-family: "Consolas", "Courier New", monospace; font-size: 0.92em; }
  pre { background: #f6f8fa; padding: 0.9em 1em; border-radius: 6px; overflow-x: auto; break-inside: avoid; }
  pre code { background: none; padding: 0; }
  blockquote { border-left: 4px solid #d1d5db; padding-left: 1em; margin-left: 0; color: #4b5563; }
  table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
  th, td { border: 1px solid #d1d5db; padding: 0.4em 0.6em; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 700; }
  img { max-width: 100%; }
  hr { border: none; border-top: 1px solid #e5e7eb; margin: 1.2em 0; }
`;

/**
 * 요약 마크다운을 인쇄용 완전 HTML 문서로 변환한다. main 의 file:export-pdf 가 이 HTML 을
 * 잠금 오프스크린 창에 로드 후 printToPDF 한다.
 */
export function summaryToHtml(markdown: string, title: string, lang?: string): string {
  const body = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={exportComponents}>{markdown}</ReactMarkdown>,
  );
  // QA14(C-LOW): 이전엔 lang="ko" 하드코딩이라 영어 요약 PDF 도 SR 이 한국어 음가로 읽고 메타데이터가
  // 틀렸다. 요약 언어(summaryLanguage)를 반영하되, 속성 주입 안전을 위해 2글자 코드만 허용(그 외 'ko').
  const safeLang = lang && /^[a-z]{2}$/.test(lang) ? lang : 'ko';
  return `<!DOCTYPE html><html lang="${safeLang}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src 'self';">`
    + `<title>${escapeHtml(title)}</title><style>${PRINT_CSS}</style></head>`
    + `<body><main class="doc">${body}</main></body></html>`;
}
