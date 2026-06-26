// @vitest-environment happy-dom

// multi-doc Phase 1: TabBar 행위 — 빈 목록 미표시 / 탭 렌더·활성 표시 /
// 전환·닫기·새 탭 호출 / 생성·파싱 중 가드(활성 전환·활성 닫기 차단, 비활성 닫기는 허용).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const M = vi.hoisted(() => ({
  switchToTab: vi.fn(() => Promise.resolve()),
  closeTab: vi.fn(() => Promise.resolve()),
  openNewTabView: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/tabs', () => ({
  switchToTab: M.switchToTab,
  closeTab: M.closeTab,
  openNewTabView: M.openNewTabView,
}));

import { TabBar } from '../TabBar';
import { useAppStore } from '../../lib/store';
import type { OpenTab } from '../../types';

function tab(filePath: string, fileName = filePath.split('/').pop() ?? filePath): OpenTab {
  return { filePath, fileName, pageCount: 3 };
}

function setState(opts: { tabs?: OpenTab[]; active?: string | null; blocked?: Partial<{ gen: boolean; qa: boolean; parse: boolean }> }) {
  const { tabs = [], active = null, blocked = {} } = opts;
  useAppStore.setState({
    openTabs: tabs,
    document: active ? ({ filePath: active } as never) : null,
    isGenerating: blocked.gen ?? false,
    isQaGenerating: blocked.qa ?? false,
    isParsing: blocked.parse ?? false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setState({ tabs: [], active: null });
});
afterEach(() => cleanup());

describe('TabBar', () => {
  it('열린 탭이 없으면 렌더하지 않는다', () => {
    const { container } = render(<TabBar />);
    expect(container.firstChild).toBeNull();
  });

  it('열린 탭을 listitem 으로 표시하고 활성 탭 버튼에 aria-current="page" (a11y M4)', () => {
    setState({ tabs: [tab('/d/a.pdf'), tab('/d/b.pdf')], active: '/d/b.pdf' });
    render(<TabBar />);
    // role="tab"/aria-selected 안티패턴 제거 → nav>ul>li 목록 + 활성 표시 aria-current
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText(/a\.pdf/)).toBeTruthy();
    const bBtn = screen.getByText(/b\.pdf/).closest('button')!;
    expect(bBtn.getAttribute('aria-current')).toBe('page');
    const aBtn = screen.getByText(/a\.pdf/).closest('button')!;
    expect(aBtn.getAttribute('aria-current')).toBeNull();
  });

  it('비활성 탭 클릭 → switchToTab(filePath)', async () => {
    setState({ tabs: [tab('/d/a.pdf'), tab('/d/b.pdf')], active: '/d/a.pdf' });
    const user = userEvent.setup();
    render(<TabBar />);
    await user.click(screen.getByText(/b\.pdf/));
    expect(M.switchToTab).toHaveBeenCalledWith('/d/b.pdf');
  });

  it('닫기 버튼 클릭 → closeTab(filePath)', async () => {
    setState({ tabs: [tab('/d/a.pdf')], active: '/d/a.pdf' });
    const user = userEvent.setup();
    render(<TabBar />);
    await user.click(screen.getByRole('button', { name: /a\.pdf 탭 닫기/ }));
    expect(M.closeTab).toHaveBeenCalledWith('/d/a.pdf');
  });

  it('새 탭 버튼 클릭 → openNewTabView', async () => {
    setState({ tabs: [tab('/d/a.pdf')], active: '/d/a.pdf' });
    const user = userEvent.setup();
    render(<TabBar />);
    await user.click(screen.getByRole('button', { name: '새 문서 열기' }));
    expect(M.openNewTabView).toHaveBeenCalledTimes(1);
  });

  it('활성 탭만 열린 상태(activePath=null 아님)에서 + 버튼 활성', () => {
    setState({ tabs: [tab('/d/a.pdf')], active: '/d/a.pdf' });
    render(<TabBar />);
    const btn = screen.getByRole('button', { name: '새 문서 열기' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('생성 중이면 비활성 탭 전환·새 탭이 차단된다', async () => {
    setState({ tabs: [tab('/d/a.pdf'), tab('/d/b.pdf')], active: '/d/a.pdf', blocked: { gen: true } });
    const user = userEvent.setup();
    render(<TabBar />);
    // 비활성 탭(b) 전환 버튼은 disabled — 클릭해도 switchToTab 미호출
    await user.click(screen.getByText(/b\.pdf/));
    expect(M.switchToTab).not.toHaveBeenCalled();
    // 새 탭 버튼 disabled
    const newBtn = screen.getByRole('button', { name: '새 문서 열기' }) as HTMLButtonElement;
    expect(newBtn.disabled).toBe(true);
  });

  it('생성 중이라도 비활성 탭 닫기는 허용된다(목록 제거뿐)', async () => {
    setState({ tabs: [tab('/d/a.pdf'), tab('/d/b.pdf')], active: '/d/a.pdf', blocked: { gen: true } });
    const user = userEvent.setup();
    render(<TabBar />);
    await user.click(screen.getByRole('button', { name: /b\.pdf 탭 닫기/ }));
    expect(M.closeTab).toHaveBeenCalledWith('/d/b.pdf');
  });

  it('생성 중이면 활성 탭 닫기는 차단된다', async () => {
    setState({ tabs: [tab('/d/a.pdf')], active: '/d/a.pdf', blocked: { qa: true } });
    const user = userEvent.setup();
    render(<TabBar />);
    const closeBtn = screen.getByRole('button', { name: /a\.pdf 탭 닫기/ }) as HTMLButtonElement;
    expect(closeBtn.disabled).toBe(true);
    await user.click(closeBtn);
    expect(M.closeTab).not.toHaveBeenCalled();
  });
});
