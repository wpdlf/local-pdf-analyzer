// @vitest-environment happy-dom

// QaChat 행위 — 빈 상태 안내(RAG 유무) / 메시지·스트림 렌더 / 입력 제출(handleAsk, 입력 초기화) /
// Enter 제출·Shift+Enter·IME 조합 가드 / 글자수 제한 / 생성 중 중지 버튼·입력 비활성 /
// RAG 인덱싱 중 전송 차단·안내. useQa 훅과 자식/마크다운은 목으로 격리.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type RagState = { isIndexing: boolean; progress: { current: number; total: number } | null; isAvailable: boolean; model: string | null; chunkCount: number };
type QaMsg = { id: string; role: 'user' | 'assistant'; content: string; degraded?: boolean };

const Q = vi.hoisted(() => ({
  handleAsk: vi.fn(),
  handleQaAbort: vi.fn(),
  state: {
    qaMessages: [] as QaMsg[],
    qaStream: '',
    isQaGenerating: false,
    qaVerifying: false,
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 } as RagState,
  },
}));
vi.mock('../../lib/use-qa', () => ({
  useQa: () => ({ handleAsk: Q.handleAsk, handleQaAbort: Q.handleQaAbort, ...Q.state }),
}));
vi.mock('../CollectionBar', () => ({ CollectionBar: () => <div data-testid="collectionbar" /> }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div data-testid="md">{children}</div> }));
vi.mock('../../lib/safe-markdown', () => ({
  REMARK_PLUGINS: [],
  safeComponents: {},
  MarkdownErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { QaChat } from '../QaChat';

beforeEach(() => {
  vi.clearAllMocks();
  // scrollIntoView 는 happy-dom 미구현일 수 있어 자동 스크롤 effect 보호
  Element.prototype.scrollIntoView = vi.fn();
  Q.state = {
    qaMessages: [], qaStream: '', isQaGenerating: false, qaVerifying: false,
    ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0 },
  };
});
afterEach(() => cleanup());

describe('QaChat', () => {
  it('빈 상태 + RAG 없음 → emptyHint', () => {
    render(<QaChat />);
    expect(screen.getByText(/궁금한 점을 질문/)).toBeTruthy();
  });

  it('빈 상태 + chunkCount>0 → ragActive 안내 + RAG 배지', () => {
    Q.state.ragState = { isIndexing: false, progress: null, isAvailable: true, model: 'nomic', chunkCount: 50 };
    render(<QaChat />);
    expect(screen.getByText(/RAG 시맨틱 검색이 활성화/)).toBeTruthy();
    expect(screen.getByText('RAG')).toBeTruthy();
  });

  it('메시지 렌더 — user 평문 / assistant 마크다운', () => {
    Q.state.qaMessages = [
      { id: 'm1', role: 'user', content: '질문입니다' },
      { id: 'm2', role: 'assistant', content: '**답변**' },
    ];
    render(<QaChat />);
    expect(screen.getByText('질문입니다')).toBeTruthy();
    expect(screen.getByTestId('md').textContent).toContain('**답변**');
  });

  it('입력 후 전송 버튼 → handleAsk(trimmed) + 입력 초기화', async () => {
    const user = userEvent.setup();
    render(<QaChat />);
    const input = screen.getByLabelText('질문 입력') as HTMLTextAreaElement;
    await user.type(input, '  안녕  ');
    await user.click(screen.getByRole('button', { name: '질문 전송' }));
    expect(Q.handleAsk).toHaveBeenCalledWith('안녕');
    expect(input.value).toBe('');
  });

  it('Enter 제출 / Shift+Enter 는 제출 안 함', async () => {
    render(<QaChat />);
    const input = screen.getByLabelText('질문 입력');
    fireEvent.change(input, { target: { value: '질문' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(Q.handleAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
    expect(Q.handleAsk).toHaveBeenCalledWith('질문');
  });

  it('IME 조합 중 Enter 는 제출하지 않는다', () => {
    render(<QaChat />);
    const input = screen.getByLabelText('질문 입력');
    fireEvent.change(input, { target: { value: '한글' } });
    // isComposing=true (nativeEvent)
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false, isComposing: true });
    expect(Q.handleAsk).not.toHaveBeenCalled();
  });

  it('글자수 초과 → 경고 표시 + 전송 비활성 + handleAsk 미호출', () => {
    render(<QaChat />);
    const input = screen.getByLabelText('질문 입력');
    fireEvent.change(input, { target: { value: 'a'.repeat(1001) } });
    expect(screen.getByText(/까지 입력 가능/)).toBeTruthy();
    const send = screen.getByRole('button', { name: '질문 전송' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(Q.handleAsk).not.toHaveBeenCalled();
  });

  it('생성 중 → 중지 버튼(handleQaAbort) + 입력 비활성', async () => {
    Q.state.isQaGenerating = true;
    const user = userEvent.setup();
    render(<QaChat />);
    const input = screen.getByLabelText('질문 입력') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '답변 중지' }));
    expect(Q.handleQaAbort).toHaveBeenCalledTimes(1);
  });

  it('생성 중 + 검증 단계 → verifying 라벨', () => {
    // 검증 인디케이터는 대화 로그 블록 내부 — 메시지가 있어야 블록이 렌더되고,
    // qaStream 이 비어 있을 때만 표시(isQaGenerating && !qaStream).
    Q.state.qaMessages = [{ id: 'm1', role: 'user', content: '질문' }];
    Q.state.isQaGenerating = true;
    Q.state.qaVerifying = true;
    Q.state.qaStream = '';
    render(<QaChat />);
    expect(screen.getByText(/근거 확인/)).toBeTruthy();
  });

  it('RAG 인덱싱 중 → 전송 차단 + 안내 + 입력 비활성', () => {
    Q.state.ragState = { isIndexing: true, progress: { current: 2, total: 10 }, isAvailable: false, model: null, chunkCount: 0 };
    render(<QaChat />);
    const input = screen.getByLabelText('질문 입력') as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText(/RAG 인덱싱 중입니다/)).toBeTruthy();
    // 헤더 인덱싱 진행 카운트(2/10)는 헤더에만 존재 — 안내문과 구분
    expect(screen.getByText(/2\/10/)).toBeTruthy();
  });

  it('전송 버튼은 입력이 비어 있으면 비활성', () => {
    render(<QaChat />);
    const send = screen.getByRole('button', { name: '질문 전송' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it('M3: degraded 답변엔 강등 인라인 안내, 일반 답변엔 없음', () => {
    Q.state.qaMessages = [
      { id: 'm1', role: 'assistant', content: '일반 답변' },
      { id: 'm2', role: 'assistant', content: '강등 답변', degraded: true },
    ];
    render(<QaChat />);
    // 강등 안내는 1개만(degraded 메시지에만)
    const notes = screen.getAllByText(/교차 검색이 제한되어/);
    expect(notes).toHaveLength(1);
  });

  it('M4: 어시스턴트 답변에만 복사 버튼 → clipboard.writeText(답변 내용)', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    Q.state.qaMessages = [
      { id: 'm1', role: 'user', content: '질문' },
      { id: 'm2', role: 'assistant', content: '답변 본문' },
    ];
    render(<QaChat />);
    // user 메시지엔 복사 버튼 없음 — assistant 1개만
    const copyBtns = screen.getAllByRole('button', { name: '답변 복사' });
    expect(copyBtns).toHaveLength(1);
    fireEvent.click(copyBtns[0]!);
    expect(writeText).toHaveBeenCalledWith('답변 본문');
  });
});
