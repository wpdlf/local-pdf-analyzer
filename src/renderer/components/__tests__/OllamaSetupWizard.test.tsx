// @vitest-environment happy-dom

// 첫 설치 경량화: exaone3.5(약 4.8GB)를 필수 설치에서 선택 설치로 분리한 변경의 회귀 가드.
// 핵심 계약 — (1) 기본 상태에서 설치 목록에 exaone3.5 가 없다, (2) 체크박스 선택 시에만
// pull 대상에 포함된다, (3) INITIAL_INSTALL_MODELS 에 exaone3.5 가 다시 들어가면
// App.tsx ensureDefaultModels 가 매 실행 재다운로드하므로 상수 drift 를 차단한다.
//
// 환경 격리: CitationButton.test.tsx 와 동일하게 본 파일만 happy-dom pragma 로 실행.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const ollamaMock = {
  getStatus: vi.fn(),
  install: vi.fn(),
  start: vi.fn(),
  listModels: vi.fn(),
  pullModel: vi.fn(),
};

// store.ts 는 module init 시 localStorage / window.electronAPI 를 참조한다.
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
    ollama: ollamaMock,
    onSetupProgress: vi.fn(() => () => {}),
    openExternal: vi.fn(),
  },
}));

import { OllamaSetupWizard } from '../OllamaSetupWizard';
import { t } from '../../lib/i18n';
import { useAppStore } from '../../lib/store';
import {
  INITIAL_INSTALL_MODELS,
  OPTIONAL_KOREAN_MODEL,
  KOREAN_RECOMMENDED_MODELS,
} from '../../types';

describe('설치 모델 상수 drift 가드', () => {
  it('INITIAL_INSTALL_MODELS 는 선택 설치 모델(exaone3.5)을 포함하지 않는다', () => {
    // 여기 다시 추가되면 ensureDefaultModels 가 사용자의 미설치 선택을 무시하고
    // 백그라운드에서 4.8GB 를 재다운로드하게 된다.
    expect(INITIAL_INSTALL_MODELS as readonly string[]).not.toContain(OPTIONAL_KOREAN_MODEL);
  });

  it('필수 모델은 범용 요약(gemma3) + RAG 임베딩(nomic-embed-text)', () => {
    expect(INITIAL_INSTALL_MODELS as readonly string[]).toContain('gemma3');
    expect(INITIAL_INSTALL_MODELS as readonly string[]).toContain('nomic-embed-text');
  });

  it('선택 설치 모델은 추천 모델 목록에 남아 설정 → 모델 관리에서 추가 가능하다', () => {
    expect(KOREAN_RECOMMENDED_MODELS).toContain(OPTIONAL_KOREAN_MODEL);
  });
});

describe('OllamaSetupWizard 선택 설치', () => {
  const koreanItemLabel = () => t('setup.downloadKorean', { model: OPTIONAL_KOREAN_MODEL });

  beforeEach(() => {
    ollamaMock.getStatus.mockResolvedValue({ installed: true, running: true, models: ['gemma3'] });
    ollamaMock.install.mockResolvedValue({ success: true });
    ollamaMock.start.mockResolvedValue(undefined);
    // 첫 호출(설치 전 검사)은 빈 목록, 이후(pull 후 최종 검증)는 설치 완료 목록
    ollamaMock.listModels
      .mockResolvedValue(['gemma3', 'nomic-embed-text', OPTIONAL_KOREAN_MODEL])
      .mockResolvedValueOnce([]);
    ollamaMock.pullModel.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
    // 언어 토글 테스트가 store 싱글톤의 uiLanguage 를 바꾸므로 매 테스트 후 ko 로 복원
    useAppStore.setState((s) => ({ settings: { ...s.settings, uiLanguage: 'ko' as const } }));
  });

  it('welcome 우상단 토글로 영어 전환 — 문구 즉시 영어로, 다시 한국어 복귀', async () => {
    const user = userEvent.setup();
    render(<OllamaSetupWizard />);

    await user.click(screen.getByText('English'));
    expect(useAppStore.getState().settings.uiLanguage).toBe('en');
    // useT() 가 store 구독이므로 재렌더 즉시 영어 문구 노출
    expect(screen.getByText(t('setup.start'))).toBeTruthy();
    expect(t('setup.start')).toBe('Start setup');

    await user.click(screen.getByText('한국어'));
    expect(useAppStore.getState().settings.uiLanguage).toBe('ko');
    expect(t('setup.start')).toBe('설정 시작');
  });

  it('welcome 목록에 exaone3.5 가 기본 제외되고, 체크하면 나타난다', async () => {
    const user = userEvent.setup();
    render(<OllamaSetupWizard />);

    expect(screen.queryByText(koreanItemLabel())).toBeNull();
    // 안내 문구(한국어 자료 권장 + 나중에 추가 가능)가 체크박스와 함께 노출된다
    expect(screen.getByText(t('setup.koreanOptionDesc'))).toBeTruthy();

    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByText(koreanItemLabel())).toBeTruthy();

    await user.click(screen.getByRole('checkbox'));
    expect(screen.queryByText(koreanItemLabel())).toBeNull();
  });

  it('체크 해제 상태로 시작하면 필수 모델만 pull 한다', async () => {
    const user = userEvent.setup();
    render(<OllamaSetupWizard />);

    await user.click(screen.getByText(t('setup.start')));

    await waitFor(() =>
      expect(ollamaMock.pullModel).toHaveBeenCalledTimes(INITIAL_INSTALL_MODELS.length),
    );
    for (const model of INITIAL_INSTALL_MODELS) {
      expect(ollamaMock.pullModel).toHaveBeenCalledWith(model);
    }
    expect(ollamaMock.pullModel).not.toHaveBeenCalledWith(OPTIONAL_KOREAN_MODEL);
  });

  it('체크하면 exaone3.5 도 함께 pull 한다', async () => {
    const user = userEvent.setup();
    render(<OllamaSetupWizard />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByText(t('setup.start')));

    await waitFor(() =>
      expect(ollamaMock.pullModel).toHaveBeenCalledTimes(INITIAL_INSTALL_MODELS.length + 1),
    );
    expect(ollamaMock.pullModel).toHaveBeenCalledWith(OPTIONAL_KOREAN_MODEL);
  });

  it('이미 설치된 모델은 선택돼 있어도 pull 을 건너뛴다 (prefix 매칭)', async () => {
    // 사용자가 exaone3.5:2.4b 같은 작은 태그를 수동 설치한 경우 재다운로드하지 않는다
    // (beforeEach 의 mockResolvedValueOnce([]) 큐를 비우기 위해 reset 후 재설정)
    ollamaMock.listModels.mockReset();
    ollamaMock.listModels.mockResolvedValue(['gemma3:4b', 'exaone3.5:2.4b']);
    const user = userEvent.setup();
    render(<OllamaSetupWizard />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByText(t('setup.start')));

    await waitFor(() => expect(ollamaMock.pullModel).toHaveBeenCalledTimes(1));
    expect(ollamaMock.pullModel).toHaveBeenCalledWith('nomic-embed-text');
  });
});
