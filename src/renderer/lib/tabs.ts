import { useAppStore } from './store';
import { handlePdfData, notifyEmptyPages } from './pdf-parser';
import { persistCurrentSession, restoreSessionForDocument } from './use-session';
import { confirmDiscardIfNotPersisted } from './discard-policy';
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
// 첫 await 이전에 창을 닫고 finally 에서 해제.
//
// QA21(B/A-MED, 데이터손실): **모듈 로컬 → store 이관**(collectionOpenInFlight 가 밟은 경로와
// 동일 사유). "모듈 로컬로 충분" 했던 이전 판단이 틀렸다 — 이 플래그가 store 밖이라
// useSummarize/use-qa/use-collection-summary 와 TabBar 가 볼 수 없었고, 그래서 전환의 두 await
// (persistCurrentSession → session.load, index.bin 수 MB) 동안 요약·질문·교차요약 버튼이
// 살아 있었다. 거기서 시작한 작업은 복원이 끝나며 clearStream/clearQa/setDocument 로 조용히
// 폐기된다(세션-우선 복원 경로는 isParsing 을 세우지 않으므로 그 가드로도 막히지 않는다).
//
// ⚠️ 제약은 유지: handlePdfData 직행 경로는 이 플래그를 봐선 안 된다 — openTabTarget 의 파일
// 재파싱 fallback(②)이 handlePdfData 를 호출하므로, 거기서 참조하면 자기 차단이 된다.
const setTabSwitching = (v: boolean): void => { useAppStore.getState().setTabSwitching(v); };

/** 생성/파싱 중 전환 차단 — handlePdfData 내부 가드와 동일 기준 (사전 차단으로 UX 개선).
 * isCollectionBusy(컬렉션 gather)도 포함 — gather 단계는 isQaGenerating 설정 전이라, 누락 시
 * in-flight 멤버 요약(클라우드)이 끊기지 않은 채 탭 전환되어 토큰 낭비/백그라운드 완주가 발생.
 * collectionOpenInFlight — openCollection 진행 중 탭 전환/재진입 차단(위 주석 참조).
 * isTabSwitching — 탭 전환/닫기 복원 진행 중 재진입 차단(QA6-C M2 → QA21 store 이관). */
export function isTabSwitchBlocked(): boolean {
  const s = useAppStore.getState();
  return s.isTabSwitching
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
    // 파기 확인은 이 함수의 호출자(switchToTab·closeTab)가 이미 마쳤다 — 중복 질문 방지.
    await handlePdfData(result.data, result.name, result.path, { skipDiscardConfirm: true });
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
  // QA32(B): 이 함수에는 소유권 검사가 **하나도 없었다**. 의존하던 방어는 `isTabSwitching`
  // 인데 `handlePdfData` 는 그 플래그를 **의도적으로 보지 않는다**(자기 차단 방지 — tabs.ts:47).
  // 그래서 탭 클릭이 persistCurrentSession + session.load(수 MB) 를 도는 창에서 드롭·Ctrl+O·
  // 최근문서·전역검색이 handlePdfData 로 직행할 수 있고, 두 setDocument 가 임의 순서로 착지한다.
  // handlePdfData 의 가드는 **파싱끼리만** 비교하므로(activeParseController) 세션 복원이 자기
  // 결과를 덮어쓴 것을 탐지하지 못한다 — 사용자가 방금 드롭한 문서가 조용히 사라지고 탭만 남는다
  // (QA20 C-MED 가 요약 경로에서 닫은 클래스와 동형).
  const startDocId = useAppStore.getState().document?.id ?? null;
  const loaded = await window.electronAPI.session.load(tab.docHash).catch(() => null);
  const session = loaded?.session as PersistedSession | undefined;
  if (!session || typeof session.extractedText !== 'string' || !Array.isArray(session.pageTexts)) {
    return false;
  }
  // await 사이에 다른 흐름이 활성 문서를 바꿨거나 파싱을 시작했으면 이 복원은 stale 이다.
  // 호출자 셋(switchToTab·openFromSessionOnly·openCollection)은 모두 false 폴백을 갖고 있다.
  // ⚠️ 양쪽을 같은 방식으로 정규화해야 한다 — 업로드 화면(document=null)에서 `?.id` 는
  // `undefined` 이고 캡처값은 `null` 이라, 정규화 없이 비교하면 **문서가 없을 때 항상 불일치**가
  // 되어 정상 복원까지 막는다(초판이 openCollection 3건을 깨뜨렸다).
  const now = useAppStore.getState();
  if ((now.document?.id ?? null) !== startDocId || now.isParsing) return false;

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
    // 세션 복원은 정의상 이미지를 갖고 있지 않다(images: [] 위). 파싱 당시 스킵 마커를 복원해야
    // "재오픈 필요" 안내가 이 경로에서도 뜬다 — 없으면 무음 no-op 으로 되돌아간다.
    imagesSkipped: session.imagesSkipped,
    // QA27(A-Important): 파싱 당시 이미지가 있었다면 그 사실도 복원한다. imagesSkipped 는
    // "설정 OFF" 전용이라 기본값(ON)으로 열린 문서에서는 false 이고, 복원 문서는 언제나
    // images:[] 이므로 그것만으로는 **텍스트-only PDF 와 구분되지 않았다** — 재요약이 Vision
    // 없이 조용히 진행됐다(QA6-D 가 없앤 무음 no-op 이 다수 경로에서 살아 있었다).
    hadImages: session.hadImages,
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
  // QA23(C-MED): 파싱 시점의 "N페이지가 비어 있음" 통지는 **1회성**이라 세션에 남지 않는다.
  // 그래서 200쪽 중 150쪽이 OCR 실패로 빈 채 저장된 문서도 재오픈하면 **완전한 문서처럼** 보이고,
  // 그 위에서 요약·RAG·Q&A 가 계속 돈다(QA22 가 닫으려던 무음 손실이 두 번째 세션부터 부활).
  // 판정 입력(pageTexts)이 세션에 그대로 있으므로 복원 시 다시 계산해 알린다.
  notifyEmptyPages(doc.pageTexts, doc.isOcr ? 'pdf.ocrPartialFailNotice' : 'pdf.emptyPagesNotice');
  return true;
}

