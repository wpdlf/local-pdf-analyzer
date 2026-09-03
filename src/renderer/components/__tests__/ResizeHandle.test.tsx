// @vitest-environment happy-dom

// ResizeHandle (DR-01) 행위 — separator ARIA 값 / 키보드 조정(Arrow/Home/End, 무관 키 무시) /
// 비율 클램프(0.2~0.8) / 포인터 드래그로 비율 계산. 실제 store(setCitationPanelWidth clamp) 사용.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

import { ResizeHandle } from '../ResizeHandle';
import { useAppStore } from '../../lib/store';
import { DEFAULT_SETTINGS } from '../../types';

// happy-dom 은 pointer capture 미구현 — 핸들러가 호출하므로 스텁
beforeAll(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

function fakeContainer(clientWidth: number, clientHeight = 0) {
  return { current: { clientWidth, clientHeight } as unknown as HTMLDivElement };
}

// QA32 후속: 축이 일반화되면서 값/셋터가 props 로 나왔다 — 좌우 분할의 종전 계약(저장값은
// **우측 패널의 몫**이라 invert)을 그대로 유지한 채 호출한다.
function renderHandle(clientWidth = 1000) {
  const set = (r: number) => useAppStore.getState().setCitationPanelWidth(r);
  return render(
    <ResizeHandle
      containerRef={fakeContainer(clientWidth)}
      ratio={useAppStore.getState().citationPanelWidth}
      onChange={set}
      invert
      labelKey="pdfviewer.resize"
    />,
  );
}

beforeEach(() => {
  useAppStore.setState({ settings: { ...DEFAULT_SETTINGS }, citationPanelWidth: 0.5 });
});
afterEach(() => cleanup());

describe('ResizeHandle', () => {
  it('separator 역할 + ARIA 값(valuenow/min/max/label)', () => {
    renderHandle();
    const sep = screen.getByRole('separator');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.getAttribute('aria-valuenow')).toBe('50');
    expect(sep.getAttribute('aria-valuemin')).toBe('20');
    expect(sep.getAttribute('aria-valuemax')).toBe('80');
    expect(sep.getAttribute('aria-label')).toMatch(/패널 크기 조정/);
  });

  it('ArrowLeft → 우측 패널 +2%', () => {
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.52, 5);
  });

  it('ArrowRight → 우측 패널 -2%', () => {
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowRight' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.48, 5);
  });

  it('Home → 최소(0.2), End → 최대(0.8)', () => {
    renderHandle();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.2, 5);
    fireEvent.keyDown(sep, { key: 'End' });
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.8, 5);
  });

  it('무관한 키는 비율을 바꾸지 않는다', () => {
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'a' });
    expect(useAppStore.getState().citationPanelWidth).toBe(0.5);
  });

  it('최대 경계 초과는 0.8 로 클램프', () => {
    useAppStore.setState({ citationPanelWidth: 0.79 });
    renderHandle();
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' }); // 0.81 → clamp 0.8
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.8, 5);
  });

  it('포인터 드래그 — 왼쪽으로 100px 이동 시 우측 패널 +10%', () => {
    renderHandle(1000);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 }); // deltaPx=-100 → +0.1
    expect(useAppStore.getState().citationPanelWidth).toBeCloseTo(0.6, 5);
    fireEvent.pointerUp(sep, { clientX: 400, pointerId: 1 });
  });

  it('드래그 시작 전 포인터 이동은 무시된다', () => {
    renderHandle(1000);
    const sep = screen.getByRole('separator');
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
    expect(useAppStore.getState().citationPanelWidth).toBe(0.5);
  });

  it('컨테이너 폭 0 이면 드래그가 비율을 바꾸지 않는다', () => {
    renderHandle(0);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientX: 400, pointerId: 1 });
    expect(useAppStore.getState().citationPanelWidth).toBe(0.5);
  });
});

/**
 * QA32 후속(실사용 보고): 컬렉션 통합 요약 결과는 **채팅 쪽**에 렌더되는데 요약/채팅이 고정
 * 50:50 이라 가장 긴 출력이 절반에 갇혔다. 세로 축을 추가하면서 좌우 구현을 복제하지 않고
 * **일반화**했으므로, 두 축이 실제로 다르게 동작하는지 여기서 못박는다(복제였다면 키보드
 * 방향·커서·ARIA 중 하나가 한쪽에만 반영되는 형제 누락이 났을 자리다).
 */
describe('ResizeHandle — 세로 축(상하 분할)', () => {
  // ⚠️ store 를 **구독**하는 래퍼로 렌더한다. `getState()` 를 한 번 읽어 prop 으로 넘기면
  // 값이 고정돼, 연속 키 입력이 매번 같은 baseline 에서 계산된다(초판이 그래서 ArrowDown →
  // ArrowUp 을 0.5 가 아니라 0.48 로 만들었다). 실제 SummaryViewer 는 구독하므로 그쪽에 맞춘다.
  function VerticalHarness({ clientHeight }: { clientHeight: number }) {
    const ratio = useAppStore((st) => st.summarySplitRatio);
    const setRatio = useAppStore((st) => st.setSummarySplitRatio);
    return (
      <ResizeHandle
        containerRef={fakeContainer(0, clientHeight)}
        axis="vertical"
        ratio={ratio}
        onChange={setRatio}
        labelKey="viewer.resizeSplit"
      />
    );
  }

  function renderVertical(clientHeight = 800) {
    return render(<VerticalHarness clientHeight={clientHeight} />);
  }

  beforeEach(() => {
    useAppStore.setState({ summarySplitRatio: 0.5 });
  });

  it('상하를 가르는 것은 **가로** 막대다 (WAI-ARIA: separator 자신의 방향)', () => {
    renderVertical();
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal');
  });

  it('아래로 끌면 위(요약) 영역이 커진다', () => {
    renderVertical(800);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientY: 560, pointerId: 1 }); // +160px / 800 = +0.2
    expect(useAppStore.getState().summarySplitRatio).toBeCloseTo(0.7, 5);
  });

  it('위로 끌면 채팅 영역이 커진다 (좌우 축과 부호가 반대다)', () => {
    renderVertical(800);
    const sep = screen.getByRole('separator');
    fireEvent.pointerDown(sep, { clientY: 400, pointerId: 1 });
    fireEvent.pointerMove(sep, { clientY: 240, pointerId: 1 });
    expect(useAppStore.getState().summarySplitRatio).toBeCloseTo(0.3, 5);
  });

  it('세로 축은 위/아래 방향키를 쓴다 (좌우 키는 무시)', () => {
    renderVertical();
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(useAppStore.getState().summarySplitRatio).toBe(0.5);
    fireEvent.keyDown(sep, { key: 'ArrowDown' });
    expect(useAppStore.getState().summarySplitRatio).toBeCloseTo(0.52, 5);
    fireEvent.keyDown(sep, { key: 'ArrowUp' });
    expect(useAppStore.getState().summarySplitRatio).toBeCloseTo(0.5, 5);
  });

  it('상하한을 넘지 않는다 (한쪽이 사라지지 않도록)', () => {
    renderVertical(800);
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'End' });
    expect(useAppStore.getState().summarySplitRatio).toBe(0.8);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(useAppStore.getState().summarySplitRatio).toBe(0.2);
  });
});
