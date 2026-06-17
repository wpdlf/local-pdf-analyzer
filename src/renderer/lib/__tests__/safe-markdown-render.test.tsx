// @vitest-environment happy-dom

// safe-markdown 렌더 경로 보강 — 기존 safe-markdown.test 가 a/img/경계 라이프사이클을 팩토리
// 호출로 커버하는 반면, 본 파일은 renderWithCitations(p/li/em/strong/h*/blockquote 오버라이드)와
// MarkdownErrorBoundary.render() 폴백을 실제 렌더로 가드한다(41% → 상향의 핵심 미커버 영역).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComponentType, ReactNode } from 'react';
import { render, screen, cleanup } from '@testing-library/react';

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
}));

import { MarkdownErrorBoundary, safeComponents } from '../safe-markdown';
import { useAppStore } from '../store';

let consoleSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // error boundary throw + 일부 override 의 DOM 중첩 경고 노이즈 억제
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  // CitationButton 은 page 가 문서 pageCount 범위 안일 때만 활성 버튼으로 렌더(아니면 비활성 span).
  // 인용 변환 경로를 검증하려면 충분한 pageCount 를 가진 문서가 필요.
  useAppStore.setState({ citationTarget: null, document: { pageCount: 20 } as never });
});
afterEach(() => {
  consoleSpy.mockRestore();
  cleanup();
});

describe('MarkdownErrorBoundary.render()', () => {
  function Boom(): never { throw new Error('parse fail'); }

  it('정상 children 통과', () => {
    render(<MarkdownErrorBoundary fallbackText="원본">정상 렌더</MarkdownErrorBoundary>);
    expect(screen.getByText('정상 렌더')).toBeTruthy();
  });

  it('children throw → fallbackText pre 로 폴백', () => {
    render(<MarkdownErrorBoundary fallbackText="원본 텍스트"><Boom /></MarkdownErrorBoundary>);
    expect(screen.getByText('원본 텍스트')).toBeTruthy();
  });

  it('fallbackText 없으면 renderError 안내', () => {
    render(<MarkdownErrorBoundary><Boom /></MarkdownErrorBoundary>);
    expect(screen.getByText(/렌더링 오류/)).toBeTruthy();
  });

  it('fallbackText 변경 시 reset → 새 폴백 표시', () => {
    const { rerender } = render(<MarkdownErrorBoundary fallbackText="A"><Boom /></MarkdownErrorBoundary>);
    expect(screen.getByText('A')).toBeTruthy();
    rerender(<MarkdownErrorBoundary fallbackText="B"><Boom /></MarkdownErrorBoundary>);
    expect(screen.getByText('B')).toBeTruthy();
  });
});

const P = safeComponents.p as unknown as ComponentType<{ children?: ReactNode }>;

describe('renderWithCitations — 인용 변환', () => {
  it('[p.N] 포함 텍스트 → CitationButton(버튼) + 주변 텍스트', () => {
    render(<P>{'앞 문장 [p.3] 뒤 문장'}</P>);
    expect(screen.getByRole('button')).toBeTruthy();
    expect(screen.getByText(/앞 문장/)).toBeTruthy();
    expect(screen.getByText(/뒤 문장/)).toBeTruthy();
  });

  it('인용 없는 일반 텍스트는 그대로(버튼 없음)', () => {
    render(<P>{'인용 없는 본문'}</P>);
    expect(screen.getByText('인용 없는 본문')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('문자열이 아닌 child(요소)는 그대로 유지', () => {
    render(<P><strong>굵게</strong></P>);
    expect(screen.getByText('굵게')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('여러 인용 → 버튼 여러 개', () => {
    render(<P>{'문장 [p.1] 그리고 [p.5] 끝'}</P>);
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});

// 모든 텍스트 컨테이너 오버라이드가 renderWithCitations 를 경유하는지(각 화살표 라인 커버)
describe('safeComponents 텍스트 오버라이드 — 인용 주입 경유', () => {
  const inlineKeys = ['em', 'strong', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'li', 'p'] as const;

  it.each(inlineKeys)('%s 오버라이드: [p.2] 포함 시 CitationButton 생성', (key) => {
    const C = safeComponents[key] as unknown as ComponentType<{ children?: ReactNode }>;
    render(<C>{'헤더 [p.2]'}</C>);
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('td/th 오버라이드(table 컨텍스트)도 인용 주입', () => {
    const Td = safeComponents.td as unknown as ComponentType<{ children?: ReactNode }>;
    const Th = safeComponents.th as unknown as ComponentType<{ children?: ReactNode }>;
    render(
      <table><tbody>
        <tr><Th>{'헤더 [p.7]'}</Th></tr>
        <tr><Td>{'셀 [p.8]'}</Td></tr>
      </tbody></table>,
    );
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});

describe('renderWithCitations — 클릭 시 citationTarget 설정', () => {
  it('CitationButton 클릭 → store.citationTarget 갱신', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<P>{'근거 [p.4] 참조'}</P>);
    await user.click(screen.getByRole('button'));
    expect(useAppStore.getState().citationTarget?.page).toBe(4);
  });
});
