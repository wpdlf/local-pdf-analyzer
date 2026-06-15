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

/** 생성/파싱 중 전환 차단 — handlePdfData 내부 가드와 동일 기준 (사전 차단으로 UX 개선) */
export function isTabSwitchBlocked(): boolean {
  const s = useAppStore.getState();
  return s.isGenerating || s.isQaGenerating || s.isParsing;
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
 * 재사용해 즉시 전환하고, 뷰어용 원본 바이트만 파싱 없이 파일에서 읽어 주입한다.
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
 * 영속 세션에서 탭을 복원 — 재파싱 없이 즉시 전환. 뷰어용 원본 바이트는 파싱 없이 파일만
 * 읽어 주입(읽기 실패 시 뷰어만 비활성, 분석은 그대로 복원). 세션 부재/손상 시 false.
 */
async function restoreTabFromSession(tab: OpenTab): Promise<boolean> {
  if (!tab.docHash) return false;
  const loaded = await window.electronAPI.session.load(tab.docHash).catch(() => null);
  const session = loaded?.session as PersistedSession | undefined;
  if (!session || typeof session.extractedText !== 'string' || !Array.isArray(session.pageTexts)) {
    return false;
  }

  // 뷰어용 원본 바이트: 파일만 읽음(파싱 없음 — 빠름). 실패해도 분석 복원은 진행(뷰어만 비활성).
  let pdfBytes: Uint8Array | null = null;
  const fileRes = await window.electronAPI.file.openPath(tab.filePath).catch(() => null);
  if (fileRes && !('error' in fileRes)) {
    try { pdfBytes = new Uint8Array(fileRes.data); } catch { pdfBytes = null; }
  }

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
  s.setPdfBytes(pdfBytes);
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

  // 현재 문서의 미저장 tail 보존 (persistChain 직렬화 — 내부에서 생성 중/게이트 검사)
  await persistCurrentSession();

  const ok = await openTabTarget(tab);
  if (!ok) {
    useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: t('tabs.switchFail') });
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

  const tabs = store.openTabs;
  const idx = tabs.findIndex((tb) => tb.filePath === filePath);
  store.removeOpenTab(filePath);

  if (!isActive) return;

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
}

/** 새 탭(+) — 활성 문서를 보존(flush)하고 업로드 화면으로. 탭 목록은 유지 */
export async function openNewTabView(): Promise<void> {
  const store = useAppStore.getState();
  if (!store.document) return; // 이미 업로드 화면
  if (isTabSwitchBlocked()) return;
  await persistCurrentSession();
  const s = useAppStore.getState();
  s.setDocument(null);
  s.clearStream();
  s.setSummary(null);
  s.setProgress(0);
}
