import { describe, it, expect, vi, beforeEach } from 'vitest';

// v0.18.0 Q&A 답변 검증(Hallucination 감지 + silent refine) 단위 테스트.
// verifyAnswerSentences 는 window.electronAPI.ai.embed 와 useAppStore(zustand) 에 의존하므로
// 두 의존성을 모듈 import 이전에 stub 한다.

const mockEmbed = vi.fn();
const mockAbort = vi.fn(() => Promise.resolve());
vi.stubGlobal('window', {
  electronAPI: {
    ai: {
      embed: mockEmbed,
      abort: mockAbort,
    },
  },
});
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { splitIntoSentences, buildRefinePrompt, verifyAnswerSentences } from '../use-qa';
import { useAppStore } from '../store';

function resetRag(): void {
  // ragIndex 는 VectorStore 인스턴스로 persist 되므로 clear 만으로 충분.
  useAppStore.getState().ragIndex.clear();
}

describe('splitIntoSentences (v0.18)', () => {
  it('한국어/영어 종결 구두점으로 분할한다 (15자 이상)', () => {
    // 각 문장이 VERIFY_MIN_SENTENCE_CHARS(15) 이상이도록 구성.
    const input = '첫 번째 문장이 여기에 있습니다. 두 번째 문장이 여기에 있습니다. The third sentence is here.';
    const out = splitIntoSentences(input);
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(out[0]).toContain('첫 번째');
    expect(out[out.length - 1]).toContain('third');
  });

  it('VERIFY_MIN_SENTENCE_CHARS(15) 미만 문장은 필터링된다', () => {
    // 두 번째 "짧음." 은 5자라 제외되어야 한다.
    const out = splitIntoSentences('이것은 충분히 긴 첫 번째 문장이다. 짧음.');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('충분히 긴');
  });

  it('빈 문자열은 빈 배열', () => {
    expect(splitIntoSentences('')).toEqual([]);
  });

  it('연속 공백/개행을 단일 공백으로 정규화 후 분할한다', () => {
    const input = '문장은   여러\n\n줄에   걸쳐 있을 수 있습니다.';
    const out = splitIntoSentences(input);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toMatch(/\n/);
    expect(out[0]).not.toMatch(/  /);
  });
});

describe('buildRefinePrompt (v0.18)', () => {
  it('question / draft / context 를 모두 포함한다', () => {
    const out = buildRefinePrompt('질문 본문', '초안 답변 본문', '[원문]컨텍스트 본문');
    expect(out).toContain('질문 본문');
    expect(out).toContain('초안 답변 본문');
    expect(out).toContain('컨텍스트 본문');
  });

  it('refine 지시 규칙을 포함한다 (근거 없는 주장 제거 등)', () => {
    const out = buildRefinePrompt('q', 'd', 'c');
    expect(out).toMatch(/근거/);
    expect(out).toMatch(/제거|확인되지 않음/);
    expect(out).toMatch(/\[p\.N\]|인용/);
  });
});

describe('verifyAnswerSentences (v0.18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRag();
  });

  it('RAG 인덱스가 비어있으면 fail-safe 로 needsRefine=false 반환', async () => {
    const result = await verifyAnswerSentences('아무 답변이나 여기에 있습니다. 두 번째 문장입니다.');
    expect(result.needsRefine).toBe(false);
    expect(result.totalSentences).toBe(0);
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('임베딩 IPC 실패 시 fail-safe 로 needsRefine=false 반환', async () => {
    // ragIndex 에 한 개 chunk 넣어 size>0 보장
    const ragIndex = useAppStore.getState().ragIndex;
    ragIndex.addChunk('reference chunk', [1, 0, 0], 0);

    mockEmbed.mockResolvedValueOnce({ success: false, error: 'fail' });

    const result = await verifyAnswerSentences('검증 대상 문장이 충분히 깁니다. 두 번째 문장입니다.');
    expect(result.needsRefine).toBe(false);
    expect(result.totalSentences).toBeGreaterThan(0);
  });

  it('모든 문장 cosine 이 WEAK_SCORE(0.5) 미만이면 needsRefine=true + weakCount>=1', async () => {
    const ragIndex = useAppStore.getState().ragIndex;
    // 축이 완전히 다른 방향의 ref 청크 → 쿼리 embedding [1,0,0] 과 cosine=0
    ragIndex.addChunk('orthogonal ref', [0, 1, 0], 0);

    mockEmbed.mockResolvedValueOnce({
      success: true,
      embeddings: [[1, 0, 0], [1, 0, 0]],
      model: 'test',
    });

    const result = await verifyAnswerSentences(
      '근거 없는 첫 주장이 여기 있다. 또 다른 환각 문장이 여기 있다.',
    );
    expect(result.totalSentences).toBe(2);
    expect(result.weakCount).toBeGreaterThanOrEqual(1);
    expect(result.needsRefine).toBe(true);
    expect(result.avgScore).toBeLessThan(0.5);
  });

  it('모든 문장 cosine≈1 이면 needsRefine=false, avgScore>=AVG_SCORE(0.65)', async () => {
    const ragIndex = useAppStore.getState().ragIndex;
    ragIndex.addChunk('perfect ref', [1, 0, 0], 0);

    mockEmbed.mockResolvedValueOnce({
      success: true,
      embeddings: [[1, 0, 0], [1, 0, 0]],
      model: 'test',
    });

    const result = await verifyAnswerSentences(
      '문서에 근거가 확실히 있는 첫 문장. 역시 근거가 있는 두번째 문장.',
    );
    expect(result.totalSentences).toBe(2);
    expect(result.weakCount).toBe(0);
    expect(result.needsRefine).toBe(false);
    expect(result.avgScore).toBeGreaterThanOrEqual(0.65);
  });

  it('사전 abort 된 signal 을 받으면 embed 호출이 실패 경로로 즉시 귀결된다', async () => {
    const ragIndex = useAppStore.getState().ragIndex;
    ragIndex.addChunk('ref', [1, 0, 0], 0);

    const controller = new AbortController();
    controller.abort();

    // embed Promise 는 resolve 되지 않을 수 있지만, embedWithTimeout 는 onAbort 로 즉시 resolve 한다.
    mockEmbed.mockImplementation(() => new Promise(() => { /* never */ }));

    const result = await verifyAnswerSentences(
      '검증 대상 문장이 충분히 깁니다. 또 다른 문장이 있습니다.',
      controller.signal,
    );
    // fail-safe: 검증 자체는 실패 → needsRefine=false
    expect(result.needsRefine).toBe(false);
    // abort 시 ai.abort IPC 가 호출되어 main 소켓이 파괴됨을 확인
    expect(mockAbort).toHaveBeenCalled();
  });
});