/**
 * 원본 파일 없이 **세션만으로** 문서를 연다 — 최근 문서·전역 검색의 폴백.
 *
 * QA26(C-High): 세션에는 extractedText·pageTexts·요약·Q&A·인덱스가 전부 들어 있어 파일이 없어도
 * 분석 상태를 완전히 복원할 수 있다. switchToTab 은 그 계약을 이미 코드화했지만(세션 우선 →
 * 없을 때만 재파싱), **openTabs 는 영속되지 않으므로 재기동 직후에는 그 경로에 도달할 방법이
 * 없다**. 그때 유일한 입구인 최근 문서·전역 검색은 순서가 반대이고(파일 먼저) 폴백도 없어서,
 * 파일을 옮기거나 이름을 바꾸거나 USB 가 빠진 상태로 재기동하면 목록에는 "N페이지 · N청크
 * 인덱싱됨" 으로 멀쩡히 보이는데 열기는 실패 배너만 띄웠다. 같은 상황이 앱을 켜 둔 채로는
 * 복원되고 껐다 켜면 안 되는 비대칭이었다.
 *
 * 성공하면 뷰어만 비활성(pdfBytes=null)이고 나머지는 평소와 동일하다.
 */
export async function openFromSessionOnly(entry: {
  docHash: string; fileName: string; filePath: string; pageCount: number;
}): Promise<boolean> {
  if (isTabSwitchBlocked()) return false;
  // QA28(A-Important): QA27 은 게이트 하나만 채웠다. 형제 3함수는 게이트·flush·파기확인 **셋**을
  // 전부 하는데 이 경로는 restoreTabFromSession 으로 활성 문서를 교체하면서도 (a) 영속화 OFF 면
  // 묻지 않고 파기했고 (b) ON 이면 디바운스 tail(방금 끝난 요약/Q&A 델타)을 flush 없이 버렸다.
  if (!confirmDiscardIfNotPersisted()) return false;
  // QA27(A-MED): 게이트를 **검사만 하고 세우지 않았다** — switchToTab·closeTab·openNewTabView 는
  // 전부 setTabSwitching(true) 로 자기 구간을 잠그는데 이 신규 진입점만 빠진 네 번째 형제였다.
  // isTabSwitching 은 isTabSwitchBlocked 의 입력이므로, 세우지 않으면 두 번째 호출이 같은 창에서
  // 게이트를 그대로 통과한다: 최근 문서에서 A→B 를 연달아 누르면 restoreTabFromSession 의
  // session.load await 뒤에 store 를 쓰는 쪽이 **늦게 끝난 A** 가 되어, 사용자가 누른 것은 B 인데
  // 활성 문서는 A 가 된다(탭은 둘 다 등록된다). QA6-C M2 가 닫은 클래스와 같은 모양이다.
  setTabSwitching(true);
  try {
    // 현재 문서의 미저장 tail 보존 (switchToTab·closeTab·openNewTabView 와 동일 순서)
    await persistCurrentSession();
    // restoreTabFromSession 은 세션 부재/손상 시 **store 를 건드리기 전에** false 를 반환하므로,
    // 실패해도 열리지 않은 탭이 남지 않는다(탭 등록은 성공 경로 안에 있다).
    return await restoreTabFromSession({
      filePath: entry.filePath,
      fileName: entry.fileName,
      pageCount: entry.pageCount,
      docHash: entry.docHash,
    });
  } finally {
    setTabSwitching(false);
  }
}

