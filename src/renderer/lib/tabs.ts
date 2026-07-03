import { useAppStore } from './store';
import { handlePdfData } from './pdf-parser';
import { persistCurrentSession, restoreSessionForDocument } from './use-session';
import { t } from './i18n';
import type { OpenTab, PdfDocument, PersistedSession } from '../types';

/**
 * 다중 문서 탭 오케스트레이션 (multi-doc Phase 1).
 *
 * 설계: 무거운 상태(요약/Q&A/RAG 인덱스/pdfBytes)는 활성 문서 1개만 메모리에 유지한다.
 * 탭 전환 = ① 현재 세션 강제 flush(디바운스 미발화분 보존) → ② 대상 파일 재오픈
 * (file:open-path — .pdf/심볼릭링크/100MB 보안 가드 동일 적용) → ③ handlePdfData 가
 * 파싱 → 콘텐츠 해시 매칭으로 세션 복원(재요약·재임베딩 0). RecentDocuments 재오픈
 * 흐름과 동일한 경로라 복원 게이트/마커(R44 H-1 계약) 의미론을 그대로 상속한다.
 *
 * 파일 재읽기 실패 시(경로가 이름뿐인 dev 드롭, 파일 이동/삭제) 탭의 docHash 로 영속
 * 세션에서 직접 복원하는 fallback — 분석(요약/Q&A/인덱스)은 전부 복원되고 PDF 뷰어만
 * 비활성(원본을 다시 열면 복구 — 최근 문서 재오픈과 동일 정책).
 *
 * UI(TabBar)와 분리한 이유: electronAPI/handlePdfData 모킹으로 단위 테스트 가능하게.
 */

// QA post-v0.31.15: openCollection 재진입/동시 실행 가드. openCollection 은 진입부에서
// isTabSwitchBlocked 로 한 번 차단하지만 실행 중엔 아무 busy 플래그도 세우지 않아, 진행 중
// 두 번째 openCollection(컬렉션 빠른 더블클릭/다른 컬렉션 연속 열기)이나 탭 전환이 진입 가드를
// 통과해 openTabs 를 두 번 비우고 upsertOpenTab/restoreTabFromSession 이 인터리브돼 탭 세트가
// 뒤섞였다. C5-M4(QA cycle5): 모듈 플래그 → store(collectionOpenInFlight) 이관 — 드롭/최근문서/
// 전역검색/Ctrl+O 는 isTabSwitchBlocked 를 거치지 않고 handlePdfData 로 직행하므로, 그 진입
// 가드에서도 참조할 수 있어야 한다. zustand set 은 동기라 "첫 await 이전에 창을 닫는" 계약은
// 그대로 유지되고, restoreTabFromSession 등 내부 호출은 이 플래그를 참조하지 않아 자기 차단
// 위험도 없다(use-collection-summary 의 collectionSummaryInFlight 와 동형).

// QA6-C M2: switchToTab/closeTab(활성)/openNewTabView 재진입 가드. openCollection 과 동일
// 결함 클래스 — 진입부 isTabSwitchBlocked 이후 persistCurrentSession/session.load await 동안
// 아무 busy 플래그도 없어(세션-복원 경로는 isParsing 미사용), 연속 클릭 시 두 번째 전환이
// 가드를 통과해 늦게 resolve 된 복원이 승자가 됐다(마지막 클릭이 아닌 탭이 활성으로 남음).
// 모듈 플래그로 첫 await 이전에 창을 닫고 finally 에서 해제. store 이관(C5-M4)과 달리 모듈
// 로컬로 충분: handlePdfData 직행 경로는 이 플래그를 봐선 안 된다 — openTabTarget 의 파일
// 재파싱 fallback(②)이 handlePdfData 를 호출하므로, 거기서 참조하면 자기 차단이 된다.
let tabSwitchInFlight = false;

/** 생성/파싱 중 전환 차단 — handlePdfData 내부 가드와 동일 기준 (사전 차단으로 UX 개선).
 * isCollectionBusy(컬렉션 gather)도 포함 — gather 단계는 isQaGenerating 설정 전이라, 누락 시
 * in-flight 멤버 요약(클라우드)이 끊기지 않은 채 탭 전환되어 토큰 낭비/백그라운드 완주가 발생.
 * collectionOpenInFlight — openCollection 진행 중 탭 전환/재진입 차단(위 주석 참조).
 * tabSwitchInFlight — 탭 전환/닫기 복원 진행 중 재진입 차단(QA6-C M2, 위 주석 참조). */
