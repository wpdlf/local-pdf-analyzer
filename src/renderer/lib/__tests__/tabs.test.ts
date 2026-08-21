// @vitest-environment happy-dom

// multi-doc Phase 1: 탭 오케스트레이션(lib/tabs.ts) 행위 가드.
// 핵심 계약 — ① 전환은 flush → 재오픈 → handlePdfData 순서, ② 활성 탭이면 no-op,
// ③ 재오픈 실패는 에러 배너 + 탭 유지, ④ 활성 탭 닫기는 오른쪽 이웃 우선 전환,
// ⑤ 마지막 탭 닫기는 업로드 화면 정리, ⑥ 생성/파싱 중 전환·활성 닫기 차단.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const M = vi.hoisted(() => ({
  handlePdfData: vi.fn(() => Promise.resolve()),
  persistCurrentSession: vi.fn(() => Promise.resolve()),
  restoreSessionForDocument: vi.fn(() => Promise.resolve()),
  openPath: vi.fn(),
  sessionLoad: vi.fn(),
  notifyEmptyPages: vi.fn(),
}));

// QA23: 세션 복원도 "빈 페이지 다수" 를 다시 통지한다(1회성 파싱 통지가 세션에 안 남던 결함).
vi.mock('../pdf-parser', () => ({ handlePdfData: M.handlePdfData, notifyEmptyPages: M.notifyEmptyPages }));
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

