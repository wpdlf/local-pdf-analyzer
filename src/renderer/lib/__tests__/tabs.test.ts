// @vitest-environment happy-dom

// multi-doc Phase 1: 탭 오케스트레이션(lib/tabs.ts) 행위 가드.
// 핵심 계약 — ① 전환은 flush → 재오픈 → handlePdfData 순서, ② 활성 탭이면 no-op,
// ③ 재오픈 실패는 에러 배너 + 탭 유지, ④ 활성 탭 닫기는 오른쪽 이웃 우선 전환,
// ⑤ 마지막 탭 닫기는 업로드 화면 정리, ⑥ 생성/파싱 중 전환·활성 닫기 차단.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const M = vi.hoisted(() => ({
  handlePdfData: vi.fn(() => Promise.resolve()),
  persistCurrentSession: vi.fn(() => Promise.resolve()),
  restoreSessionForDocument: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(),
  sessionLoad: vi.fn(),
}));

vi.mock('../pdf-parser', () => ({ handlePdfData: M.handlePdfData }));
vi.mock('../use-session', () => ({
  persistCurrentSession: M.persistCurrentSession,
  restoreSessionForDocument: M.restoreSessionForDocument,
}));

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
    file: { openPath: M.openPath },
    session: { load: M.sessionLoad },
  },
}));

import { switchToTab, closeTab, openNewTabView, openCollection } from '../tabs';
import { useAppStore } from '../store';
import type { PdfDocument } from '../../types';

function makeDoc(filePath: string, fileName = 'a.pdf'): PdfDocument {
  return {
    id: `id-${filePath}`,
    fileName,
    filePath,
    pageCount: 1,
    extractedText: 'x'.repeat(60),
    pageTexts: ['x'.repeat(60)],
    chapters: [],
    images: [],
    createdAt: new Date(),
  };
}

function seedTabs(paths: string[], activePath: string | null): void {
  useAppStore.setState({
    openTabs: paths.map((p) => ({ filePath: p, fileName: p.split('/').pop() ?? p, pageCount: 1 })),
    document: activePath ? makeDoc(activePath, activePath.split('/').pop()) : null,
    isGenerating: false,
    isQaGenerating: false,
    isParsing: false,
    error: null,
  });
}

beforeEach(() => {
  M.openPath.mockResolvedValue({ path: '/docs/b.pdf', name: 'b.pdf', data: new ArrayBuffer(8) });
  M.sessionLoad.mockResolvedValue(null);
  seedTabs([], null);
});

describe('store.upsertOpenTab / removeOpenTab', () => {
  it('filePath 중복은 메타만 갱신 — 중복 탭 없음 + 순서 유지', () => {
    const s = useAppStore.getState();
    s.upsertOpenTab({ filePath: '/a.pdf', fileName: 'a.pdf', pageCount: 1 });
    s.upsertOpenTab({ filePath: '/b.pdf', fileName: 'b.pdf', pageCount: 2 });
    s.upsertOpenTab({ filePath: '/a.pdf', fileName: 'a.pdf', pageCount: 9 });
    const tabs = useAppStore.getState().openTabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toEqual({ filePath: '/a.pdf', fileName: 'a.pdf', pageCount: 9 });
    expect(tabs[1]?.filePath).toBe('/b.pdf');
  });
});

