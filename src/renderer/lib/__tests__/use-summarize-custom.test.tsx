// @vitest-environment happy-dom

// QA11 A축(테스트갭): 커스텀 요약 템플릿의 **실행 오케스트레이션** 회귀 안전망.
//
// v0.31.21~22 가 도입한 summarizeCustom / summarizeCustomChunked 는 buildPrompt(main),
// IPC 검증, 셀렉터 필터, 설정 CRUD 에만 테스트가 있었고, 런타임 동작 — 전략 분기, 단일패스
// 절단 고지, 청크+통합 파이프라인, 삭제된 템플릿(고아 선택자) 조기 종료 — 은 실 Ollama 수동
// 검증에만 의존했다. AiClient 만 목 격리(기존 use-summarize-hook.test 와 동일 철학)하고
// customPrompt(4번째 인자)를 캡처해 프롬프트 관통을 검증한다.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const M = vi.hoisted(() => ({
  available: true,
  tokens: ['결', '과'] as string[],
  calls: [] as { text: string; type: string; customPrompt?: string }[],
}));

vi.mock('../ai-client', () => ({
  AiClient: class {
    constructor(_settings: unknown) { /* noop */ }
    async isAvailable() { return M.available; }
    prepareSummarize() { return 'req-1'; }
    async *summarize(text: string, type: string, _requestId?: string, customPrompt?: string): AsyncGenerator<string> {
      M.calls.push({ text, type, customPrompt });
      for (const tk of M.tokens) yield tk;
    }
    async analyzeImage(): Promise<string | null> { return null; }
  },
}));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: { ai: { abort: vi.fn(() => Promise.resolve()), analyzeImage: vi.fn() } },
}));
vi.stubGlobal('crypto', { randomUUID: () => 'uuid-fixed' });

import { useSummarize } from '../use-summarize';
import { useAppStore } from '../store';
import { DEFAULT_SETTINGS } from '../../types';
import type { PdfDocument, SummaryTemplate } from '../../types';

const TPL: SummaryTemplate = { id: 't1', name: '액션아이템', prompt: '실행 항목만 뽑아줘' };

function makeDoc(over: Partial<PdfDocument> = {}): PdfDocument {
  return {
    id: 'doc-1', fileName: 'a.pdf', filePath: '/d/a.pdf', pageCount: 1,
    extractedText: '본문 텍스트입니다.', pageTexts: ['본문 텍스트입니다.'],
    chapters: [], images: [], createdAt: new Date('2026-07-10T00:00:00Z'),
    ...over,
  };
}

/** templates + summaryType 을 커스텀으로 세팅. */
function useTemplate(tpl: SummaryTemplate, doc = makeDoc()) {
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: false, customSummaryTemplates: [tpl] },
    document: doc,
    summaryType: `custom:${tpl.id}`,
  });
}

async function runSummarize() {
  const { result } = renderHook(() => useSummarize());
  await act(async () => { await result.current.handleSummarize(); });
  return result;
}

beforeEach(() => {
  M.available = true;
  M.tokens = ['결', '과'];
  M.calls = [];
  useAppStore.setState({
    settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: false },
    document: makeDoc(), summaryType: 'full', isGenerating: false, isQaGenerating: false,
    summaryStream: '', summary: null, error: null, enrichedPageTexts: null,
    currentRequestId: null, notice: null,
  });
});
afterEach(() => {
  useAppStore.setState({ isGenerating: false });
});

describe('커스텀 템플릿 — 전략 분기', () => {
  it('전략 미지정 → 단일 패스 1회 호출, type=custom + 사용자 프롬프트 관통', async () => {
    useTemplate(TPL);
    await runSummarize();

    expect(M.calls).toHaveLength(1);
    expect(M.calls[0]!.type).toBe('custom');
    expect(M.calls[0]!.customPrompt).toBe('실행 항목만 뽑아줘');
    expect(useAppStore.getState().summaryStream).toBe('결과');
  });

  it("전략 'single' 명시 → 단일 패스 (chunked 아님)", async () => {
    useTemplate({ ...TPL, strategy: 'single' });
    await runSummarize();
    expect(M.calls).toHaveLength(1);
  });

  it('단일 패스는 페이지 라벨([p.N])이 붙은 텍스트를 보낸다 (인용 유지)', async () => {
    useTemplate(TPL, makeDoc({ pageTexts: ['첫 페이지 내용', '둘째 페이지 내용'], pageCount: 2 }));
    await runSummarize();
    expect(M.calls[0]!.text).toContain('[p.1]');
    expect(M.calls[0]!.text).toContain('[p.2]');
  });
});

