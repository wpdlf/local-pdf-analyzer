// @vitest-environment happy-dom

// useSummarize 오케스트레이션 행위 — handleSummarize 의 가드/가용성/전체·챕터·다청크 통합 경로,
// PDF_NO_TEXT, 후처리(strip+citation), 이미지 분석(preflight 성공/실패), handleAbort.
// 순수 헬퍼(labelParagraphsWithPages/stripConversationalText)는 use-summarize(.strip).test 가 별도 커버.
// AiClient 만 목 격리 — chunker/citation/enrich-doc 는 실제 모듈 사용.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const M = vi.hoisted(() => ({
  available: true,
  tokens: ['핵심 ', '요약'] as string[],
  summarizeCalls: [] as { text: string; type: string }[],
  imageResult: 'IMG_DESC' as string | null,
  imageCalls: 0,
  reqCounter: 0,
}));

vi.mock('../ai-client', () => ({
  AiClient: class {
    constructor(_settings: unknown) { /* noop */ }
    async isAvailable() { return M.available; }
    prepareSummarize() { return `req-${++M.reqCounter}`; }
    async *summarize(text: string, type: string): AsyncGenerator<string> {
      M.summarizeCalls.push({ text, type });
      for (const tk of M.tokens) yield tk;
    }
    async analyzeImage(_b: string, _r?: string): Promise<string | null> {
      M.imageCalls++;
      return M.imageResult;
    }
  },
}));

const abortMock = vi.fn(() => Promise.resolve());
vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { abort: abortMock, analyzeImage: vi.fn() } },
}));
vi.stubGlobal('crypto', { randomUUID: () => `uuid-${Math.random()}` });

import { useSummarize } from '../use-summarize';
import { useAppStore } from '../store';
import { DEFAULT_SETTINGS } from '../../types';
import type { PdfDocument, PageImage } from '../../types';

function makeDoc(over: Partial<PdfDocument> = {}): PdfDocument {
  return {
    id: 'doc-1', fileName: 'a.pdf', filePath: '/d/a.pdf', pageCount: 1,
    extractedText: '본문 텍스트입니다.', pageTexts: ['본문 텍스트입니다.'],
    chapters: [], images: [], createdAt: new Date('2026-06-17T00:00:00Z'),
    ...over,
  };
}

function img(pageIndex: number): PageImage {
  return { pageIndex, imageIndex: 0, base64: 'AAAA', width: 10, height: 10, mimeType: 'image/png' };
}

beforeEach(() => {
  M.available = true;
  M.tokens = ['핵심 ', '요약'];
  M.summarizeCalls = [];
  M.imageResult = 'IMG_DESC';
  M.imageCalls = 0;
  M.reqCounter = 0;
  abortMock.mockClear();
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: false },
    document: makeDoc(),
    summaryType: 'full',
    isGenerating: false,
    isQaGenerating: false,
    summaryStream: '',
    summary: null,
    error: null,
    enrichedPageTexts: null,
    currentRequestId: null,
  });
});
afterEach(() => {
  useAppStore.setState({ isGenerating: false });
});

async function runSummarize() {
  const { result } = renderHook(() => useSummarize());
  await act(async () => { await result.current.handleSummarize(); });
  return result;
}

describe('useSummarize — 가드', () => {
  it('문서 없으면 아무 것도 하지 않는다', async () => {
    useAppStore.setState({ document: null });
    await runSummarize();
    expect(M.summarizeCalls).toHaveLength(0);
    expect(useAppStore.getState().isGenerating).toBe(false);
  });

  it('이미 생성 중이면 재진입하지 않는다', async () => {
    useAppStore.setState({ isGenerating: true });
    await runSummarize();
    expect(M.summarizeCalls).toHaveLength(0);
  });
});

describe('useSummarize — 가용성', () => {
  it('Ollama 미가용 → OLLAMA_NOT_RUNNING + 생성 종료', async () => {
    M.available = false;
    await runSummarize();
    expect(useAppStore.getState().error?.code).toBe('OLLAMA_NOT_RUNNING');
    expect(M.summarizeCalls).toHaveLength(0);
    expect(useAppStore.getState().isGenerating).toBe(false);
  });

  it('Claude 미가용(키 없음) → API_KEY_MISSING', async () => {
    M.available = false;
    useAppStore.setState({ settings: { ...DEFAULT_SETTINGS, provider: 'claude' } });
    await runSummarize();
    expect(useAppStore.getState().error?.code).toBe('API_KEY_MISSING');
  });
});

