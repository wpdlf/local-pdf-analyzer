// @vitest-environment happy-dom

// SettingsPanel 본체 행위 — API 키 저장/삭제/공백·실패 / provider 저장 게이팅(키 선저장) /
// provider 전환 시 모델 자동 선택 / 청크 크기 검증·blur clamp / 변경 저장(updateSettings) /
// 닫기(setView main) / 세션 통계·전체 비우기(confirm) / Ollama 재시작 성공·실패.
// pull 흐름은 SettingsPanel-pull.test.tsx 가 별도 커버.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type KeyResult = { success: boolean; error?: string };
const api = {
  has: vi.fn((_p: string) => Promise.resolve(false)),
  save: vi.fn((): Promise<KeyResult> => Promise.resolve({ success: true })),
  delete: vi.fn((): Promise<KeyResult> => Promise.resolve({ success: true })),
};
const ollamaMock = {
  getStatus: vi.fn(() => Promise.resolve({ installed: true, running: true, models: ['gemma3:latest'], version: '0.6.0' })),
  listModels: vi.fn(() => Promise.resolve(['gemma3:latest'])),
  pullModel: vi.fn(() => Promise.resolve({ success: true })),
  cancelPull: vi.fn(() => Promise.resolve({ success: true })),
  start: vi.fn(() => Promise.resolve()),
  stop: vi.fn(() => Promise.resolve()),
};
const sessionMock = {
  stats: vi.fn(() => Promise.resolve({ count: 3, totalBytes: 2048, dir: 'C:/sessions' })),
  clear: vi.fn(() => Promise.resolve()),
};

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
    ollama: ollamaMock,
    apiKey: api,
    session: sessionMock,
    onSetupProgress: vi.fn(() => () => {}),
    openExternal: vi.fn(),
  },
}));

import { SettingsPanel } from '../SettingsPanel';
import { t } from '../../lib/i18n';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

beforeEach(() => {
  vi.clearAllMocks();
  api.has.mockResolvedValue(false);
  api.save.mockResolvedValue({ success: true });
  api.delete.mockResolvedValue({ success: true });
  sessionMock.stats.mockResolvedValue({ count: 3, totalBytes: 2048, dir: 'C:/sessions' });
  // theme 'light' 고정 — 'system' 은 matchMedia 의존
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', theme: 'light' },
    ollamaStatus: { installed: true, running: true, models: ['gemma3:latest'] },
    view: 'settings',
    error: null,
  });
  window.confirm = vi.fn(() => true);
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, theme: 'system' }, view: 'main' });
});

function claudeKeyInput() {
  return screen.getAllByPlaceholderText(t('settings.apiKeyPlaceholder'))[0] as HTMLInputElement;
}

describe('SettingsPanel — API 키 관리', () => {
  it('공백 키 저장 시도 → keyEmpty 안내, save IPC 미호출', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.type(claudeKeyInput(), '   ');
    await user.click(screen.getByText(t('common.save')));
    expect(screen.getByText(t('settings.keyEmpty'))).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
  });

  it('키 저장 성공 → apiKey.save 호출 + keySaved 안내 + 입력 비워짐', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    const input = claudeKeyInput();
    await user.type(input, 'sk-ant-123');
    await user.click(screen.getByText(t('common.save')));
    expect(api.save).toHaveBeenCalledWith('claude', 'sk-ant-123');
    await waitFor(() => expect(input.value).toBe(''));
  });

  it('키 저장 실패(result.success=false) → 에러 메시지', async () => {
    api.save.mockResolvedValueOnce({ success: false, error: 'safeStorage 불가' });
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.type(claudeKeyInput(), 'sk-ant-xyz');
    await user.click(screen.getByText(t('common.save')));
    await waitFor(() => expect(screen.getByText('safeStorage 불가')).toBeTruthy());
  });
});

