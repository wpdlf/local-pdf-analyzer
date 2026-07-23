// @vitest-environment happy-dom

// SettingsPanel 의 앱 업데이트 섹션 — 상태별 UI/조작 매핑.
// main 이 상태 머신을 소유하므로 패널은 "status → 무엇을 보여주고 무엇을 누를 수 있는가" 만
// 책임진다. 그 매핑이 어긋나면 (a) 다운로드 끝났는데 설치 버튼이 없거나 (b) 진행 중에 버튼이
// 열려 중복 조작이 나가므로, 상태별로 고정한다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateState } from '../../../shared/update-types';

const updateMock = {
  getState: vi.fn<() => Promise<UpdateState>>(),
  check: vi.fn(() => Promise.resolve({} as UpdateState)),
  download: vi.fn(() => Promise.resolve({} as UpdateState)),
  install: vi.fn(() => Promise.resolve({} as UpdateState)),
  onStatus: vi.fn<(cb: (s: UpdateState) => void) => () => void>(() => () => {}),
};

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
    ollama: {
      getStatus: vi.fn(() => Promise.resolve({ installed: true, running: true, models: [], version: '0.6.0' })),
      listModels: vi.fn(() => Promise.resolve([])),
      pullModel: vi.fn(), cancelPull: vi.fn(), start: vi.fn(), stop: vi.fn(),
    },
    apiKey: { has: vi.fn(() => Promise.resolve(false)) },
    session: { stats: vi.fn(() => Promise.resolve({ count: 0, totalBytes: 0, dir: 'C:/x' })), clear: vi.fn() },
    update: updateMock,
    onSetupProgress: vi.fn(() => () => {}),
    openExternal: vi.fn(),
  },
}));

import { SettingsPanel } from '../SettingsPanel';
import { t } from '../../lib/i18n';

const state = (over: Partial<UpdateState> = {}): UpdateState => ({
  status: 'idle', currentVersion: '1.0.0', newVersion: null, percent: 0, errorKey: null, ...over,
});

/** 주어진 초기 상태로 패널을 렌더하고 첫 상태 반영을 기다린다. */
async function renderWith(initial: UpdateState) {
  updateMock.getState.mockResolvedValue(initial);
  render(<SettingsPanel />);
  await waitFor(() => expect(screen.getByText(t('update.section'))).toBeTruthy());
  return userEvent.setup();
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMock.onStatus.mockImplementation(() => () => {});
});
afterEach(cleanup);

describe('SettingsPanel — 앱 업데이트 섹션', () => {
  it('현재 버전을 표시한다', async () => {
    await renderWith(state({ status: 'not-available', currentVersion: '0.31.29' }));
    expect(screen.getByText(t('update.currentVersion', { version: '0.31.29' }))).toBeTruthy();
  });

  it('unsupported(개발 실행) — 조작 버튼 없이 안내만 표시', async () => {
    await renderWith(state({ status: 'unsupported' }));
    expect(screen.getByText(t('update.unsupported'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('update.checkBtn') })).toBeNull();
  });

  it('idle — "지금 확인" 버튼이 update.check 를 호출', async () => {
    const user = await renderWith(state({ status: 'idle' }));
    await user.click(screen.getByRole('button', { name: t('update.checkBtn') }));
    expect(updateMock.check).toHaveBeenCalledTimes(1);
  });

  it('checking/downloading 중에는 "지금 확인"이 비활성 (중복 요청 차단)', async () => {
    await renderWith(state({ status: 'checking' }));
    expect(screen.getByRole('button', { name: t('update.checkBtn') }).hasAttribute('disabled')).toBe(true);
    cleanup();
    await renderWith(state({ status: 'downloading', newVersion: '1.1.0', percent: 30 }));
    expect(screen.getByRole('button', { name: t('update.checkBtn') }).hasAttribute('disabled')).toBe(true);
  });

  it('not-available — 최신 안내, 다운로드/설치 버튼 없음', async () => {
    await renderWith(state({ status: 'not-available' }));
    expect(screen.getByText(t('update.upToDate'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('update.downloadBtn') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('update.installBtn') })).toBeNull();
  });

  it('available — 새 버전 안내 + 다운로드 버튼이 update.download 호출', async () => {
    const user = await renderWith(state({ status: 'available', newVersion: '1.1.0' }));
    expect(screen.getByText(t('update.available', { version: '1.1.0' }))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('update.downloadBtn') }));
    expect(updateMock.download).toHaveBeenCalledTimes(1);
  });

  it('downloading — 진행률 텍스트 + progressbar(aria-valuenow)', async () => {
    await renderWith(state({ status: 'downloading', newVersion: '1.1.0', percent: 42 }));
    expect(screen.getByText(t('update.downloading', { percent: 42 }))).toBeTruthy();
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
  });

  it('downloaded — 설치 버튼이 update.install 호출 + 종료 안내 표시', async () => {
    const user = await renderWith(state({ status: 'downloaded', newVersion: '1.1.0', percent: 100 }));
    expect(screen.getByText(t('update.downloaded', { version: '1.1.0' }))).toBeTruthy();
    expect(screen.getByText(t('update.installNotice'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('update.installBtn') }));
    expect(updateMock.install).toHaveBeenCalledTimes(1);
  });

  it('error — errorKey 가 i18n 메시지로 번역된다 (원문 노출 없음)', async () => {
    await renderWith(state({ status: 'error', errorKey: 'updateNetwork' }));
    expect(screen.getByText(t('mainerr.updateNetwork'))).toBeTruthy();
  });

  it('errorKey 가 없는 error 도 안전한 기본 메시지로 표시된다', async () => {
    await renderWith(state({ status: 'error', errorKey: null }));
    expect(screen.getByText(t('mainerr.updateUnknown'))).toBeTruthy();
  });

  it('push 로 도착한 상태 변화가 즉시 반영된다 (재조회 없이)', async () => {
    let push: ((s: UpdateState) => void) | null = null;
    updateMock.onStatus.mockImplementation((cb) => { push = cb; return () => {}; });
    await renderWith(state({ status: 'checking' }));
    expect(push).toBeTypeOf('function');
    push!(state({ status: 'available', newVersion: '2.0.0' }));
    await waitFor(() => expect(screen.getByText(t('update.available', { version: '2.0.0' }))).toBeTruthy());
  });

  it('언마운트 시 상태 구독을 해제한다 (leak 가드)', async () => {
    const unsub = vi.fn();
    updateMock.onStatus.mockImplementation(() => unsub);
    await renderWith(state({ status: 'idle' }));
    cleanup();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