describe('useSummarize — 전체 요약', () => {
  it('단일 청크 happy path → 스트림 누적 + setSummary + progress 100', async () => {
    await runSummarize();
    const st = useAppStore.getState();
    expect(st.summaryStream).toContain('핵심 요약');
    expect(st.summary?.type).toBe('full');
    expect(st.summary?.content).toContain('핵심 요약');
    expect(st.summary?.documentId).toBe('doc-1');
    expect(st.progress).toBe(100);
    expect(st.isGenerating).toBe(false);
    expect(M.summarizeCalls.every((c) => c.type === 'full')).toBe(true);
  });

  it('유의미한 텍스트 없음 → PDF_NO_TEXT', async () => {
    useAppStore.setState({ document: makeDoc({ extractedText: '', pageTexts: [] }) });
    await runSummarize();
    expect(useAppStore.getState().error?.code).toBe('PDF_NO_TEXT');
  });

  it('다청크 → 통합 요약 단계 추가', async () => {
    const para = '문단 내용이 길게 이어집니다. '.repeat(40);
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', maxChunkSize: 50, summaryLanguage: 'ko' },
      document: makeDoc({ pageTexts: [`${para}\n\n${para}\n\n${para}`], extractedText: para }),
    });
    await runSummarize();
    expect(useAppStore.getState().summaryStream).toContain('통합 요약');
    // 청크 요약 + 통합(full) 호출 — 2회 이상
    expect(M.summarizeCalls.length).toBeGreaterThan(1);
  });

  it('후처리: 대화형 멘트 제거 + 인용 정규화 후 저장', async () => {
    M.tokens = ['핵심 내용입니다.\n', '도움이 되길 바랍니다'];
    await runSummarize();
    const content = useAppStore.getState().summary?.content ?? '';
    expect(content).toContain('핵심 내용입니다.');
    expect(content).not.toContain('도움이 되길'); // 대화형 줄 제거됨
  });
});

describe('useSummarize — 챕터 요약', () => {
  it('summaryType=chapter + 챕터 2개 이상 → 챕터별 헤더 출력', async () => {
    useAppStore.setState({
      summaryType: 'chapter',
      document: makeDoc({
        pageTexts: ['1쪽 내용', '2쪽 내용'],
        chapters: [
          { index: 0, title: '서론', startPage: 1, endPage: 1, text: '1쪽 내용' },
          { index: 1, title: '본론', startPage: 2, endPage: 2, text: '2쪽 내용' },
        ],
      }),
    });
    await runSummarize();
    const stream = useAppStore.getState().summaryStream;
    expect(stream).toContain('## 서론');
    expect(stream).toContain('## 본론');
    expect(M.summarizeCalls.every((c) => c.type === 'chapter')).toBe(true);
  });
});

describe('useSummarize — 이미지 분석', () => {
  it('이미지 + Vision ON → preflight analyzeImage 호출 + enrichedPageTexts 설정', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: makeDoc({ images: [img(0)] }),
    });
    await runSummarize();
    expect(M.imageCalls).toBeGreaterThanOrEqual(1);
    expect(useAppStore.getState().enrichedPageTexts).not.toBeNull();
    expect(useAppStore.getState().summary).not.toBeNull();
  });

  it('이미지 preflight 실패(null) → GENERATE_FAIL + 요약 미진행', async () => {
    M.imageResult = null;
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: true },
      document: makeDoc({ images: [img(0)] }),
    });
    await runSummarize();
    expect(useAppStore.getState().error?.code).toBe('GENERATE_FAIL');
    expect(M.summarizeCalls).toHaveLength(0);
  });
});

describe('useSummarize — handleAbort', () => {
  it('진행 중 abort → ai.abort(reqId) + 생성 종료', () => {
    const { result } = renderHook(() => useSummarize());
    useAppStore.setState({ currentRequestId: 'req-9', isGenerating: true });
    act(() => { result.current.handleAbort(); });
    expect(abortMock).toHaveBeenCalledWith('req-9');
    expect(useAppStore.getState().isGenerating).toBe(false);
    expect(useAppStore.getState().currentRequestId).toBeNull();
  });
});
