// @vitest-environment happy-dom

// v0.18.22 Top5 #4 (test coverage): 컴포넌트 0% 커버리지 탈출 시발점.
// CitationButton 은 인용 클릭 → store.citationTarget 설정의 핵심 경로지만 컴포넌트 단위 테스트
// 0건이었다 (R31~R35 citation 회귀가 컴포넌트 레벨 가드 부재로 잡히지 않았던 원인).
//
// 환경 격리: 본 파일만 `happy-dom` 으로 실행 (file pragma). vitest.config 의 기본 환경을 바꾸지
// 않아 기존 379 tests 의 `vi.stubGlobal('window', ...)` 패턴이 영향받지 않는다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// store.ts 는 module init 시 localStorage / window.electronAPI 를 참조한다.
// happy-dom 은 localStorage 를 제공하지만 electronAPI 는 직접 stub 필요 (다른 테스트 파일 패턴 답습).
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
}));

// 교차 문서 인용 클릭 시 탭 전환 — lib/tabs.switchToTab 호출만 검증(부수효과는 tabs 테스트 담당)
const mockSwitchToTab = vi.hoisted(() => vi.fn((_filePath: string) => Promise.resolve()));
vi.mock('../../lib/tabs', () => ({ switchToTab: mockSwitchToTab }));

import { CitationButton } from '../CitationButton';
import { useAppStore } from '../../lib/store';

function setDocument(pageCount: number): void {
  useAppStore.setState({
    document: {
      id: 'test-doc',
      fileName: 'test.pdf',
      filePath: '/tmp/test.pdf',
      pageCount,
      extractedText: '',
      pageTexts: Array.from({ length: pageCount }, (_, i) => `page ${i + 1} content`),
      chapters: [],
      images: [],
      createdAt: new Date(),
    },
    citationTarget: null,
  });
}

beforeEach(() => {
  setDocument(5);
});

afterEach(() => {
  cleanup();
  useAppStore.setState({ document: null, citationTarget: null });
});

