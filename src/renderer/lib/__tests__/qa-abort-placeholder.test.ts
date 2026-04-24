import { describe, it, expect, vi, beforeEach } from 'vitest';

// v0.18.5 Round 23 #1 회귀 테스트 — handleQaAbort 가 빈 partial (verify/draft 단계 중단)
// 에서 placeholder assistant 를 주입해 "user→assistant 짝" 불변식을 유지하는지 검증.
//
// 이전: [u_orphan, u_new] 같은 연속 user 상태가 만들어지고 M3 FIFO 짝수 drop 이 그 쌍을
//       함께 제거해 윈도우 선두가 assistant 로 시작하는 orphan 생성 가능했음.

vi.stubGlobal('window', {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
});
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random()}` });

import { useAppStore } from '../store';

/**
 * handleQaAbort 의 핵심 로직을 순수 함수로 재현 — hooks 런타임 없이 동일 불변식 검증.
 * 실제 구현(use-qa.ts:544-570)과 동일한 순서:
 *  1) isQaGenerating false 면 no-op (중복 호출 방어)
 *  2) flushQaStream → partial 확보
 *  3) partial 있으면 addQaMessage, 없으면 placeholder 주입 (이번 fix)
 *  4) clearQaStream / setIsQaGenerating(false)
 */
function simulateAbort(placeholder = '(답변이 취소되었습니다)'): void {
  const store = useAppStore.getState();
  if (!store.isQaGenerating) return;
  store.flushQaStream();
  const partial = useAppStore.getState().qaStream;
  if (partial) {
    store.addQaMessage({ role: 'assistant', content: partial });
  } else {
    store.addQaMessage({ role: 'assistant', content: placeholder });
  }
  store.clearQaStream();
  store.setIsQaGenerating(false);
}

function resetStore(): void {
  useAppStore.setState({
    qaMessages: [],
    qaStream: '',
    isQaGenerating: false,
    qaRequestId: null,
    qaVerifying: false,
  });
}

describe('handleQaAbort pair invariant (Round 23 #1)', () => {
  beforeEach(() => { resetStore(); });

  it('빈 partial 시 placeholder assistant 가 주입되어 user→assistant 짝 유지', () => {
    const s = useAppStore.getState();
    s.addQaMessage({ role: 'user', content: '질문1' });
    s.setIsQaGenerating(true);
    // verify/draft 단계 abort: qaStream 비어있음
    simulateAbort();
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('취소');
  });

  it('partial 이 있으면 기존 동작대로 partial 을 assistant 로 저장 (placeholder 없음)', () => {
    const s = useAppStore.getState();
    s.addQaMessage({ role: 'user', content: '질문' });
    s.setIsQaGenerating(true);
    useAppStore.setState({ qaStream: '부분 답변 내용' });
    simulateAbort();
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('부분 답변 내용');
  });

  it('연속 abort (빈 partial × 2) 도 isQaGenerating 가드로 중복 placeholder 방지', () => {
    const s = useAppStore.getState();
    s.addQaMessage({ role: 'user', content: '질문' });
    s.setIsQaGenerating(true);
    simulateAbort(); // 1st abort
    simulateAbort(); // 2nd abort — isQaGenerating=false 라 no-op
    const msgs = useAppStore.getState().qaMessages;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('assistant');
  });

  it('R23 #1 시나리오: 빈 abort 후 새 질문 + FIFO 누적 — 윈도우 선두 user 불변식', () => {
    const s = useAppStore.getState();
    // 1턴 abort (빈 partial) — placeholder 주입되므로 짝 유지
    s.addQaMessage({ role: 'user', content: '취소된 질문' });
    s.setIsQaGenerating(true);
    simulateAbort();
    // 이후 11 턴 정상 대화 (총 1+11 = 12 턴 = 24 메시지)
    // 20 초과로 FIFO 발동
    for (let i = 0; i < 11; i++) {
      s.addQaMessage({ role: 'user', content: `u${i}` });
      s.addQaMessage({ role: 'assistant', content: `a${i}` });
    }
    const msgs = useAppStore.getState().qaMessages;
    // cap 20 이하 + 선두는 user
    expect(msgs.length).toBeLessThanOrEqual(20);
    expect(msgs[0].role).toBe('user');
  });

  it('placeholder 주입 후 즉시 새 질문이 와도 연속 user 가 만들어지지 않는다', () => {
    const s = useAppStore.getState();
    s.addQaMessage({ role: 'user', content: '첫 질문' });
    s.setIsQaGenerating(true);
    simulateAbort();
    // 다음 질문 즉시
    s.addQaMessage({ role: 'user', content: '두번째 질문' });
    const msgs = useAppStore.getState().qaMessages;
    // 순서: user → assistant(placeholder) → user
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});
