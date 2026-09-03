// @vitest-environment happy-dom

/**
 * QA25(B-High): App.tsx 의 자동 업데이트 배너 **배선** 회귀 넷.
 *
 * 이 배너의 유일한 가드는 `update-banner.test.ts` 의 소스 정규식이었다 — `App.tsx` 를 문자열로
 * 읽어 `selectUpdateBanner(` 같은 토큰이 있는지만 봤다. 그건 **도달 가능성을 증명하지 못한다**:
 *  - 구독을 `onStatus(() => {})` 로 갈아치우고 getState().then(applyState) 를 지워도, 죽은
 *    applyState 안에 토큰이 남아 있어 정규식은 통과한다 → 배너가 영원히 뜨지 않는다.
 *  - 렌더 게이트를 `updateBanner?.kind === 'downloaded'` 로 좁혀도 리터럴이 전부 남아 통과한다
 *    → **v0.31.40 이전의 설계 공백(체인이 첫 칸에서 단절)이 그대로 복원**된다.
 * 게다가 App.tsx 는 커버리지 exclude 에도 들어 있어(779줄, 0%) 아무 신호가 없었다.
 *
 * 그래서 자식 컴포넌트는 전부 목으로 치우고 **App 자체를 실제로 렌더**해, main 이 방출하는
 * 상태가 DOM 에 도달하는지를 본다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import type { UpdateState } from '../../shared/update-types';

// 자식 컴포넌트는 이 테스트의 관심사가 아니다 — 렌더 비용과 부수효과만 만든다.
vi.mock('../components/PdfUploader', () => ({ PdfUploader: () => null }));
vi.mock('../components/RecentDocuments', () => ({ RecentDocuments: () => null }));
vi.mock('../components/GlobalSearch', () => ({ GlobalSearch: () => null }));
vi.mock('../components/CollectionsList', () => ({ CollectionsList: () => null }));
vi.mock('../components/TabBar', () => ({ TabBar: () => null }));
vi.mock('../components/SummaryViewer', () => ({ SummaryViewer: () => null }));
vi.mock('../components/SummaryTypeSelector', () => ({ SummaryTypeSelector: () => null }));
vi.mock('../components/StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../components/SettingsPanel', () => ({ SettingsPanel: () => null }));
vi.mock('../components/OllamaSetupWizard', () => ({ OllamaSetupWizard: () => null }));
vi.mock('../lib/use-summarize', () => ({
  useSummarize: () => ({ handleSummarize: vi.fn(), handleAbort: vi.fn() }),
}));
vi.mock('../lib/use-qa', () => ({ useRagBuilder: () => undefined }));
vi.mock('../lib/use-session', () => ({ useSessionPersistence: () => undefined }));
vi.mock('../lib/safe-markdown', () => ({ prefetchMarkdownRenderer: vi.fn() }));
vi.mock('../lib/pdf-parser', () => ({ handlePdfData: vi.fn(), cancelPdfParse: vi.fn() }));
vi.mock('../assets/logo.png', () => ({ default: 'logo.png' }));

/** main 이 방출하는 update 상태를 테스트가 직접 밀어 넣기 위한 콜백 홀더. */
let emit: ((s: UpdateState) => void) | null = null;
const downloadMock = vi.fn(() => Promise.resolve());
const installMock = vi.fn(() => Promise.resolve());
let initialState: UpdateState | null = null;

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    update: {
      onStatus: (cb: (s: UpdateState) => void) => {
        emit = cb;
        return () => { emit = null; };
      },
      getState: () => Promise.resolve(initialState),
      download: downloadMock,
      install: installMock,
    },
    // provider=ollama 인데 미설치/미실행이면 App 이 setup 뷰로 조기 리턴해 메인 UI 자체가
    // 렌더되지 않는다 — 배너를 보려면 정상 상태여야 한다.
    ollama: {
      getStatus: () => Promise.resolve({ installed: true, running: true, models: ['qwen3.5:4b'] }),
      pullModel: vi.fn(),
    },
    settings: { get: () => Promise.resolve({}), set: vi.fn(() => Promise.resolve()) },
    file: { openPdf: vi.fn() },
    onFileDropped: () => () => {},
    getPathForFile: () => '',
  },
}));

import App from '../App';
import { useAppStore } from '../lib/store';
import { DEFAULT_SETTINGS } from '../types';

const state = (over: Partial<UpdateState>): UpdateState => ({
  status: 'idle',
  currentVersion: '1.1.0',
  newVersion: null,
  percent: 0,
  errorKey: null,
  ...over,
});

