// @vitest-environment happy-dom

// R44 I-4: SettingsPanel 의 수동 모델 다운로드 취소 흐름 — 컴포넌트 레벨 가드 0건이던 영역.
// 검증 계약: (1) 다운로드 진행 중 취소 버튼이 cancelPull IPC 를 호출한다,
// (2) 취소로 끝난 pull(errorKey 'pullCancelled')은 빨간 에러 배너를 띄우지 않는다 (R44 I-1).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ollamaMock = {
  getStatus: vi.fn(() => Promise.resolve({ installed: true, running: true, models: ['gemma3:latest'] })),
  listModels: vi.fn(() => Promise.resolve(['gemma3:latest'])),
  pullModel: vi.fn(),
  cancelPull: vi.fn(() => Promise.resolve({ success: true })),
  start: vi.fn(),
  stop: vi.fn(),
};

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
    ollama: ollamaMock,
    apiKey: { has: vi.fn(() => Promise.resolve(false)) },
    session: { stats: vi.fn(() => Promise.resolve({ count: 0, totalBytes: 0, dir: 'C:/x' })), clear: vi.fn() },
    update: {
      getState: vi.fn(() => Promise.resolve({ status: 'unsupported', currentVersion: '9.9.9', newVersion: null, percent: 0, errorKey: null })),
      check: vi.fn(), download: vi.fn(), install: vi.fn(),
      onStatus: vi.fn(() => () => {}),
    },
    onSetupProgress: vi.fn(() => () => {}),
    openExternal: vi.fn(),
  },
}));

import { SettingsPanel } from '../SettingsPanel';
import { t } from '../../lib/i18n';
import { useAppStore } from '../../lib/store';

describe('SettingsPanel 수동 pull 취소 (R44 I-1/I-4)', () => {
  beforeEach(() => {
    // theme 'system' 은 matchMedia 의존 — 테스트 환경 변수 제거를 위해 light 고정
    useAppStore.setState((s) => ({
      settings: { ...s.settings, provider: 'ollama' as const, theme: 'light' as const },
    }));
  });

  afterEach(() => {
    cleanup();
    useAppStore.setState((s) => ({
      settings: { ...s.settings, theme: 'system' as const },
      view: 'main' as const,
    }));
  });

  it('다운로드 진행 중 취소 버튼 → cancelPull 호출, pullCancelled 결과는 에러 배너 없음', async () => {
    let resolvePull: (v: unknown) => void = () => {};
    ollamaMock.pullModel.mockImplementationOnce(
      () => new Promise((res) => { resolvePull = res; }),
    );
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.type(screen.getByPlaceholderText(t('settings.modelPlaceholder')), 'llava');
    await user.click(screen.getByText(t('settings.addModel')));

    // 진행줄 + 취소 버튼 노출
    const cancelBtn = await screen.findByText(t('common.cancel'));
    await user.click(cancelBtn);
    expect(ollamaMock.cancelPull).toHaveBeenCalledTimes(1);

    // main 이 취소로 종료 보고 — 에러 배너(role=alert) 미표시 + 진행줄 정리
    resolvePull({ success: false, error: '모델 다운로드가 취소되었습니다.', errorKey: 'pullCancelled' });
    await waitFor(() => {
      expect(screen.queryByText(t('common.cancel'))).toBeNull(); // isPulling 종료
    });
    expect(screen.queryByRole('alert')).toBeNull(); // R44 I-1: 취소는 실패가 아니다
  });

  it('실제 실패(pullFailed)는 기존대로 에러 배너 표시', async () => {
    ollamaMock.pullModel.mockResolvedValueOnce({
      success: false,
      error: '모델 다운로드 실패 (exit code: 1)',
      errorKey: 'pullFailed',
      errorParams: { detail: 'exit code: 1' },
    });
    const user = userEvent.setup();
    render(<SettingsPanel />);

    await user.type(screen.getByPlaceholderText(t('settings.modelPlaceholder')), 'llava');
    await user.click(screen.getByText(t('settings.addModel')));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  });
});