/** 탭 전환 — 이미 활성이면 no-op. 파일/세션 모두 복원 불가 시 에러 배너 + 탭 유지 */
export async function switchToTab(filePath: string): Promise<void> {
  const store = useAppStore.getState();
  if (store.document?.filePath === filePath) return;
  if (isTabSwitchBlocked()) return;
  const tab = findTab(filePath);
  if (!tab) return;
  // QA23(D-MED): 영속화 OFF 면 전환이 현재 요약·Q&A 를 되돌릴 수 없이 파기한다 — 묻고 진행한다.
  if (!confirmDiscardIfNotPersisted()) return;

  // QA6-C M2: 첫 await 이전 동기 세팅 — 진행 중 두 번째 전환/닫기 재진입 차단. finally 해제.
  setTabSwitching(true);
  try {
    // 현재 문서의 미저장 tail 보존 (persistChain 직렬화 — 내부에서 생성 중/게이트 검사)
    await persistCurrentSession();

    const ok = await openTabTarget(tab);
    if (!ok) {
      useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: t('tabs.switchFail') });
    }
  } finally {
    setTabSwitching(false);
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
  if (!isActive && (store.isCollectionBusy || store.collectionOpenInFlight || store.isTabSwitching)) return;

  // QA24(A-I1): 활성 탭을 닫으면 이웃 문서로 교체되므로 전환과 **동일한 손실**이다(영속화 OFF
  // 에서 요약·Q&A 파기). 종전 주석의 "영속화된 세션은 디스크에 유지" 는 persist ON 전제의
  // 안심 문구였고, OFF 사용자에게는 해당되지 않는다. removeOpenTab **전에** 묻는다 — 뒤에서
  // 물으면 취소해도 탭은 이미 목록에서 사라진 뒤다.
  if (isActive && !confirmDiscardIfNotPersisted()) return;

  const tabs = store.openTabs;
  const idx = tabs.findIndex((tb) => tb.filePath === filePath);
  store.removeOpenTab(filePath);

  if (!isActive) return;

  // QA6-C M2: 활성 탭 닫기(flush+이웃 복원)도 전환과 동일 클래스 — 재진입 가드. finally 해제.
  setTabSwitching(true);
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
    setTabSwitching(false);
  }
}

/** 새 탭(+) — 활성 문서를 보존(flush)하고 업로드 화면으로. 탭 목록은 유지 */
export async function openNewTabView(): Promise<void> {
  const store = useAppStore.getState();
  if (!store.document) return; // 이미 업로드 화면
  if (isTabSwitchBlocked()) return;
  // QA24(A-I1): "+" 도 활성 문서를 업로드 화면으로 교체하므로 같은 손실이다.
  if (!confirmDiscardIfNotPersisted()) return;
  // QA6-C M2: flush 중 전환/닫기 인터리브 차단(switchToTab 과 대칭)
  setTabSwitching(true);
  try {
    await persistCurrentSession();
    const s = useAppStore.getState();
    s.setDocument(null);
    s.clearStream();
    s.setSummary(null);
    s.setProgress(0);
  } finally {
    setTabSwitching(false);
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