export function isTabSwitchBlocked(): boolean {
  const s = useAppStore.getState();
  return tabSwitchInFlight
    || s.isGenerating || s.isQaGenerating || s.isParsing || s.isCollectionBusy || s.collectionOpenInFlight;
}

function findTab(filePath: string): OpenTab | undefined {
  return useAppStore.getState().openTabs.find((tb) => tb.filePath === filePath);
}

/** crypto.randomUUID 안전 래퍼 (store.safeRandomId 와 동일 정책) */
function safeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fallthrough */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * 탭 대상 문서 열기 — ① 영속 세션 우선 복원(재파싱 0, 즉시 전환) → ② 세션 없을 때만 전체 파싱.
 * 성공 시 true. 둘 다 불가하면 false (호출자가 에러 표시/정리 담당).
 *
 * ★ 핵심: 탭 전환마다 handlePdfData(parsePdf) 로 PDF 를 통째로 재파싱하면 대용량/이미지
 * PDF 에서 이미지 추출·OCR 에 수십 초가 걸려 "전환이 안 되는" 것처럼 보인다(parsePdf 가
 * 끝날 때까지 isParsing=true 로 후속 클릭까지 차단). 파싱 결과는 이미 세션에 영속화돼 있으므로
 * 재사용해 즉시 전환한다. 뷰어용 원본 바이트는 상주시키지 않고(pdfBytes 비상주, 메모리 M1)
 * 인용 클릭 시 PdfViewerPanel 이 디스크에서 lazy 로드한다.
 */
async function openTabTarget(tab: OpenTab): Promise<boolean> {
  // ① 세션 우선: 콘텐츠 해시로 저장된 분석 상태(텍스트/요약/Q&A/인덱스)를 즉시 복원
  if (tab.docHash) {
    if (await restoreTabFromSession(tab)) return true;
    console.warn('[tabs] 세션 복원 불가 — 파일 재파싱 fallback:', tab.filePath);
  }

  // ② 세션 미생성(요약/인덱스 전 + persist off 등) — 파일에서 전체 파싱 (보안 가드 동일 적용)
  const result = await window.electronAPI.file.openPath(tab.filePath).catch(() => ({ error: 'ipc' as const }));
  if (!('error' in result)) {
    await handlePdfData(result.data, result.name, result.path);
    return true;
  }
  console.warn('[tabs] 전환 실패: 세션 없음 + 파일 재읽기 불가', tab.filePath, result.error);
  return false;
}

/**
 * 영속 세션에서 탭을 복원 — 재파싱 없이 즉시 전환. 뷰어용 원본 바이트는 비상주(pdfBytes=null)
 * 로 두고 인용 클릭 시 PdfViewerPanel 이 lazy 로드한다. 세션 부재/손상 시 false.
 */
async function restoreTabFromSession(tab: OpenTab): Promise<boolean> {
  if (!tab.docHash) return false;
  const loaded = await window.electronAPI.session.load(tab.docHash).catch(() => null);
  const session = loaded?.session as PersistedSession | undefined;
  if (!session || typeof session.extractedText !== 'string' || !Array.isArray(session.pageTexts)) {
    return false;
  }

  // pdfBytes 비상주(메모리 M1): 뷰어용 원본 바이트는 인용 클릭 시 PdfViewerPanel 이 디스크에서
  // lazy 로드한다(여기서 eager 로 읽지 않음 → 전환 더 빠르고 ~100MB 상주 회피). 분석 상태는
  // 세션에서 즉시 복원. (재읽기 불가 합성경로 탭은 어차피 이전에도 바이트 주입 실패였음 — 무회귀.)
  const doc: PdfDocument = {
    id: safeId(),
    // 세션은 콘텐츠 주소(해시) 기반이라 동일 내용의 다른 파일이 마지막 저장자의 이름으로
    // 덮어쓸 수 있다 — 표시 정체성은 탭 기준 유지 (복사본 파일 시나리오에서 탭명 보존)
    fileName: tab.fileName,
    filePath: tab.filePath,
    pageCount: session.pageCount,
    extractedText: session.extractedText,
    pageTexts: session.pageTexts,
    chapters: Array.isArray(session.chapters) ? session.chapters : [],
    images: [], // 이미지는 미영속화 — 재요약 시에만 필요, 전환 즉시성 우선
    createdAt: new Date(),
    isOcr: session.isOcr,
  };
  // handlePdfData 성공 블록과 동일한 정리 시퀀스
  const s = useAppStore.getState();
  s.clearStream();
  s.setSummary(null);
  s.setProgress(0);
  s.setProgressInfo(null);
  s.clearQa();
  s.setDocument(doc);
  s.setPdfBytes(null); // 비상주 — 인용 클릭 시 lazy 로드
  s.upsertOpenTab({ filePath: tab.filePath, fileName: doc.fileName, pageCount: doc.pageCount, docHash: tab.docHash });
  s.setSessionRestorePending(true);
  // 동일 콘텐츠 → 동일 해시 → 복원 hit (요약/Q&A/인덱스, 재임베딩 0)
  void restoreSessionForDocument(doc);
  s.setError(null);
  s.setNotice(null);
  return true;
}