import { switchToTab, closeTab, openNewTabView, openCollection, openFromSessionOnly } from '../tabs';
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

  it('docHash + 세션 → 세션 우선 복원 (재파싱 0, pdfBytes 비상주 lazy)', async () => {
    // ★ 사용자 버그 핵심 계약: 탭에 docHash 가 있으면 파일이 읽혀도 handlePdfData(재파싱)
    // 를 호출하지 않고 세션에서 즉시 복원한다. 재파싱은 대용량/이미지 PDF 에서 수십 초가
    // 걸려 "전환이 안 되는" 것처럼 보이던 원인.
    // pdfBytes 비상주(메모리 M1): 뷰어용 바이트는 더 이상 복원 시 eager 로 읽지 않고(openPath
    // 미호출) 인용 클릭 시 PdfViewerPanel 이 lazy 로드한다 → 전환 더 빠르고 ~100MB 상주 회피.
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    useAppStore.setState((s) => ({
      openTabs: [...s.openTabs, { filePath: '/docs/big.pdf', fileName: 'big.pdf', pageCount: 49, docHash: 'd'.repeat(64) }],
    }));
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
    expect(M.openPath).not.toHaveBeenCalled(); // ★ 복원 시 eager 파일 읽기 안 함(lazy)
    const st = useAppStore.getState();
    expect(st.document?.fileName).toBe('big.pdf'); // 전환 성공
    expect(st.document?.pageCount).toBe(49);
    expect(st.pdfBytes).toBeNull(); // 비상주 — 인용 클릭 시 lazy 로드
    expect(st.error).toBeNull();
    expect(M.restoreSessionForDocument).toHaveBeenCalledTimes(1);
  });

  // QA23(C-MED): 파싱 시점의 "N페이지가 비어 있음" 통지는 1회성이라 세션에 남지 않는다.
  // 그래서 200쪽 중 150쪽이 OCR 실패로 빈 채 저장된 문서를 재오픈하면 **완전한 문서처럼** 보이고
  // 그 위에서 요약·RAG·Q&A 가 계속 돌았다(QA22 가 닫으려던 무음 손실이 두 번째 세션부터 부활).
  it('세션 복원 시 빈 페이지가 많으면 다시 통지한다', async () => {
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    useAppStore.setState((s) => ({
      openTabs: [...s.openTabs, { filePath: '/docs/scan.pdf', fileName: 'scan.pdf', pageCount: 10, docHash: 'e'.repeat(64) }],
    }));
    M.sessionLoad.mockResolvedValue({
      session: {
        schemaVersion: 1, docHash: 'e'.repeat(64), fileName: 'scan.pdf', filePath: '/docs/scan.pdf',
        pageCount: 10, extractedText: '표지 본문',
        // 10쪽 중 8쪽이 빈 채 저장된 문서(OCR 부분 실패)
        pageTexts: ['표지 본문', '', '', '', '', '', '', '', '', '마지막'],
        isOcr: true,
        chapters: [], summaries: {}, qaMessages: [], embedModel: null, embedDim: null, chunkMeta: [],
      },
      blob: null,
    });

    await switchToTab('/docs/scan.pdf');

    expect(M.notifyEmptyPages).toHaveBeenCalledTimes(1);
    const [pageTexts, key] = M.notifyEmptyPages.mock.calls[0]!;
    expect((pageTexts as string[]).length).toBe(10);
    expect(key, 'OCR 문서면 OCR 부분 실패 문구여야 한다').toBe('pdf.ocrPartialFailNotice');
  });

  // QA26(C-Medium): imagesSkipped 는 세션에 실리지 않아 **세션 복원 문서에서만** 사라졌다.
  // 그러면 use-summarize 의 `enableImageAnalysis && images.length===0 && imagesSkipped` 가 영원히
  // false 가 되어, QA6-D 가 만든 "재오픈 필요" 안내가 이 경로에서 도달 불가가 된다 — 이미지 분석을
  // 켠 사용자가 이미지 없이 만들어진 요약을 정상 결과로 받는다. isOcr 은 싣는데 이것만 누락이었다.
  it('세션 복원이 imagesSkipped 마커를 되살린다', async () => {
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    useAppStore.setState((s) => ({
      openTabs: [...s.openTabs, { filePath: '/docs/img.pdf', fileName: 'img.pdf', pageCount: 3, docHash: 'f'.repeat(64) }],
    }));
    M.sessionLoad.mockResolvedValue({
      session: {
        schemaVersion: 1, docHash: 'f'.repeat(64), fileName: 'img.pdf', filePath: '/docs/img.pdf',
        pageCount: 3, extractedText: '본문', pageTexts: ['본문', '본문', '본문'],
        imagesSkipped: true,
        chapters: [], summaries: {}, qaMessages: [], embedModel: null, embedDim: null, chunkMeta: [],
      },
      blob: null,
    });

    await switchToTab('/docs/img.pdf');

    const doc = useAppStore.getState().document!;
    expect(doc.images, '세션 복원은 정의상 이미지를 갖지 않는다').toEqual([]);
    expect(doc.imagesSkipped, '마커가 없으면 Vision 무음 no-op 안내가 도달 불가가 된다').toBe(true);
  });

  // QA27(A-Important): 위 마커는 "설정 OFF" 만 표현한다. 이미지 분석은 **기본 ON** 이므로
  // 대다수 문서는 imagesSkipped=false 로 저장되고, 복원 문서는 언제나 images:[] 다 —
  // 즉 정당한 텍스트-only PDF 와 구분이 불가능했고, 재요약이 Vision 없이 조용히 끝났다.
  it('세션 복원이 hadImages 도 되살린다 (설정 ON 으로 파싱된 다수 경로)', async () => {
    seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
    useAppStore.setState((s) => ({
      openTabs: [...s.openTabs, { filePath: '/docs/photo.pdf', fileName: 'photo.pdf', pageCount: 3, docHash: 'e'.repeat(64) }],
    }));
    M.sessionLoad.mockResolvedValue({
      session: {
        schemaVersion: 1, docHash: 'e'.repeat(64), fileName: 'photo.pdf', filePath: '/docs/photo.pdf',
        pageCount: 3, extractedText: '본문', pageTexts: ['본문', '본문', '본문'],
        imagesSkipped: false, hadImages: true, // 설정 ON 으로 파싱돼 이미지가 12장 있었던 문서
        chapters: [], summaries: {}, qaMessages: [], embedModel: null, embedDim: null, chunkMeta: [],
      },
      blob: null,
    });

    await switchToTab('/docs/photo.pdf');

    const doc = useAppStore.getState().document!;
    expect(doc.images).toEqual([]);
    expect(doc.hadImages, 'hadImages 가 없으면 텍스트-only PDF 와 구분되지 않아 무음 no-op 이 된다').toBe(true);
  });

  // QA23(D-MED): 영속화 OFF + 다중 탭이면 전환이 현재 문서의 요약·Q&A 를 **경고 없이** 파기했다
  // (저장할 곳이 없어 persistCurrentSession 은 no-op, 대상은 재파싱 경로로 가며 store 초기화).
  // "디스크에 안 쓴다"는 설정이 "탭을 바꾸면 작업이 사라진다"를 뜻하지는 않는다.
  describe('영속화 OFF 전환 경고', () => {
    const withPersistOff = () => {
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, persistSessions: false },
        summary: { id: 's', documentId: 'd', type: 'full', content: '요약본', model: 'm', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
        summaryStream: '요약본',
      });
    };

    it('잃을 작업이 있으면 확인을 묻고, 취소하면 전환하지 않는다', async () => {
      seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
      withPersistOff();
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await switchToTab('/docs/b.pdf');
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(M.openPath, '취소했는데 전환이 진행되면 안 된다').not.toHaveBeenCalled();
        expect(useAppStore.getState().summary?.content, '요약이 남아 있어야 한다').toBe('요약본');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('확인하면 종전대로 전환한다', async () => {
      seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
      withPersistOff();
      vi.stubGlobal('confirm', vi.fn(() => true));
      try {
        await switchToTab('/docs/b.pdf');
        expect(M.openPath).toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('잃을 작업이 없으면 묻지 않는다 (과잉 확인 방지)', async () => {
      seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, persistSessions: false },
        summary: null, summaryStream: '', qaMessages: [],
      });
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await switchToTab('/docs/b.pdf');
        expect(confirmSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('영속화가 켜져 있으면 묻지 않는다 (기본 경로 무회귀)', async () => {
      seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
      useAppStore.setState({
        settings: { ...useAppStore.getState().settings, persistSessions: true },
        summary: { id: 's', documentId: 'd', type: 'full', content: '요약본', model: 'm', provider: 'ollama', createdAt: new Date(), durationMs: 1 },
      });
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await switchToTab('/docs/b.pdf');
        expect(confirmSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // QA24(A-I1): 근인은 "전환" 이 아니라 **문서 교체**다. 종전 테스트가 switchToTab 만
    // 구동해, 같은 손실을 내는 형제 경로(탭 닫기·"+"·직행 로드)가 무경고로 남은 것을 놓쳤다.
    it('활성 탭 닫기도 이웃으로 교체되므로 묻는다 — 취소하면 탭이 남는다', async () => {
      seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
      withPersistOff();
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await closeTab('/docs/a.pdf');
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        // removeOpenTab 뒤에 물으면 취소해도 탭이 이미 사라진 뒤다.
        expect(useAppStore.getState().openTabs.map((t) => t.filePath), '취소했는데 탭이 사라지면 안 된다')
          .toEqual(['/docs/a.pdf', '/docs/b.pdf']);
        expect(useAppStore.getState().summary?.content).toBe('요약본');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('"+"(새 탭)도 활성 문서를 교체하므로 묻는다 — 취소하면 문서가 남는다', async () => {
      seedTabs(['/docs/a.pdf'], '/docs/a.pdf');
      withPersistOff();
      const confirmSpy = vi.fn(() => false);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await openNewTabView();
        expect(confirmSpy).toHaveBeenCalledTimes(1);
        expect(useAppStore.getState().document, '취소했는데 업로드 화면으로 가면 안 된다').not.toBeNull();
        expect(useAppStore.getState().summary?.content).toBe('요약본');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('비활성 탭 닫기는 문서를 교체하지 않으므로 묻지 않는다 (과잉 확인 방지)', async () => {
      seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
      withPersistOff();
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await closeTab('/docs/b.pdf');
        expect(confirmSpy).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // 탭 전환의 파일 재파싱 fallback 은 handlePdfData 를 경유한다. 그 안에도 같은 게이트가
    // 생겼으므로, 옵션으로 끄지 않으면 한 번의 전환에 확인이 두 번 뜬다.
    it('전환의 재파싱 fallback 에서 확인이 두 번 뜨지 않는다', async () => {
      seedTabs(['/docs/a.pdf', '/docs/b.pdf'], '/docs/a.pdf');
      withPersistOff();
      const confirmSpy = vi.fn(() => true);
      vi.stubGlobal('confirm', confirmSpy);
      try {
        await switchToTab('/docs/b.pdf');
        expect(M.openPath).toHaveBeenCalled();
        expect(confirmSpy, '이중 질문은 사용자를 훈련시켜 확인을 무의미하게 만든다').toHaveBeenCalledTimes(1);
      } finally {
        vi.unstubAllGlobals();
      }
    });
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

  // QA post-v0.31.15: 진행 중 재진입 차단 — 첫 openCollection 이 아직 멤버 로드 중일 때
  // 두 번째 호출(빠른 더블클릭/다른 컬렉션)은 즉시 {0,0} no-op 이어야 탭 세트가 뒤섞이지 않는다.
  it('진행 중 재진입 차단 — 두 번째 openCollection 은 {0,0} no-op', async () => {
    seedTabs([], null);
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => { release = r; });
    let firstLoad = true;
    M.sessionLoad.mockImplementation(async (h: string) => {
      if (firstLoad) { firstLoad = false; await gate; } // 첫 멤버 로드에서 대기
      return sessionFor(h);
    });
    M.openPath.mockResolvedValue({ error: 'no-file' });

    const p1 = openCollection(['h1', 'h2']); // 동기 구간에서 collectionOpenInFlight=true 세팅 후 gate 대기
    const r2 = await openCollection(['x', 'y']); // 재진입 → 즉시 차단(탭 wipe 없음)
    expect(r2).toEqual({ opened: 0, total: 0 });

    release(null); // 첫 호출 재개
    const r1 = await p1;
    expect(r1).toEqual({ opened: 2, total: 2 });
    expect(useAppStore.getState().openTabs.map((tb) => tb.docHash)).toEqual(['h1', 'h2']);
  });

  // QA6-C: 첫 멤버 세션이 본문 손상(extractedText/pageTexts 부재)이면 restoreTabFromSession 이
  // false 인데도 activated=true 로 굳혀 활성 문서 없이 탭만 남고 이후 멤버 fallback 이 막혔다.
  it('첫 멤버 활성화 실패 시 다음 유효 멤버가 활성화를 이어받는다', async () => {
    seedTabs([], null);
    M.sessionLoad.mockImplementation(async (h: string) => {
      if (h === 'broken') {
        // 메타(fileName/filePath)는 유효 → 탭 등록은 되지만 본문이 없어 활성 복원은 실패
        return { session: { schemaVersion: 1, docHash: h, fileName: 'broken.pdf', filePath: '/d/broken.pdf', pageCount: 1 }, blob: null };
      }
      return sessionFor(h);
    });
    M.openPath.mockResolvedValue({ error: 'no-file' });
    const r = await openCollection(['broken', 'h2']);
    expect(r).toEqual({ opened: 2, total: 2 }); // 탭 등록 집계는 유지(클릭 시 재파싱 fallback 가능)
    const st = useAppStore.getState();
    expect(st.openTabs.map((tb) => tb.docHash)).toEqual(['broken', 'h2']);
    expect(st.document?.fileName).toBe('h2.pdf'); // 다음 유효 멤버가 활성
  });
});

// QA6-C M2: switchToTab/closeTab(활성) 재진입 가드 — persist/복원 await 동안 busy 플래그가
// 없어 연속 클릭 시 늦게 resolve 된 복원이 승자가 되던 race(openCollection C5-M4 와 동일 클래스).
describe('탭 전환/닫기 재진입 가드 (QA6-C M2)', () => {
  // 이 describe 는 persistCurrentSession 을 pending Promise 로 바꾸므로, 다른 테스트로 새지
  // 않도록 전후로 기본(즉시 resolve) 구현을 복원한다(전역 clearMocks 미사용 환경).
  beforeEach(() => { M.persistCurrentSession.mockImplementation(() => Promise.resolve()); });
  afterEach(() => { M.persistCurrentSession.mockImplementation(() => Promise.resolve()); });

  it('전환 진행 중 두 번째 switchToTab 은 차단 — 첫 전환만 수행', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf', '/docs/c.pdf'], '/docs/a.pdf');
    let release!: () => void;
    M.persistCurrentSession.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const first = switchToTab('/docs/b.pdf'); // persist 대기 중 (in-flight)
    await switchToTab('/docs/c.pdf');         // 재진입 → 즉시 차단
    expect(M.persistCurrentSession).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(M.openPath).toHaveBeenCalledTimes(1);
    expect(M.openPath).toHaveBeenCalledWith('/docs/b.pdf');
  });

  it('전환 진행 중 비활성 탭 닫기 차단 — 복원이 지워진 탭을 되살리는 desync 방지', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf', '/docs/c.pdf'], '/docs/a.pdf');
    let release!: () => void;
    M.persistCurrentSession.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const first = switchToTab('/docs/b.pdf');
    await closeTab('/docs/c.pdf'); // 비활성 탭 닫기 시도 → 차단
    expect(useAppStore.getState().openTabs).toHaveLength(3);
    release();
    await first;
    expect(useAppStore.getState().openTabs).toHaveLength(3); // 전환 완료 후에도 탭 세트 보존
  });

  it('활성 탭 닫기 진행 중 switchToTab 차단', async () => {
    seedTabs(['/docs/a.pdf', '/docs/b.pdf', '/docs/c.pdf'], '/docs/a.pdf');
    let release!: () => void;
    M.persistCurrentSession.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    const closing = closeTab('/docs/a.pdf'); // 활성 닫기 — persist 대기 중
    await switchToTab('/docs/c.pdf');        // 재진입 → 차단
    release();
    await closing;
    // 이웃(오른쪽 우선 = /docs/b.pdf) 전환만 수행 — switchToTab('/docs/c.pdf') 는 개입 못함
    expect(M.openPath).toHaveBeenCalledTimes(1);
    expect(M.openPath).toHaveBeenCalledWith('/docs/b.pdf');
  });

  // QA27(A-MED): openFromSessionOnly 는 게이트를 **검사만 하고 세우지 않던** 네 번째 형제였다.
  it('세션-전용 열기 진행 중 두 번째 호출은 차단된다 (네 번째 형제)', async () => {
    seedTabs([], null); // 업로드 화면 — 최근 문서/전역 검색의 진입 상태
    let release!: (v: unknown) => void;
    M.sessionLoad.mockImplementationOnce(() => new Promise((r) => { release = r; }));

    const first = openFromSessionOnly({ docHash: 'a'.repeat(64), fileName: 'A.pdf', filePath: '/docs/A.pdf', pageCount: 3 });
    // 첫 호출의 session.load 가 아직 pending — 사용자가 목록의 다른 항목을 누른다.
    const second = await openFromSessionOnly({ docHash: 'b'.repeat(64), fileName: 'B.pdf', filePath: '/docs/B.pdf', pageCount: 4 });
    expect(second, '두 번째 호출이 게이트를 통과하면 늦게 끝난 쪽이 활성 문서가 된다').toBe(false);
    expect(M.sessionLoad).toHaveBeenCalledTimes(1);

    release({ session: { docHash: 'a'.repeat(64), extractedText: 'x'.repeat(60), pageTexts: ['x'.repeat(60)], pageCount: 3 } });
    await first;
    // 게이트는 반드시 해제된다 — 안 그러면 이후 모든 전환이 영구 차단된다.
    expect(useAppStore.getState().isTabSwitching).toBe(false);
    expect(useAppStore.getState().document?.fileName).toBe('A.pdf');
  });

  it('세션-전용 열기가 실패해도 게이트를 해제한다', async () => {
    seedTabs([], null);
    M.sessionLoad.mockResolvedValueOnce(null); // 세션 부재
    await expect(openFromSessionOnly({ docHash: 'c'.repeat(64), fileName: 'C.pdf', filePath: '/docs/C.pdf', pageCount: 1 })).resolves.toBe(false);
    expect(useAppStore.getState().isTabSwitching).toBe(false);
  });
});