describe('커스텀 템플릿 — 단일 패스 절단 고지', () => {
  it('예산(16000자) 초과 → 앞부분 절단 + 절단 고지 notice', async () => {
    const long = '가'.repeat(20000);
    useTemplate(TPL, makeDoc({ pageTexts: [long], extractedText: long }));
    await runSummarize();

    expect(M.calls).toHaveLength(1);
    const sent = M.calls[0]!.text;
    expect(sent.endsWith('\n\n[...]')).toBe(true);
    expect(sent.length).toBe(16000 + '\n\n[...]'.length);
    expect(useAppStore.getState().notice?.message).toContain('앞부분만');
  });

  it('예산 이내 → 절단하지 않고 고지도 없음', async () => {
    useTemplate(TPL, makeDoc({ pageTexts: ['짧은 본문'], extractedText: '짧은 본문' }));
    await runSummarize();
    expect(M.calls[0]!.text).not.toContain('[...]');
    expect(useAppStore.getState().notice).toBeNull();
  });
});

describe('커스텀 템플릿 — 청크+통합 전략', () => {
  it('다중 청크 → 청크별 호출 + 통합 호출, 모든 호출에 동일 프롬프트 관통', async () => {
    const tpl = { ...TPL, strategy: 'chunked' as const };
    // maxChunkSize 는 **토큰** 단위이고 chunkText 가 maxChars = max(100, size * charsPerToken)
    // 로 환산한다(한국어 ≈1.5자/토큰). 100토큰 → 150자 상한, 본문 4문단×200자 → 다중 청크.
    const body = Array.from({ length: 4 }, (_, i) => `${i}번 문단 ` + '내용입니다. '.repeat(30)).join('\n\n');
    useAppStore.setState({
      settings: {
        ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: false,
        customSummaryTemplates: [tpl], maxChunkSize: 100,
      },
      document: makeDoc({ pageTexts: [body], extractedText: body }),
      summaryType: `custom:${tpl.id}`,
    });

    await runSummarize();

    // 청크 N개(≥2) + 통합 1회 — 통합은 청크가 2개 이상일 때만 발화
    expect(M.calls.length).toBeGreaterThanOrEqual(3);
    expect(M.calls.every((c) => c.type === 'custom')).toBe(true);
    expect(M.calls.every((c) => c.customPrompt === '실행 항목만 뽑아줘')).toBe(true);
  });

  it('단일 청크 → 통합 단계 생략 (1회 호출)', async () => {
    const tpl = { ...TPL, strategy: 'chunked' as const };
    useTemplate(tpl, makeDoc({ pageTexts: ['짧다'], extractedText: '짧다' }));
    await runSummarize();
    expect(M.calls).toHaveLength(1);
  });
});

describe('커스텀 템플릿 — 고아 선택자 / 빈 문서', () => {
  it('선택된 템플릿이 삭제됨 → 안내 후 조기 종료 (AI 호출 0, 토큰 소각 없음)', async () => {
    useAppStore.setState({
      settings: { ...DEFAULT_SETTINGS, provider: 'ollama', enableImageAnalysis: false, customSummaryTemplates: [] },
      document: makeDoc(),
      summaryType: 'custom:deleted-id',
    });

    await runSummarize();

    expect(M.calls).toHaveLength(0);
    expect(useAppStore.getState().notice?.message).toContain('찾을 수 없습니다');
    expect(useAppStore.getState().isGenerating).toBe(false);
  });

  it('본문이 공백뿐 → PDF_NO_TEXT 에러, AI 호출 0', async () => {
    useTemplate(TPL, makeDoc({ pageTexts: ['   '], extractedText: '   ' }));
    await runSummarize();

    expect(M.calls).toHaveLength(0);
    expect(useAppStore.getState().error?.code).toBe('PDF_NO_TEXT');
    expect(useAppStore.getState().isGenerating).toBe(false);
  });
});
