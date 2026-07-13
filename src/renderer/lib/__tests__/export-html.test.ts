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
});