describe('SettingsPanel — 저장 게이팅 / 전환', () => {
  it('provider=claude 인데 키 미저장 → 저장 차단(saveKeyFirst), updateSettings 미반영', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.click(screen.getByRole('radio', { name: /Claude API/ }));
    await user.click(screen.getByText(t('settings.saveBtn')));
    expect(screen.getByText(t('settings.saveKeyFirst', { provider: 'Claude' }))).toBeTruthy();
    expect(useAppStore.getState().settings.provider).toBe('ollama'); // 미저장
  });

  it('provider 라디오를 claude 로 바꾸면 모델이 claude 기본 모델로 전환', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.click(screen.getByRole('radio', { name: /Claude API/ }));
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    await waitFor(() => expect(select.value.startsWith('claude')).toBe(true));
  });

  it('변경 후 저장 → updateSettings 반영 + 저장됨 버튼', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.click(screen.getByRole('radio', { name: t('settings.themeDark') }));
    await user.click(screen.getByText(t('settings.saveBtn')));
    expect(useAppStore.getState().settings.theme).toBe('dark');
    expect(screen.getByText(t('settings.savedBtn'))).toBeTruthy();
  });

  it('닫기 → view=main 으로 전환', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.click(screen.getByRole('button', { name: t('settings.closePanel') }));
    expect(useAppStore.getState().view).toBe('main');
  });
});

describe('SettingsPanel — 청크 크기 검증', () => {
  it('범위 밖 값 → aria-invalid + 범위 안내, blur 시 clamp', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '50'); // 1000 미만
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('1000–16000')).toBeTruthy();
    input.blur();
    await waitFor(() => expect(input.value).toBe('1000')); // clamp
  });
});

describe('SettingsPanel — 세션 데이터 / Ollama', () => {
  it('세션 통계 표시 + 전체 비우기(confirm) → session.clear 호출', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    const clearBtn = await screen.findByText(t('settings.clearSessions'));
    await user.click(clearBtn);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(sessionMock.clear).toHaveBeenCalledTimes(1);
  });

  it('confirm 취소 시 session.clear 미호출', async () => {
    window.confirm = vi.fn(() => false);
    const user = userEvent.setup();
    render(<SettingsPanel />);
    const clearBtn = await screen.findByText(t('settings.clearSessions'));
    await user.click(clearBtn);
    expect(sessionMock.clear).not.toHaveBeenCalled();
  });

  it('Ollama 재시작 성공 → stop/start/getStatus → ollamaStatus 갱신 + 성공 notice(L3)', async () => {
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.click(screen.getByText(t('settings.restartOllama')));
    await waitFor(() => {
      expect(ollamaMock.stop).toHaveBeenCalled();
      expect(ollamaMock.start).toHaveBeenCalled();
      expect(useAppStore.getState().ollamaStatus.version).toBe('0.6.0');
    });
    // L3: 성공 후 전역 notice 로 피드백
    await waitFor(() => expect(useAppStore.getState().notice?.message).toBe(t('settings.restartOk')));
  });

  it('Ollama 재시작 실패 → OLLAMA_NOT_RUNNING 에러', async () => {
    ollamaMock.stop.mockRejectedValueOnce(new Error('no daemon'));
    const user = userEvent.setup();
    render(<SettingsPanel />);
    await user.click(screen.getByText(t('settings.restartOllama')));
    await waitFor(() => expect(useAppStore.getState().error?.code).toBe('OLLAMA_NOT_RUNNING'));
  });
});

describe('SettingsPanel — M2 생성 중 게이트', () => {
  it('평시 → 안내 배너 없음', () => {
    render(<SettingsPanel />);
    expect(screen.queryByText(/AI 생성 중입니다/)).toBeNull();
  });

  it('생성 중 → 안내 배너 + provider/모델/청크는 disabled fieldset 안, 테마/언어는 게이트 밖', () => {
    // fieldset[disabled] 는 자식 input.disabled IDL 에 반영되지 않으므로(브라우저 동일)
    // closest('fieldset').disabled 로 "실제 비활성" 을 검증한다.
    useAppStore.setState({ isGenerating: true });
    const { container } = render(<SettingsPanel />);
    expect(screen.getByText(/AI 생성 중입니다/)).toBeTruthy();

    const providerFs = container.querySelector('input[name="provider"]')?.closest('fieldset') as HTMLFieldSetElement | null;
    const chunkFs = container.querySelector('input[type="number"]')?.closest('fieldset') as HTMLFieldSetElement | null;
    expect(providerFs?.disabled).toBe(true);
    expect(chunkFs?.disabled).toBe(true);

    // 테마/언어는 어떤 disabled fieldset 에도 속하지 않음 → 생성 중에도 변경 가능
    expect(container.querySelector('input[name="theme"]')?.closest('fieldset')).toBeNull();
    expect(container.querySelector('input[name="uiLanguage"]')?.closest('fieldset')).toBeNull();
  });
});