describe('switchToTab', () => {
  it('flush → openPath → handlePdfData 순서로 전환', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
    const order: string[] = [];
    M.persistCurrentSession.mockImplementation(async () => { order.push('persist'); });
    M.openPath.mockImplementation(async () => { order.push('open'); return { path: '/docs/b.pdf', name: 'b.pdf', data: new ArrayBuffer(8) }; });
    M.handlePdfData.mockImplementation(async () => { order.push('parse'); });

    await switchToTab('/docs/b.pdf');
    expect(order).toEqual(['persist', 'open', 'parse']);
    expect(M.openPath).toHaveBeenCalledWith('/docs/b.pdf');
  });

  it('이미 활성 탭이면 no-op', async () => {
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    await switchToTab('/docs/a.pdf');
    expect(M.persistCurrentSession).not.toHaveBeenCalled();
    expect(M.openPath).not.toHaveBeenCalled();
  });

  it('재오픈 실패 + docHash 없음 → 에러 배너 + 탭 유지 + 파싱 미진행', async () => {
    seedTabs(['/docs/a.pdf', '/docs/gone.pdf'], '/docs/a.pdf');
    M.openPath.mockResolvedValue({ error: 'not found' });
    await switchToTab('/docs/gone.pdf');
    expect(M.handlePdfData).not.toHaveBeenCalled();
    expect(useAppStore.getState().error?.code).toBe('PDF_PARSE_FAIL');
    expect(useAppStore.getState().openTabs).toHaveLength(2); // 탭 유지 — 파일 복구 후 재시도 가능
  });

  it('재오픈 실패 + docHash 있음 → 영속 세션에서 직접 복원 (뷰어만 비활성, 에러 없음)', async () => {
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    useAppStore.setState((s) => ({
      openTabs: [...s.openTabs, { filePath: 'name-only.pdf', fileName: 'name-only.pdf', pageCount: 2, docHash: 'h'.repeat(64) }],
    }));
    M.openPath.mockResolvedValue({ error: 'not found' });
    M.sessionLoad.mockResolvedValue({
      session: {
        schemaVersion: 1,
        docHash: 'h'.repeat(64),
        fileName: 'name-only.pdf',
        filePath: 'name-only.pdf',
        pageCount: 2,
        extractedText: '복원된 본문 '.repeat(10),
        pageTexts: ['p1', 'p2'],
        chapters: [],
        summaries: {},
        qaMessages: [],
        embedModel: null,
        embedDim: null,
        chunkMeta: [],
      },
      blob: null,
    });

    await switchToTab('name-only.pdf');

    expect(M.handlePdfData).not.toHaveBeenCalled(); // 파일 경로 아닌 세션 복원 경로
    expect(M.sessionLoad).toHaveBeenCalledWith('h'.repeat(64));
    const st = useAppStore.getState();
    expect(st.document?.fileName).toBe('name-only.pdf'); // 전환 성공
    expect(st.error).toBeNull(); // 에러 배너 없음
    expect(M.restoreSessionForDocument).toHaveBeenCalledTimes(1); // 요약/Q&A/인덱스 복원 위임
  });

  it('docHash + 파일 읽기 가능 → 세션 우선 복원 (재파싱 0, 뷰어 바이트 주입)', async () => {
    // ★ 사용자 버그 핵심 계약: 탭에 docHash 가 있으면 파일이 읽혀도 handlePdfData(재파싱)
    // 를 호출하지 않고 세션에서 즉시 복원한다. 재파싱은 대용량/이미지 PDF 에서 수십 초가
    // 걸려 "전환이 안 되는" 것처럼 보이던 원인. 뷰어용 바이트는 파싱 없이 파일만 읽어 주입.
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    useAppStore.setState((s) => ({
      openTabs: [...s.openTabs, { filePath: '/docs/big.pdf', fileName: 'big.pdf', pageCount: 49, docHash: 'd'.repeat(64) }],
    }));
    M.openPath.mockResolvedValue({ path: '/docs/big.pdf', name: 'big.pdf', data: new ArrayBuffer(16) }); // 파일 읽기 성공
    M.sessionLoad.mockResolvedValue({
      session: {
        schemaVersion: 1, docHash: 'd'.repeat(64), fileName: 'big.pdf', filePath: '/docs/big.pdf',
        pageCount: 49, extractedText: '대용량 본문 '.repeat(20), pageTexts: ['p1', 'p2'],
        chapters: [], summaries: {}, qaMessages: [], embedModel: null, embedDim: null, chunkMeta: [],
      },
      blob: null,
    });

    await switchToTab('/docs/big.pdf');

    expect(M.handlePdfData).not.toHaveBeenCalled(); // ★ 재파싱 안 함
    expect(M.sessionLoad).toHaveBeenCalledWith('d'.repeat(64));
    const st = useAppStore.getState();
    expect(st.document?.fileName).toBe('big.pdf'); // 전환 성공
    expect(st.document?.pageCount).toBe(49);
    expect(st.pdfBytes).not.toBeNull(); // 뷰어용 바이트 주입(파일 읽기 성공)
    expect(st.error).toBeNull();
    expect(M.restoreSessionForDocument).toHaveBeenCalledTimes(1);
  });

  it('생성 중 전환 차단', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
    useAppStore.setState({ isGenerating: true });
    await switchToTab('/docs/b.pdf');
    expect(M.openPath).not.toHaveBeenCalled();
    useAppStore.setState({ isGenerating: false });
  });
});