describe('CitationButton (Top5 #4) — 유효 범위 페이지', () => {
  it('document.pageCount 범위 내 페이지는 클릭 가능한 버튼으로 렌더', () => {
    render(<CitationButton page={3} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('[p.3]');
    expect(btn.getAttribute('aria-disabled')).toBeNull();
  });

  it('첫 페이지 (page=1) 와 마지막 페이지 (page=pageCount) 양극단도 유효', () => {
    render(<CitationButton page={1} />);
    expect(screen.getByRole('button').textContent).toBe('[p.1]');
    cleanup();

    render(<CitationButton page={5} />);
    expect(screen.getByRole('button').textContent).toBe('[p.5]');
  });

  it('aria-label / title 이 t() 키 기반으로 page 변수 보간', () => {
    render(<CitationButton page={2} />);
    const btn = screen.getByRole('button');
    // i18n 의 실제 번역은 store.uiLanguage 기본값 ('ko') 에 따라 결정 — 어떤 언어든
    // page 숫자 자체는 보간되어야 한다.
    expect(btn.getAttribute('title')).toMatch(/2/);
    expect(btn.getAttribute('aria-label')).toMatch(/2/);
  });
});

describe('CitationButton (Top5 #4) — 범위 초과 페이지', () => {
  it('page > pageCount 는 disabled <span> 으로 렌더 + aria-disabled=true', () => {
    render(<CitationButton page={10} />);
    // button role 이 아니라 span — disabled 마커
    expect(screen.queryByRole('button')).toBeNull();
    const span = screen.getByText('[p.10]');
    expect(span.tagName).toBe('SPAN');
    expect(span.getAttribute('aria-disabled')).toBe('true');
    // visual cue: cursor-not-allowed + dashed border
    expect(span.className).toMatch(/cursor-not-allowed/);
  });

  it('page = 0 / 음수 / NaN / Infinity — 모두 disabled fallback', () => {
    const cases = [0, -1, NaN, Infinity];
    for (const p of cases) {
      cleanup();
      render(<CitationButton page={p} />);
      expect(screen.queryByRole('button'), `page=${p} 은 disabled 여야 함`).toBeNull();
    }
  });

  it('document=null (문서 없음) 일 때도 안전 disabled', () => {
    useAppStore.setState({ document: null });
    render(<CitationButton page={3} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('CitationButton (Top5 #4) — 클릭 동작', () => {
  it('유효 페이지 클릭 시 setCitationTarget({ page }) 호출', async () => {
    const user = userEvent.setup();
    render(<CitationButton page={3} />);
    await user.click(screen.getByRole('button'));
    expect(useAppStore.getState().citationTarget).toEqual({ page: 3 });
  });

  it('disabled span 은 클릭해도 store 가 변하지 않는다', async () => {
    const user = userEvent.setup();
    render(<CitationButton page={99} />);
    await user.click(screen.getByText('[p.99]'));
    expect(useAppStore.getState().citationTarget).toBeNull();
  });

  it('클릭 이벤트는 preventDefault + stopPropagation — 부모 마크다운 링크 등으로 bubble 차단', async () => {
    const parentClick = vi.fn();
    const user = userEvent.setup();
    render(
      <div onClick={parentClick}>
        <CitationButton page={2} />
      </div>,
    );
    await user.click(screen.getByRole('button'));
    // stopPropagation 으로 부모는 onClick 을 받지 않는다
    expect(parentClick).not.toHaveBeenCalled();
    // 그러나 store 는 갱신
    expect(useAppStore.getState().citationTarget).toEqual({ page: 2 });
  });
});

describe('CitationButton (Top5 #4) — active 상태', () => {
  it('citationTarget.page === validPage 일 때 active 시각 스타일', () => {
    useAppStore.setState({ citationTarget: { page: 2 } });
    render(<CitationButton page={2} />);
    const btn = screen.getByRole('button');
    // active class: bg-blue-200 ... (light) 또는 dark variant
    expect(btn.className).toMatch(/bg-blue-200/);
  });

  it('다른 페이지가 active 인 경우 본 버튼은 inactive 스타일', () => {
    useAppStore.setState({ citationTarget: { page: 5 } });
    render(<CitationButton page={2} />);
    const btn = screen.getByRole('button');
    expect(btn.className).not.toMatch(/bg-blue-200/);
    expect(btn.className).toMatch(/bg-transparent/);
  });

  it('citationTarget=null 일 때 모든 버튼 inactive', () => {
    useAppStore.setState({ citationTarget: null });
    render(<CitationButton page={3} />);
    expect(screen.getByRole('button').className).toMatch(/bg-transparent/);
  });
});

describe('CitationButton — 교차 문서 인용 (multi-doc Phase 2)', () => {
  function setActiveAndTabs(): void {
    useAppStore.setState({
      document: {
        id: 'active', fileName: 'Alpha.pdf', filePath: '/d/Alpha.pdf', pageCount: 5,
        extractedText: '', pageTexts: [], chapters: [], images: [], createdAt: new Date(),
      },
      citationTarget: null,
      openTabs: [
        { filePath: '/d/Alpha.pdf', fileName: 'Alpha.pdf', pageCount: 5, docHash: 'a'.repeat(64) },
        { filePath: '/d/Beta.pdf', fileName: 'Beta.pdf', pageCount: 9, docHash: 'b'.repeat(64) },
      ],
    });
  }

  beforeEach(() => {
    mockSwitchToTab.mockReset();
    mockSwitchToTab.mockResolvedValue(undefined); // 기본: 전환 부수효과 없음(개별 테스트가 재정의)
    setActiveAndTabs();
  });

  it('docName=현재 문서면 단일 문서 인용처럼 [p.N] 렌더 + 전환 없음', async () => {
    const user = userEvent.setup();
    render(<CitationButton page={3} docName="Alpha.pdf" />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('[p.3]');
    await user.click(btn);
    expect(mockSwitchToTab).not.toHaveBeenCalled();
    expect(useAppStore.getState().citationTarget).toEqual({ page: 3 });
  });

  it('교차 문서 인용은 [문서명 p.N] 라벨 + 대상 탭 pageCount 로 검증', () => {
    // Beta 는 9페이지 — Alpha(5p) 범위를 넘는 page=8 도 교차 검증으로 유효
    render(<CitationButton page={8} docName="Beta.pdf" />);
    const btn = screen.getByRole('button');
    expect(btn.textContent).toBe('[Beta.pdf p.8]');
    expect(btn.getAttribute('aria-disabled')).toBeNull();
  });

  it('교차 문서 인용 클릭 → 해당 탭으로 전환 후 페이지 점프', async () => {
    const user = userEvent.setup();
    // 성공 전환 시뮬레이션 — switchToTab 이 활성 문서를 대상으로 바꾼다(가드 통과 조건).
    mockSwitchToTab.mockImplementation(async (fp: string) => {
      useAppStore.setState((s) => ({ document: { ...s.document!, filePath: fp, fileName: 'Beta.pdf', pageCount: 9 } }));
    });
    render(<CitationButton page={8} docName="Beta.pdf" />);
    await user.click(screen.getByRole('button'));
    expect(mockSwitchToTab).toHaveBeenCalledWith('/d/Beta.pdf');
    expect(useAppStore.getState().citationTarget).toEqual({ page: 8 });
  });

  it('QA: 교차 전환이 실패(활성 문서 미변경)하면 점프하지 않음 — 잘못된 문서에 대상 페이지 적용 방지', async () => {
    const user = userEvent.setup();
    // switchToTab 이 차단/실패해 활성 문서가 그대로(Alpha)인 상황 — 기본 목(store 미변경)
    mockSwitchToTab.mockImplementation(async () => { /* no-op: 전환 실패/차단 */ });
    render(<CitationButton page={8} docName="Beta.pdf" />);
    await user.click(screen.getByRole('button'));
    expect(mockSwitchToTab).toHaveBeenCalledWith('/d/Beta.pdf');
    expect(useAppStore.getState().citationTarget).toBeNull(); // Alpha(5p)에 page=8 적용 안 함
  });

  it('대상 문서가 열려 있지 않으면 비활성 (이동 불가)', () => {
    render(<CitationButton page={3} docName="Gamma.pdf" />);
    const el = screen.getByText('[Gamma.pdf p.3]');
    expect(el.getAttribute('aria-disabled')).toBe('true');
  });

  it('교차 문서 인용이 대상 탭 범위도 벗어나면 비활성', () => {
    render(<CitationButton page={99} docName="Beta.pdf" />); // Beta 9p < 99
    const el = screen.getByText('[Beta.pdf p.99]');
    expect(el.getAttribute('aria-disabled')).toBe('true');
  });
});
