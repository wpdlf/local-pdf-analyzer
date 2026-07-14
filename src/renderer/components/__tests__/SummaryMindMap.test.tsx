// @vitest-environment happy-dom

// SummaryMindMap 행위 — heading 계층 트리 렌더 / 빈 상태 / 페이지 배지 클릭→citationTarget /
// 노드 접기·펼치기. 실제 store 액션 사용.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SummaryMindMap } from '../SummaryMindMap';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';
import { t } from '../../lib/i18n';

beforeEach(() => {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS }, citationTarget: null });
});
afterEach(() => cleanup());

const MD = '# 문서\n\n## 개요\n\n근거 [p.3] 참조.\n\n### 배경\n\n## 결론\n\n마무리 [p.9].';

describe('SummaryMindMap', () => {
  it('heading 계층을 트리(tree/treeitem)로 렌더', () => {
    render(<SummaryMindMap markdown={MD} />);
    expect(screen.getByRole('tree', { name: t('mindmap.title') })).toBeTruthy();
    expect(screen.getByText('문서')).toBeTruthy();
    expect(screen.getByText('개요')).toBeTruthy();
    expect(screen.getByText('배경')).toBeTruthy();
    expect(screen.getByText('결론')).toBeTruthy();
    // treeitem 이 계층 수만큼 존재
    expect(screen.getAllByRole('treeitem').length).toBe(4);
  });

  it('heading 이 없으면 빈 상태 안내(note)', () => {
    render(<SummaryMindMap markdown={'제목 없는 평문 요약입니다.'} />);
    expect(screen.getByRole('note')).toBeTruthy();
    expect(screen.getByText(t('mindmap.empty'))).toBeTruthy();
    expect(screen.queryByRole('tree')).toBeNull();
  });

  it('페이지 배지 클릭 → citationTarget 설정(인용 뷰어 점프)', async () => {
    const user = userEvent.setup();
    render(<SummaryMindMap markdown={MD} />);
    // '개요' 섹션의 [p.3] 배지
    await user.click(screen.getByRole('button', { name: t('mindmap.jumpAria', { page: '3' }) }));
    expect(useAppStore.getState().citationTarget?.page).toBe(3);
  });

  it('노드 접기 → 하위 항목 숨김, 다시 펼치기 → 복원', async () => {
    const user = userEvent.setup();
    render(<SummaryMindMap markdown={MD} />);
    expect(screen.getByText('개요')).toBeTruthy();
    // '문서' 루트 접기 (첫 collapse 버튼)
    const collapseBtns = screen.getAllByRole('button', { name: t('mindmap.collapse') });
    await user.click(collapseBtns[0]!);
    expect(screen.queryByText('개요')).toBeNull();       // 하위 숨김
    // 다시 펼치기
    await user.click(screen.getByRole('button', { name: t('mindmap.expand') }));
    expect(screen.getByText('개요')).toBeTruthy();
  });

  it('page 없는 노드는 점프 배지 미표시', () => {
    render(<SummaryMindMap markdown={'# 인용없음\n\n본문만.'} />);
    // 어떤 jump 배지도 없어야 함
    expect(screen.queryByText('[p.', { exact: false })).toBeNull();
  });
});
