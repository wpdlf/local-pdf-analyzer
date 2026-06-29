// @vitest-environment happy-dom

// react-markdown lazy 경계 통합 검증 — 목 없이 실제 SafeMarkdown(React.lazy → markdown-renderer
// → react-markdown + remark-gfm + safeComponents)을 렌더해 ①동적 import/Suspense 해소
// ②마크다운 파싱 ③remark-gfm 적용 ④인용([p.N]) 변환이 한 경로에서 동작함을 확인한다.
// (QaChat/SummaryViewer 단위 테스트는 react-markdown 과 safe-markdown 을 목으로 가려 이
//  lazy 경로 자체를 건너뛰므로, 지연 로딩 전환의 회귀는 본 통합 테스트가 가드한다.)

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SafeMarkdown } from '../safe-markdown';

afterEach(() => cleanup());

describe('SafeMarkdown lazy 경계 (통합)', () => {
  it('동적 import 해소 후 마크다운을 실제 HTML 로 렌더한다 (Suspense fallback → strong)', async () => {
    render(<SafeMarkdown content={'**굵게** 일반텍스트'} />);
    // lazy 청크 로드 전엔 plain pre fallback, 로드 후 react-markdown 이 strong 으로 파싱.
    // 실제 React.lazy 동적 import + Suspense 해소 — fork-pool 경합에서 기본 1000ms 를 넘길 수 있어
    // 타임아웃을 넉넉히(test.yml 플레이크 방지). 단독 실행은 수십 ms 내 통과.
    const strong = await screen.findByText('굵게', {}, { timeout: 5000 });
    expect(strong.tagName).toBe('STRONG');
  });

  it('remark-gfm 플러그인이 함께 로드된다 (취소선 ~~ → del)', async () => {
    render(<SafeMarkdown content={'~~삭제~~'} />);
    const del = await screen.findByText('삭제', {}, { timeout: 5000 });
    expect(del.tagName).toBe('DEL'); // GFM strikethrough — remark-gfm 미로드 시 평문으로 남음
  });

  it('인용 토큰 [p.N] 을 safeComponents 경유 CitationButton 으로 변환한다', async () => {
    render(<SafeMarkdown content={'결론 [p.3] 참고'} />);
    // 문서 미오픈(pageCount 0)이라 비활성 인용으로 렌더되지만, 평문이 아니라 별도
    // 엘리먼트(span/button)라는 점이 renderWithCitations(safeComponents) 적용 증거.
    const cite = await screen.findByText('[p.3]', {}, { timeout: 5000 });
    expect(['SPAN', 'BUTTON']).toContain(cite.tagName);
  });
});