describe('closeTab', () => {
  it('비활성 탭 닫기 — 목록 제거만, persist/재오픈 없음 (생성 중에도 안전)', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
    useAppStore.setState({ isGenerating: true }); // 생성 중에도 비활성 닫기는 허용
    await closeTab('/docs/b.pdf');
    expect(useAppStore.getState().openTabs.map((tb) => tb.filePath)).toEqual(['/docs/a.pdf']);
    expect(M.persistCurrentSession).not.toHaveBeenCalled();
    expect(M.openPath).not.toHaveBeenCalled();
    useAppStore.setState({ isGenerating: false });
  });

  it('활성 탭 닫기 — flush 후 오른쪽 이웃으로 전환', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf', '/docs/c.pdf'], '/docs/b.pdf');
    M.openPath.mockResolvedValue({ path: '/docs/c.pdf', name: 'c.pdf', data: new ArrayBuffer(8) });
    await closeTab('/docs/b.pdf');
    expect(M.persistCurrentSession).toHaveBeenCalledTimes(1);
    expect(M.openPath).toHaveBeenCalledWith('/docs/c.pdf'); // 오른쪽 우선
    expect(M.handlePdfData).toHaveBeenCalledTimes(1);
  });

  it('맨 오른쪽 활성 탭 닫기 — 왼쪽 이웃으로', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/b.pdf');
    M.openPath.mockResolvedValue({ path: '/docs/a.pdf', name: 'a.pdf', data: new ArrayBuffer(8) });
    await closeTab('/docs/b.pdf');
    expect(M.openPath).toHaveBeenCalledWith('/docs/a.pdf');
  });

  it('마지막 탭 닫기 — 업로드 화면 정리 (document null)', async () => {
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    await closeTab('/docs/a.pdf');
    expect(useAppStore.getState().openTabs).toHaveLength(0);
    expect(useAppStore.getState().document).toBeNull();
    expect(M.openPath).not.toHaveBeenCalled();
  });

  it('활성 탭 닫기는 생성 중 차단 (탭 목록도 불변)', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
    useAppStore.setState({ isQaGenerating: true });
    await closeTab('/docs/a.pdf');
    expect(useAppStore.getState().openTabs).toHaveLength(2);
    useAppStore.setState({ isQaGenerating: false });
  });
});

describe('openNewTabView', () => {
  it('flush 후 업로드 화면 — 탭 목록은 유지', async () => {
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    await openNewTabView();
    expect(M.persistCurrentSession).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().document).toBeNull();
    expect(useAppStore.getState().openTabs).toHaveLength(1);
  });

  it('이미 업로드 화면이면 no-op', async () => {
    seedTabs(['/docs/a.pdf'], null);
    await openNewTabView();
    expect(M.persistCurrentSession).not.toHaveBeenCalled();
  });
});