beforeEach(() => {
  emit = null;
  initialState = null;
  downloadMock.mockClear();
  installMock.mockClear();
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS }, document: null, error: null });
});

afterEach(() => {
  cleanup();
});

async function mountApp() {
  await act(async () => { render(<App />); });
}

async function push(s: UpdateState) {
  await act(async () => { emit?.(s); });
}

/**
 * QA32(A-4): 복사 토스트를 요약 패널 기준(absolute)으로 바꾼 뒤, **배너가 뜨면 화면 밖으로
 * 밀려** 보이지 않는 문제가 생겼다. 원인은 토스트가 아니라 레이아웃이다 — `<main>` 이 블록
 * 컨테이너이고 SummaryViewer 가 `h-full`(=main 의 100%)이라, 배너가 더해지면 콘텐츠가
 * `배너 + 100%` 가 되어 패널 하단이 가시 영역 아래로 내려간다. 토스트는 그 증상일 뿐이고,
 * 선행 문제는 **배너가 있을 때 문서 뷰가 화면 밖으로 밀리는 것** 자체다.
 *
 * happy-dom 은 실제 레이아웃을 계산하지 않으므로 **기제**를 못박는다: main 이 세로 flex 이고
 * 뷰어 래퍼가 남는 공간만 차지하는가. 둘 중 하나만 빠져도 넘침이 돌아온다.
 */
describe('App — 배너가 있어도 문서 뷰가 화면 밖으로 밀리지 않는다 (QA32 A-4)', () => {
  it('main 은 세로 flex 이고 넘치지 않는다', async () => {
    await mountApp();
    const main = document.querySelector('main');
    expect(main, 'main 을 찾지 못했다 — 이 가드가 무력화된 상태다').not.toBeNull();
    expect(main!.className, 'main 이 세로 flex 가 아니다 — 자식이 남는 공간을 나눠 가질 수 없다')
      .toMatch(/(^|\s)flex-col(\s|$)/);
    expect(main!.className, 'min-h-0 이 없으면 flex 자식이 축소되지 않아 넘친다')
      .toMatch(/(^|\s)min-h-0(\s|$)/);
  });
});

describe('App — 자동 업데이트 배너 배선 (QA25)', () => {
  it('main 의 상태 구독이 실제로 배너를 띄운다', async () => {
    await mountApp();
    expect(emit).not.toBeNull(); // 구독 자체가 걸렸는가
    expect(screen.queryByRole('status')).toBeNull();

    await push(state({ status: 'available', newVersion: '9.9.9' }));
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('9.9.9');
  });

  // ★ v0.31.40 설계 공백의 회귀 가드 — 배너가 downloaded 에서만 뜨면 사용자는 "새 버전이 있다"를
  //   영원히 알 수 없고 자동 업데이트 체인이 첫 칸에서 끊긴다.
  it.each([
    ['available', state({ status: 'available', newVersion: '9.9.9' })],
    ['downloading', state({ status: 'downloading', newVersion: '9.9.9', percent: 42 })],
    ['downloaded', state({ status: 'downloaded', newVersion: '9.9.9' })],
  ])('%s 단계에서도 배너가 뜬다 (세 단계 전부)', async (_label, s) => {
    await mountApp();
    await push(s);
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('첫 렌더에서 getState 로 받은 현재 상태도 반영한다 (창을 다시 연 경우)', async () => {
    initialState = state({ status: 'downloaded', newVersion: '8.8.8' });
    await mountApp();
    expect(screen.getByRole('status').textContent).toContain('8.8.8');
  });

  it('available 을 닫아도 downloaded 가 오면 다시 뜬다 (dismiss 해제 배선)', async () => {
    await mountApp();
    await push(state({ status: 'available', newVersion: '9.9.9' }));

    const dismiss = screen.getByRole('status').querySelector('button:last-of-type');
    expect(dismiss).not.toBeNull();
    await act(async () => { (dismiss as HTMLButtonElement).click(); });
    expect(screen.queryByRole('status')).toBeNull();

    await push(state({ status: 'downloaded', newVersion: '9.9.9' }));
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('available 배너의 버튼이 다운로드를 실제로 호출한다', async () => {
    await mountApp();
    await push(state({ status: 'available', newVersion: '9.9.9' }));
    const action = screen.getByRole('status').querySelector('button');
    await act(async () => { (action as HTMLButtonElement).click(); });
    expect(downloadMock).toHaveBeenCalled();
  });
});
