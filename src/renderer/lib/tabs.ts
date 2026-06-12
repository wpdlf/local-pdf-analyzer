import { useAppStore } from './store';
import { handlePdfData } from './pdf-parser';
import { persistCurrentSession } from './use-session';
import { t } from './i18n';

/**
 * 다중 문서 탭 오케스트레이션 (multi-doc Phase 1).
 *
 * 설계: 무거운 상태(요약/Q&A/RAG 인덱스/pdfBytes)는 활성 문서 1개만 메모리에 유지한다.
 * 탭 전환 = ① 현재 세션 강제 flush(디바운스 미발화분 보존) → ② 대상 파일 재오픈
 * (file:open-path — .pdf/심볼릭링크/100MB 보안 가드 동일 적용) → ③ handlePdfData 가
 * 파싱 → 콘텐츠 해시 매칭으로 세션 복원(재요약·재임베딩 0). RecentDocuments 재오픈
 * 흐름과 동일한 경로라 복원 게이트/마커(R44 H-1 계약) 의미론을 그대로 상속한다.
 *
 * UI(TabBar)와 분리한 이유: electronAPI/handlePdfData 모킹으로 단위 테스트 가능하게.
 */

/** 생성/파싱 중 전환 차단 — handlePdfData 내부 가드와 동일 기준 (사전 차단으로 UX 개선) */
export function isTabSwitchBlocked(): boolean {
  const s = useAppStore.getState();
  return s.isGenerating || s.isQaGenerating || s.isParsing;
}

/** 탭 전환 — 이미 활성이면 no-op. 파일 재오픈 실패(이동/삭제/이름만 있는 dev 드롭) 시 에러 배너 + 탭 유지 */
export async function switchToTab(filePath: string): Promise<void> {
  const store = useAppStore.getState();
  if (store.document?.filePath === filePath) return;
  if (isTabSwitchBlocked()) return;

  // ① 현재 문서의 미저장 tail 보존 (persistChain 직렬화 — 내부에서 생성 중/게이트 검사)
  await persistCurrentSession();

  // ② 보안 가드 동일 적용된 재읽기
  const result = await window.electronAPI.file.openPath(filePath);
  if ('error' in result) {
    useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: t('tabs.switchFail') });
    return;
  }

  // ③ 파싱 → 해시 복원 (성공 시 handlePdfData 가 upsertOpenTab 으로 탭 메타 갱신)
  await handlePdfData(result.data, result.name, result.path);
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
  const result = await window.electronAPI.file.openPath(neighbor.filePath);
  if ('error' in result) {
    // 이웃도 재오픈 불가 — 업로드 화면으로 안전 착지 (탭은 유지해 재시도 가능)
    const s = useAppStore.getState();
    s.setDocument(null);
    s.clearStream();
    s.setSummary(null);
    s.setProgress(0);
    s.setError({ code: 'PDF_PARSE_FAIL', message: t('tabs.switchFail') });
    return;
  }
  await handlePdfData(result.data, result.name, result.path);
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
