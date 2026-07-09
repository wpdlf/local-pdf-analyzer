// @vitest-environment happy-dom

// SummaryTypeSelector 행위 — 요약 유형 라디오(체크 상태/선택) / 출력 언어 select /
// 한국어 특화 모델(exaone) + 비한국어 출력 시 경고 표시. 실제 store 액션 사용.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SummaryTypeSelector } from '../SummaryTypeSelector';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

beforeEach(() => {
  useAppStore.setState({
    summaryType: 'full',
    settings: { ...DEFAULT_SETTINGS },
    document: null,
    summaryPageRange: null,
  });
});
afterEach(() => cleanup());

function docStub(pageCount: number) {
  return {
    id: 'd', fileName: 'a.pdf', filePath: '/a.pdf', pageCount,
    extractedText: '', pageTexts: [], chapters: [], images: [], createdAt: new Date(0),
  };
}

describe('SummaryTypeSelector', () => {
  it('3개 요약 유형 라디오를 표시하고 현재 유형이 체크된다', () => {
    useAppStore.setState({ summaryType: 'chapter' });
    render(<SummaryTypeSelector />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(3);
    const checked = radios.find((r) => r.checked);
    expect(checked?.value).toBe('chapter');
  });

  it('라디오 선택 → store.summaryType 변경', async () => {
    const user = userEvent.setup();
    render(<SummaryTypeSelector />);
    await user.click(screen.getByRole('radio', { name: '키워드 추출' }));
    expect(useAppStore.getState().summaryType).toBe('keywords');
  });

  // 커스텀 요약 템플릿(QA10 후속): 기본 3종 뒤에 라디오로 노출, 선택 시 custom:<id> 로 설정.
  it('커스텀 템플릿을 추가 라디오로 노출하고 선택 시 custom:<id> 설정', async () => {
    const user = userEvent.setup();
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, customSummaryTemplates: [{ id: 'abc', name: '액션 아이템', prompt: 'p' }] },
    });
    render(<SummaryTypeSelector />);
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(4); // 기본 3 + 커스텀 1
    await user.click(screen.getByRole('radio', { name: '액션 아이템' }));
    expect(useAppStore.getState().summaryType).toBe('custom:abc');
  });

  it('출력 언어 select 변경 → settings.summaryLanguage 갱신', async () => {
    const user = userEvent.setup();
    render(<SummaryTypeSelector />);
    await user.selectOptions(screen.getByRole('combobox'), 'en');
    expect(useAppStore.getState().settings.summaryLanguage).toBe('en');
  });

  it('select 변경 시 최신 settings 를 읽어 concurrent 필드를 보존한다', async () => {
    // rendered closure 의 stale snapshot 이 아니라 store 의 최신 값을 기준으로 머지해야 한다.
    const user = userEvent.setup();
    render(<SummaryTypeSelector />);
    // 렌더 이후 다른 컴포넌트가 모델을 바꾼 상황을 모사
    useAppStore.setState({ settings: { ...useAppStore.getState().settings, model: 'qwen3.5:4b' } });
    await user.selectOptions(screen.getByRole('combobox'), 'ja');
    const s = useAppStore.getState().settings;
    expect(s.summaryLanguage).toBe('ja');
    expect(s.model).toBe('qwen3.5:4b'); // stale snapshot 으로 롤백되지 않음
  });

  it('exaone(한국어 특화) + 비한국어 출력 → 모델 경고 표시', () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', model: 'exaone:latest', summaryLanguage: 'en' },
    });
    render(<SummaryTypeSelector />);
    expect(screen.getByText(/한국어 특화 모델/)).toBeTruthy();
  });

  it('exaone 이라도 한국어 출력이면 경고 없음', () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', model: 'exaone:latest', summaryLanguage: 'ko' },
    });
    render(<SummaryTypeSelector />);
    expect(screen.queryByText(/한국어 특화 모델/)).toBeNull();
  });

  it('일반 모델(gemma3) + 비한국어 출력이면 경고 없음', () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', model: 'gemma3', summaryLanguage: 'en' },
    });
    render(<SummaryTypeSelector />);
    expect(screen.queryByText(/한국어 특화 모델/)).toBeNull();
  });

  // ─── 페이지 범위 요약 ───
  it('pageCount>1 이면 페이지 범위 UI 표시 + 기본 "전체" 체크, 입력 숨김', () => {
    useAppStore.setState({ document: docStub(10), summaryPageRange: null });
    render(<SummaryTypeSelector />);
    expect(screen.getByText('페이지 범위')).toBeTruthy();
    expect((screen.getByRole('radio', { name: '전체' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText('시작 페이지')).toBeNull();
  });

  it('pageCount<=1 이면 페이지 범위 UI 숨김', () => {
    useAppStore.setState({ document: docStub(1), summaryPageRange: null });
    render(<SummaryTypeSelector />);
    expect(screen.queryByText('페이지 범위')).toBeNull();
  });

  it('"범위 지정" 선택 → summaryPageRange={1,pageCount} + 입력 표시', async () => {
    useAppStore.setState({ document: docStub(10), summaryPageRange: null });
    const user = userEvent.setup();
    render(<SummaryTypeSelector />);
    await user.click(screen.getByRole('radio', { name: '범위 지정' }));
    expect(useAppStore.getState().summaryPageRange).toEqual({ start: 1, end: 10 });
    expect(screen.getByLabelText('시작 페이지')).toBeTruthy();
  });

  it('끝 페이지 입력 변경 → 범위 갱신', () => {
    useAppStore.setState({ document: docStub(10), summaryPageRange: { start: 1, end: 10 } });
    render(<SummaryTypeSelector />);
    fireEvent.change(screen.getByLabelText('끝 페이지'), { target: { value: '5' } });
    expect(useAppStore.getState().summaryPageRange).toEqual({ start: 1, end: 5 });
  });

  it('범위 초과 입력은 pageCount 로 클램프', () => {
    useAppStore.setState({ document: docStub(10), summaryPageRange: { start: 1, end: 10 } });
    render(<SummaryTypeSelector />);
    fireEvent.change(screen.getByLabelText('끝 페이지'), { target: { value: '99' } });
    expect(useAppStore.getState().summaryPageRange?.end).toBe(10);
  });

  it('"전체"로 되돌리면 summaryPageRange=null', async () => {
    useAppStore.setState({ document: docStub(10), summaryPageRange: { start: 2, end: 5 } });
    const user = userEvent.setup();
    render(<SummaryTypeSelector />);
    await user.click(screen.getByRole('radio', { name: '전체' }));
    expect(useAppStore.getState().summaryPageRange).toBeNull();
  });
});