describe('openCollection (multi-doc Phase 3)', () => {
  function sessionFor(docHash: string) {
    return {
      session: {
        schemaVersion: 1, docHash, fileName: `${docHash}.pdf`, filePath: `/d/${docHash}.pdf`,
        pageCount: 3, extractedText: 'x'.repeat(60), pageTexts: ['x'.repeat(60)], chapters: [],
        summaries: {}, summaryType: 'full', qaMessages: [], embedModel: null, embedDim: null, chunkMeta: [],
      },
      blob: null,
    };
  }

  it('멤버 docHash 들을 탭으로 복원하고 첫 멤버를 활성으로', async () => {
    seedTabs([], null);
    M.sessionLoad.mockImplementation((h: string) => Promise.resolve(sessionFor(h)));
    M.openPath.mockResolvedValue({ error: 'no-file' }); // 뷰어 바이트 없음(분석만 복원)
    const r = await openCollection(['h1', 'h2']);
    expect(r).toEqual({ opened: 2, total: 2 });
    const st = useAppStore.getState();
    expect(st.openTabs.map((tb) => tb.docHash)).toEqual(['h1', 'h2']);
    expect(st.document?.fileName).toBe('h1.pdf'); // 첫 멤버 활성
    expect(M.restoreSessionForDocument).toHaveBeenCalledTimes(1);
  });

  it('세션 없는 멤버는 건너뜀(부분 복원)', async () => {
    seedTabs([], null);
    M.sessionLoad.mockImplementation((h: string) =>
      Promise.resolve(h === 'gone' ? null : sessionFor(h)));
    M.openPath.mockResolvedValue({ error: 'no-file' });
    const r = await openCollection(['h1', 'gone', 'h3']);
    expect(r).toEqual({ opened: 2, total: 3 });
    expect(useAppStore.getState().openTabs.map((tb) => tb.docHash)).toEqual(['h1', 'h3']);
  });

  it('전원 세션 없음 → opened 0', async () => {
    seedTabs([], null);
    M.sessionLoad.mockResolvedValue(null);
    const r = await openCollection(['x', 'y']);
    expect(r).toEqual({ opened: 0, total: 2 });
    expect(useAppStore.getState().openTabs).toHaveLength(0);
  });

  it('R48: 중복 docHash 는 한 번만 열고 total 도 고유 기준', async () => {
    seedTabs([], null);
    M.sessionLoad.mockImplementation((h: string) => Promise.resolve(sessionFor(h)));
    M.openPath.mockResolvedValue({ error: 'no-file' });
    const r = await openCollection(['h1', 'h1', 'h2']);
    expect(r).toEqual({ opened: 2, total: 2 }); // 고유 2개(중복 과다집계 없음)
    expect(useAppStore.getState().openTabs.map((tb) => tb.docHash)).toEqual(['h1', 'h2']);
  });

  it('R48: 교체 시맨틱 — 기존 탭/컬렉션 상태를 비우고 멤버로 대체(additive 아님)', async () => {
    useAppStore.setState({
      openTabs: [{ filePath: '/old.pdf', fileName: 'old.pdf', pageCount: 1, docHash: 'old' }],
      collection: { enabled: true, memberHashes: ['old'] },
      document: null, isGenerating: false, isQaGenerating: false, isParsing: false,
    });
    M.sessionLoad.mockImplementation((h: string) => Promise.resolve(sessionFor(h)));
    M.openPath.mockResolvedValue({ error: 'no-file' });
    const r = await openCollection(['h1', 'h2']);
    expect(r).toEqual({ opened: 2, total: 2 });
    const st = useAppStore.getState();
    expect(st.openTabs.map((tb) => tb.docHash)).toEqual(['h1', 'h2']); // 기존 'old' 제거
    expect(st.collection.enabled).toBe(false);
    expect(st.collection.memberHashes).toEqual([]);
  });

  it('R48: 생성 중이면 no-op — 탭 세트 보존 + {0,0}', async () => {
    useAppStore.setState({
      openTabs: [{ filePath: '/keep.pdf', fileName: 'keep.pdf', pageCount: 1, docHash: 'keep' }],
      document: null, isGenerating: false, isQaGenerating: true, isParsing: false,
    });
    M.sessionLoad.mockImplementation((h: string) => Promise.resolve(sessionFor(h)));
    const r = await openCollection(['h1', 'h2']);
    expect(r).toEqual({ opened: 0, total: 0 });
    expect(useAppStore.getState().openTabs.map((tb) => tb.docHash)).toEqual(['keep']); // wipe 안 됨
  });
});