/** 탭 전환 — 이미 활성이면 no-op. 파일/세션 모두 복원 불가 시 에러 배너 + 탭 유지 */
export async function switchToTab(filePath: string): Promise<void> {
  const store = useAppStore.getState();
  if (store.document?.filePath === filePath) return;
  if (isTabSwitchBlocked()) return;
  const tab = findTab(filePath);
  if (!tab) return;

  // QA6-C M2: 첫 await 이전 동기 세팅 — 진행 중 두 번째 전환/닫기 재진입 차단. finally 해제.
  tabSwitchInFlight = true;
  try {
    // 현재 문서의 미저장 tail 보존 (persistChain 직렬화 — 내부에서 생성 중/게이트 검사)
    await persistCurrentSession();

    const ok = await openTabTarget(tab);
    if (!ok) {
      useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: t('tabs.switchFail') });
    }
  } finally {
    tabSwitchInFlight = false;
  }
}

/**
 * 탭 닫기 — 활성 탭이면 flush 후 이웃(오른쪽 우선)으로 전환, 마지막 탭이면 업로드 화면으로.
 * 비활성 탭은 목록에서만 제거 (영속화된 세션은 디스크에 유지 — 최근 문서에서 재오픈 가능).
 */
export async function closeTab(filePath: string): Promise<void> {
  const store = useAppStore.getState();
  const isActive = store.document?.filePath === filePath;
  if (isActive && isTabSwitchBlocked()) return;
  // C5-L(QA cycle5): 비활성 탭도 컬렉션 작업 중에는 제거 금지 — openCollection 의 멤버 upsert
  // 루프와 인터리브되면 opened/total 집계·최종 탭 세트가 어긋나고, gather 중에는 memberHashes
  // 와 캡처된 eligible 목록이 desync 된다(손상은 없으나 표시 불일치).
  // tabSwitchInFlight(QA6-C M2)도 동일 사유 — 전환 중 대상/이웃 탭이 제거되면 복원이 지워진
  // 탭을 upsert 로 되살린다.
  if (!isActive && (store.isCollectionBusy || store.collectionOpenInFlight || tabSwitchInFlight)) return;

  const tabs = store.openTabs;
  const idx = tabs.findIndex((tb) => tb.filePath === filePath);
  store.removeOpenTab(filePath);

  if (!isActive) return;

  // QA6-C M2: 활성 탭 닫기(flush+이웃 복원)도 전환과 동일 클래스 — 재진입 가드. finally 해제.
  tabSwitchInFlight = true;
  try {
    // 활성 탭 닫기: 디스크에 보존 후 정리
    await persistCurrentSession();
    const remaining = useAppStore.getState().openTabs;
    if (remaining.length === 0) {
      // 마지막 탭 — 업로드 화면 (기존 "문서 제거" 버튼과 동일한 정리 시퀀스)
      const s = useAppStore.getState();
      s.setDocument(null);
      s.clearStream();
      s.setSummary(null);
      s.setProgress(0);
      return;
    }
    // 이웃 전환: 닫힌 위치의 오른쪽(같은 인덱스), 없으면 마지막
    const neighbor = remaining[Math.min(idx, remaining.length - 1)];
    if (!neighbor) return;
    const ok = await openTabTarget(neighbor);
    if (!ok) {
      // 이웃도 복원 불가 — 업로드 화면으로 안전 착지 (탭은 유지해 재시도 가능)
      const s = useAppStore.getState();
      s.setDocument(null);
      s.clearStream();
      s.setSummary(null);
      s.setProgress(0);
      s.setError({ code: 'PDF_PARSE_FAIL', message: t('tabs.switchFail') });
    }
  } finally {
    tabSwitchInFlight = false;
  }
}

