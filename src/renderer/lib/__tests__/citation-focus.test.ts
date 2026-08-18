// @vitest-environment happy-dom

/**
 * QA25(B-Important): citation-focus 의 첫 직접 테스트.
 *
 * 이 모듈을 언급하는 유일한 테스트가 `SummaryViewer.test.tsx` 의 `vi.mock('../../lib/citation-focus')`
 * 였다 — 즉 기능 전체가 **목으로 대체된 곳에서만** 관측됐고, 실제 동작은 아무도 보지 않았다.
 * 그래서 restoreCitationFocus 본문을 비워도, PdfViewer 의 호출을 지워도, CitationButton 의
 * 등록을 지워도 전부 그린이었다 — QA14(D-MED)가 고친 "패널 닫으면 포커스가 <body> 로 유실"이
 * 그대로 부활할 수 있는 상태였다.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setCitationReturnFocus, restoreCitationFocus } from '../citation-focus';

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = '[p.3]';
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
  // 모듈 스코프 홀더를 비운다 — 앞 테스트의 등록이 새면 순서 의존이 생긴다.
  setCitationReturnFocus(null);
  restoreCitationFocus();
});

describe('citation-focus', () => {
  it('등록된 트리거로 포커스를 반환한다', () => {
    const btn = makeButton();
    const other = makeButton();
    other.focus();
    expect(document.activeElement).toBe(other);

    setCitationReturnFocus(btn);
    restoreCitationFocus();
    expect(document.activeElement).toBe(btn);
  });

  it('1회성이다 — 소비 후에는 포커스를 다시 옮기지 않는다', () => {
    const btn = makeButton();
    setCitationReturnFocus(btn);
    restoreCitationFocus();
    expect(document.activeElement).toBe(btn);

    const other = makeButton();
    other.focus();
    restoreCitationFocus(); // 두 번째 호출 — 아무 일도 없어야 한다
    expect(document.activeElement).toBe(other);
  });

  it('트리거가 DOM 에서 사라졌으면 no-op 이다 (언마운트된 요소로 포커스를 옮기지 않는다)', () => {
    const btn = makeButton();
    setCitationReturnFocus(btn);
    btn.remove();
    expect(btn.isConnected).toBe(false);

    const other = makeButton();
    other.focus();
    restoreCitationFocus();
    expect(document.activeElement).toBe(other);
  });

  it('등록 없이 호출해도 던지지 않는다', () => {
    expect(() => restoreCitationFocus()).not.toThrow();
  });

  it('null 등록은 이전 등록을 지운다', () => {
    const btn = makeButton();
    setCitationReturnFocus(btn);
    setCitationReturnFocus(null);

    const other = makeButton();
    other.focus();
    restoreCitationFocus();
    expect(document.activeElement).toBe(other);
  });
});
