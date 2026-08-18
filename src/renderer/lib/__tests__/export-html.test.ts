// summaryToHtml — 요약 마크다운 → 인쇄용 정적 HTML 변환 + 새니타이즈 가드.
// renderToStaticMarkup 은 DOM 불필요(node 환경 OK). safe-markdown 의 a/img 가드 재사용 검증.

import { describe, it, expect } from 'vitest';
import { summaryToHtml } from '../export-html';

describe('summaryToHtml — 인쇄용 HTML 변환', () => {
  it('완전 HTML 문서 골격 + CSP + 인쇄 CSS + 마크다운 렌더', () => {
    const html = summaryToHtml('# 제목\n\n본문 **굵게** 내용.', 'lecture');
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<title>lecture</title>');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('@page');
    expect(html).toContain('<h1>제목</h1>');
    expect(html).toContain('<strong>굵게</strong>');
  });

  // QA14(C-LOW): lang 하드코딩('ko') → 요약 언어 반영. 2글자 코드만 허용(속성 주입 안전), 그 외 'ko'.
  it('lang 인자를 html lang 속성에 반영 — en / 미지정(ko) / 부정입력(ko)', () => {
    expect(summaryToHtml('x', 't', 'en')).toContain('<html lang="en">');
    expect(summaryToHtml('x', 't')).toContain('<html lang="ko">');
    expect(summaryToHtml('x', 't', 'auto')).toContain('<html lang="ko">');       // 2글자 아님 → ko
    expect(summaryToHtml('x', 't', '"><script>')).toContain('<html lang="ko">'); // 주입 시도 차단
  });

  it('인용 [p.N] 은 plain text 로 보존(인터랙티브 버튼 미사용)', () => {
    const html = summaryToHtml('근거 문장입니다 [p.3].', 'x');
    expect(html).toContain('[p.3]');
    expect(html).not.toContain('<button');
  });

  it('raw HTML/script 는 렌더되지 않음 (rehype-raw 미사용)', () => {
    const html = summaryToHtml('정상 <script>alert(1)</script> 텍스트', 'x');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('위험 스킴 링크 차단(span), https 링크 유지', () => {
    const html = summaryToHtml('[클릭](javascript:alert(1)) 와 [안전](https://ollama.com)', 'x');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('href="https://ollama.com"');
  });

  it('외부 이미지는 alt 텍스트로만 렌더(트래킹/유출 차단)', () => {
    const html = summaryToHtml('![대체텍스트](https://evil.example/track.png)', 'x');
    expect(html).not.toContain('track.png');
    expect(html).toContain('대체텍스트');
  });

  it('title 은 HTML 이스케이프', () => {
    const html = summaryToHtml('본문', '<b>&"x"');
    expect(html).toContain('<title>&lt;b&gt;&amp;&quot;x&quot;</title>');
  });

  // 수식: 화면(markdown-renderer)과 내보내기(export-html)가 각자 플러그인 배열을 들면
  // "화면엔 수식이 나오는데 내보낸 PDF 엔 \(E=mc^2\) 가 찍히는" drift 가 난다.
  // math-plugins 를 단일 출처로 쓰는 배선이 이 경로에도 실제로 적용됐는지 본다.
  describe('수식', () => {
    it('`\\(…\\)` 가 MathML 로 렌더된다', () => {
      const html = summaryToHtml('수식 \\(E=mc^2\\) 확인[p.8].', 'x');
      expect(html).toContain('<math');
      expect(html).toContain('</math>');
      expect(html).not.toContain('\\(E=mc^2\\)'); // 리터럴이 남지 않는다
      expect(html).toContain('[p.8]');            // 인용은 plain text 로 보존
    });

    it('홑 `$` 통화 표기는 수식이 되지 않는다', () => {
      const html = summaryToHtml('가격은 $100 에서 $200 로 올랐다', 'x');
      expect(html).not.toContain('<math');
      expect(html).toContain('$100');
    });

    it('외부 리소스를 참조하지 않는다 — 인쇄 CSP(default-src none) 하에서 렌더 가능', () => {
      // MathML 단독 출력을 택한 이유. katex.css/woff2 를 쓰면 이 CSP 로는 로드되지 않는다.
      const html = summaryToHtml('\\[\\int_0^1 x\\,dx\\]', 'x');
      expect(html).toContain('<math');
      expect(html).not.toMatch(/<link[^>]+stylesheet/i);
      expect(html).not.toContain('katex.min.css');
    });
  });
});

// QA25(A-MED): 인쇄 CSS 의 수식 폭 완화 규칙 드리프트 가드.
//
// 넓은 display 수식은 인쇄에서 **잘린다** — 화면은 상위 컨테이너가 가로 스크롤을 주지만
// 인쇄에는 스크롤이 없고 printToPDF 는 세로로만 페이지를 나눈다. MathML 은 자동 줄바꿈을
// 하지 않으므로 본문 폭을 넘는 부분은 그대로 사라진다(실측: 오른쪽 477px 유실).
// Electron 실측으로 완화 효과를 확인했다 — 항목 14개 수식이 794px 를 요구해 잘리던 것이
// 규칙 적용 후 674px 에 들어간다(잘림 시작점 14 → 16). 이 규칙이 사라지면 조용히 되돌아간다.
describe('인쇄 CSS — 수식 폭 (QA25)', () => {
  const html = summaryToHtml('$$x$$', '제목', 'ko');

  it('display 수식에 축소·여백확보 규칙이 있다', () => {
    expect(html).toContain('math[display="block"]');
    expect(html).toMatch(/math\[display="block"\][^}]*font-size:\s*0\.85em/);
    expect(html).toMatch(/math\[display="block"\][^}]*margin-left:\s*-8mm/);
  });

  it('수식이 본문 폭을 넘지 않도록 max-width 가 걸려 있다', () => {
    expect(html).toMatch(/(^|\s)math\s*\{[^}]*max-width:\s*100%/);
  });

  // 외부 리소스 미참조는 이 파일 위쪽의 기존 테스트가 이미 가드한다 — 여기서 중복 단언하지
  // 않는다(MathML 의 xmlns 네임스페이스 URI 는 가져오는 리소스가 아니므로 URL 패턴 단언은
  // 오히려 오탐이다).
});