/** 새 탭(+) — 활성 문서를 보존(flush)하고 업로드 화면으로. 탭 목록은 유지 */
export async function openNewTabView(): Promise<void> {
  const store = useAppStore.getState();
  if (!store.document) return; // 이미 업로드 화면
  if (isTabSwitchBlocked()) return;
  // QA6-C M2: flush 중 전환/닫기 인터리브 차단(switchToTab 과 대칭)
  tabSwitchInFlight = true;
  try {
    await persistCurrentSession();
    const s = useAppStore.getState();
    s.setDocument(null);
    s.clearStream();
    s.setSummary(null);
    s.setProgress(0);
  } finally {
    tabSwitchInFlight = false;
  }
}

/**
 * 저장된 컬렉션 재오픈 (multi-doc Phase 3 / module-2) — 멤버 docHash 들을 탭 세트로 복원.
 * 각 멤버는 세션에서 메타(파일명/경로/페이지)를 읽어 탭으로 등록하고, **첫 멤버를 활성 문서로
 * 전체 복원**(세션-우선 — 재파싱·재임베딩 0)한다. 세션이 없는 멤버(LRU 삭제/손상)는 건너뛴다.
 *
 * @returns { opened, total } — 부분 복원 시 호출자가 안내(opened < total).
 */
export async function openCollection(docHashes: string[]): Promise<{ opened: number; total: number }> {
  // 방어 가드(R48 LOW): 생성/파싱 중에는 탭 세트를 비우면 진행 중 작업과 충돌하므로 no-op.
  // 주 UX 경로(CollectionsList)는 호출 전에 isTabSwitchBlocked 로 안내하지만, 다른 호출자가
  // 우회하더라도 상태를 훼손하지 않도록 함수 진입부에서 한 번 더 차단(switchToTab 등과 대칭).
  if (isTabSwitchBlocked()) return { opened: 0, total: 0 };
  // 동기 재진입 가드 세팅 — 이후 첫 await 이전에 창을 닫아, 진행 중 두 번째 openCollection/탭 전환/
  // 문서 열기(handlePdfData)가 차단되게 한다. finally 에서 반드시 해제.
  useAppStore.getState().setCollectionOpenInFlight(true);
  try {
    // 교체 시맨틱(R47 UX): "이 컬렉션을 연다" = 현재 탭 세트를 컬렉션 멤버로 교체. 업로드 화면
    // (document=null)에서만 호출되고 세션은 이미 영속화돼 있어 기존 탭 목록만 비우면 데이터 손실 없음.
    // 기존 additive 는 다른 작업 세트와 섞여 탭이 예상외로 불어났다.
    useAppStore.setState({ openTabs: [], collection: { enabled: false, memberHashes: [] } });

    let opened = 0;
    let activated = false;
    const seen = new Set<string>(); // R47: 중복 docHash 가 opened 를 과다 집계하지 않도록
    for (const docHash of docHashes) {
      if (seen.has(docHash)) continue;
      seen.add(docHash);
      const loaded = await window.electronAPI.session.load(docHash).catch(() => null);
      const session = loaded?.session as PersistedSession | undefined;
      if (!session || typeof session.fileName !== 'string' || typeof session.filePath !== 'string') {
        continue; // 멤버 세션 부재/손상 → skip(부분 복원)
      }
      const tab: OpenTab = {
        filePath: session.filePath,
        fileName: session.fileName,
        pageCount: session.pageCount,
        docHash,
      };
      useAppStore.getState().upsertOpenTab(tab);
      opened++;
      // 첫 유효 멤버를 활성 문서로 전체 복원(나머지는 탭으로만 등록 — 클릭 시 세션-우선 복원).
      // QA6-C: 복원 실패(false — 세션에 extractedText/pageTexts 부재 등 본문 손상)를 무시하고
      // activated=true 로 굳히면 활성 문서 없이 탭만 남고 이후 멤버로의 활성화 fallback 도
      // 막혔다. 반환값 기준으로 다음 유효 멤버가 활성화를 이어받는다(탭 등록은 그대로 유지 —
      // 클릭 시 파일 재파싱 fallback 으로 복구 가능).
      if (!activated) {
        activated = await restoreTabFromSession(tab);
      }
    }
    return { opened, total: seen.size }; // 고유 멤버 기준(중복 제외)으로 부분 복원 판정
  } finally {
    useAppStore.getState().setCollectionOpenInFlight(false);
  }
}
