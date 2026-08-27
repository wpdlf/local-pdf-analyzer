// @vitest-environment happy-dom

// SummaryMindMap 행위 — heading 계층 렌더 / 빈 상태 / 페이지 배지(CitationButton) 점프 /
// 범위초과 페이지 비활성 / 노드 접기·펼치기. 실제 store 액션 사용.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SummaryMindMap } from '../SummaryMindMap';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';
import { t } from '../../lib/i18n';

function makeDoc(pageCount: number) {
  return {
    id: 'doc-1', fileName: 'lecture.pdf', filePath: '/d/lecture.pdf', pageCount,
    extractedText: 'x', pageTexts: ['x'], chapters: [], images: [], createdAt: new Date(),
  };
}

beforeEach(() => {
  // CitationButton 이 활성 문서 pageCount 로 인용을 검증하므로 문서를 세팅(범위 넉넉히).
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS }, citationTarget: null, openTabs: [], document: makeDoc(20) });
});
afterEach(() => cleanup());

const MD = '# 문서\n\n## 개요\n\n근거 [p.3] 참조.\n\n### 배경\n\n## 결론\n\n마무리 [p.9].';

describe('SummaryMindMap', () => {
  it('heading 계층을 nav(마인드맵) + 노드로 렌더', () => {
    render(<SummaryMindMap markdown={MD} />);
    expect(screen.getByRole('navigation', { name: t('mindmap.title') })).toBeTruthy();
    expect(screen.getByText('문서')).toBeTruthy();
    expect(screen.getByText('개요')).toBeTruthy();
    expect(screen.getByText('배경')).toBeTruthy();
    expect(screen.getByText('결론')).toBeTruthy();
    // QA15: role=tree/treeitem 은 다운그레이드됨(화살표 내비 미구현 오도 방지)
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });

  it('heading 이 없으면 빈 상태 안내(note)', () => {
    render(<SummaryMindMap markdown={'제목 없는 평문 요약입니다.'} />);
    expect(screen.getByRole('note')).toBeTruthy();
    expect(screen.getByText(t('mindmap.empty'))).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('페이지 배지(CitationButton) 클릭 → citationTarget 설정', async () => {
    const user = userEvent.setup();
    render(<SummaryMindMap markdown={MD} />);
    await user.click(screen.getByRole('button', { name: t('citation.aria', { page: 3 }) }));
    expect(useAppStore.getState().citationTarget?.page).toBe(3);
  });

  it('QA15(MED): 활성 문서 범위를 벗어난 인용은 비활성(클릭 불가) — CitationButton 검증 재사용', async () => {
    useAppStore.setState({ document: makeDoc(5) }); // 5페이지 문서
    const user = userEvent.setup();
    render(<SummaryMindMap markdown={'# 결론\n\n환각 인용 [p.9].'} />); // 9 > 5
    // 버튼이 아니라 비활성 span 으로 렌더 → 클릭해도 citationTarget 미설정
    expect(screen.queryByRole('button', { name: t('citation.aria', { page: 9 }) })).toBeNull();
    const badge = screen.getByText('[p.9]');
    expect(badge.getAttribute('aria-disabled')).toBe('true');
    await user.click(badge);
    expect(useAppStore.getState().citationTarget).toBeNull();
  });

  it('노드 접기 → 하위 숨김, 다시 펼치기 → 복원', async () => {
    const user = userEvent.setup();
    render(<SummaryMindMap markdown={MD} />);
    expect(screen.getByText('개요')).toBeTruthy();
    // QA16(A-LOW): 토글 aria-label 은 "{제목} — 접기/펼치기" 형태 → 정규식 부분매칭.
    const collapseBtns = screen.getAllByRole('button', { name: new RegExp(t('mindmap.collapse')) });
    await user.click(collapseBtns[0]!); // '문서' 루트 접기
    expect(screen.queryByText('개요')).toBeNull();
    await user.click(screen.getByRole('button', { name: new RegExp(t('mindmap.expand')) }));
    expect(screen.getByText('개요')).toBeTruthy();
  });

  it('page 없는 노드는 인용 배지 미표시', () => {
    render(<SummaryMindMap markdown={'# 인용없음\n\n본문만.'} />);
    expect(screen.queryByText('[p.', { exact: false })).toBeNull();
  });

  // QA16(D-LOW): 파서 docName → CitationButton 교차문서 포워딩(SummaryMindMap.tsx:67)이 통합 레벨 미검증이었다.
  it('교차 문서 인용 노드 → 열린 탭이면 교차문서 CitationButton(활성 버튼)', () => {
    useAppStore.setState({ openTabs: [{ fileName: 'Beta.pdf', filePath: '/d/Beta.pdf', pageCount: 10 }] as never });
    render(<SummaryMindMap markdown={'# 요약\n\n근거 [Beta.pdf p.5] 참조.'} />);
    const badge = screen.getByText('[Beta.pdf p.5]');
    expect(badge.tagName).toBe('BUTTON'); // 대상 탭 열림 + 범위내 → 클릭 가능
  });

  it('교차 문서 인용인데 대상 탭이 닫혀 있으면 비활성(오점프 방지)', () => {
    useAppStore.setState({ openTabs: [] });
    render(<SummaryMindMap markdown={'# 요약\n\n[Gamma.pdf p.3] 만.'} />);
    const badge = screen.getByText('[Gamma.pdf p.3]');
    expect(badge.getAttribute('aria-disabled')).toBe('true'); // 버튼 아닌 비활성 span
  });
});

// QA28(B2-Low): 노드 id 가 등장 순서(`mm-N`)라 요약이 바뀌어도 React 가 같은 key 의 인스턴스를
// 재사용해 접어 둔 상태가 전혀 다른 heading 에 붙었다 — 요약 텍스트가 바뀌면 트리를 새로 마운트한다.
describe('SummaryMindMap — QA28(B2-Low) 요약 변경 시 접힘 상태 초기화', () => {
  it('QA28(B2-Low): 접은 뒤 같은 형태의 다른 마크다운으로 rerender → 노드가 다시 펼쳐진다', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SummaryMindMap markdown={MD} />);
    await user.click(screen.getAllByRole('button', { name: new RegExp(t('mindmap.collapse')) })[0]!); // '문서' 접기
    expect(screen.queryByText('개요')).toBeNull();

    // heading 개수·계층이 같고(id 시퀀스 동일) 제목만 다른 요약
    const MD2 = '# 보고서\n\n## 서론\n\n근거 [p.2].\n\n### 동기\n\n## 요약\n\n끝 [p.4].';
    rerender(<SummaryMindMap markdown={MD2} />);
    expect(screen.getByText('서론'), '접힘 상태가 다른 heading 에 붙어 하위가 숨으면 안 된다').toBeTruthy();
    expect(screen.getByText('동기')).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(t('mindmap.expand')) })).toBeNull();
  });

  it('QA28(B2-Low): 같은 마크다운으로 rerender 하면 접힘 상태는 유지된다 (불필요한 리마운트 없음)', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<SummaryMindMap markdown={MD} />);
    await user.click(screen.getAllByRole('button', { name: new RegExp(t('mindmap.collapse')) })[0]!);
    rerender(<SummaryMindMap markdown={MD} />);
    expect(screen.queryByText('개요')).toBeNull();
  });
});
