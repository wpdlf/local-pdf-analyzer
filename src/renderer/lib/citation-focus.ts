// QA14(D-MED): 인용 패널 닫힘 시 포커스를 트리거였던 CitationButton 으로 반환하기 위한 모듈
// 스코프 홀더. 인용 `[p.N]` 클릭 → 우측 PdfViewer 패널이 열리는데, ✕/Escape 로 닫으면 패널이
// 언마운트되며 포커스가 <body> 로 유실돼 키보드/SR 사용자가 긴 요약에서 읽던 위치를 잃었다
// (앱의 다른 뷰 전환·요약 접기는 포커스를 반환하는데 인용 패널만 누락). Zustand 에 DOM 노드를
// 담지 않도록 별도 모듈로 분리: 트리거=CitationButton, 복원=PdfViewerPanel.
let returnEl: HTMLElement | null = null;

/** 인용 클릭 시 트리거 버튼을 기록(패널 닫힘 후 이 요소로 포커스 반환). */
export function setCitationReturnFocus(el: HTMLElement | null): void {
  returnEl = el;
}

/** 인용 패널 닫힘 시 호출 — 기록된 트리거가 아직 DOM 에 있으면 포커스 반환. 1회성(소비 후 클리어). */
export function restoreCitationFocus(): void {
  const el = returnEl;
  returnEl = null;
  if (el && el.isConnected && typeof el.focus === 'function') {
    el.focus();
  }
}
