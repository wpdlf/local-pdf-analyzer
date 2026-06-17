// @vitest-environment happy-dom

// SummaryTypeSelector 행위 — 요약 유형 라디오(체크 상태/선택) / 출력 언어 select /
// 한국어 특화 모델(exaone) + 비한국어 출력 시 경고 표시. 실제 store 액션 사용.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SummaryTypeSelector } from '../SummaryTypeSelector';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

beforeEach(() => {
  useAppStore.setState({
    summaryType: 'full',
    settings: { ...DEFAULT_SETTINGS },
  });
});
afterEach(() => cleanup());

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
});
