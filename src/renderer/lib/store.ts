import { create } from 'zustand';
import type {
  PdfDocument,
  Summary,
  DefaultSummaryType,
  ActiveSummaryType,
  AppSettings,
  OllamaStatus,
  AppError,
  QaMessage,
  ProgressInfo,
  RagIndexState,
} from '../types';
import type { OpenTab, CollectionState } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { VectorStore } from './vector-store';
import { sanitizeErrorPath } from './error-sanitize';
import { persistCurrentSession } from './use-session';

// 설정 저장 IPC 디바운스 타이머
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
// C5-M3(QA cycle5): 설정 IPC 커밋 대기자. 렌더러 store 는 즉시 갱신되지만 main settings.json 은
// 300ms 디바운스 뒤에 기록된다 — RAG 빌드처럼 main 이 설정을 읽는 소비자(ai:check-embed-model /
// ai:embed)가 프로바이더 전환 직후 시작되면 구 설정으로 임베딩해 인덱스가 stale/혼합 차원으로
// 오염되는 race. 대기 중 커밋이 있으면 그 완료(성공/실패 무관)까지 resolve 를 지연한다.
let settingsCommitResolve: (() => void) | null = null;
let settingsCommitPromise: Promise<void> = Promise.resolve();
/** 대기 중인 설정 IPC 커밋이 flush 될 때까지 대기. 대기 커밋이 없으면 즉시 resolve. */
export function whenSettingsCommitted(): Promise<void> {
  return settingsCommitPromise;
}
/**
 * 패널 비율(0.2~0.8)의 localStorage 영속화 — **키별로** 디바운스 + pagehide flush.
 *
 * 드래그 중 pointermove 마다 setter 가 호출되므로 동기 `localStorage.setItem` 이 초당 수백 회
 * 발생한다. trailing 200ms 디바운스로 마지막 값만 쓴다.
 *
 * QA32 후속: 종전에는 `citationPanelWidth` 전용 모듈 싱글턴 3개(타이머·pending·flush 분기)로
 * 되어 있었다. 세로 분할 비율이 추가되면서 그 기계를 복제하는 대신 **키로 일반화**한다 —
 * 열거해 두면 세 번째 비율이 생길 때 flush 대상에서 빠지는 형제 누락이 난다(이 저장소의
 * 최다 결함 클래스). 새 비율은 `persistRatio(key, v)` 만 부르면 flush·리셋에 자동 편입된다.
 */
const ratioSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingRatios = new Map<string, number>();

/** 패널 비율의 상하한 — 한쪽이 사라지지 않도록. ResizeHandle 의 MIN/MAX 와 같은 값이다. */
function clampRatio(ratio: number): number {
  return Math.min(0.8, Math.max(0.2, ratio));
}

/** 저장된 비율을 읽는다. 없거나 범위 밖이면 fallback(= 균등 분할). */
function readStoredRatio(key: string, fallback: number): number {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const v = Number.parseFloat(stored);
      if (Number.isFinite(v) && v >= 0.2 && v <= 0.8) return v;
    }
  } catch { /* 접근 실패 무시 */ }
  return fallback;
}

function persistRatio(key: string, value: number): void {
  const prev = ratioSaveTimers.get(key);
  if (prev) clearTimeout(prev);
  pendingRatios.set(key, value); // pagehide flush 대상
  ratioSaveTimers.set(key, setTimeout(() => {
    ratioSaveTimers.delete(key);
    pendingRatios.delete(key);
    try { localStorage.setItem(key, String(value)); } catch { /* 무시 */ }
  }, 200));
}

/** 디바운스 미발화분을 즉시 커밋 — 종료(pagehide) 경로. */
function flushPendingRatios(): void {
  for (const [key, timer] of ratioSaveTimers) clearTimeout(timer);
  ratioSaveTimers.clear();
  for (const [key, value] of pendingRatios) {
    try { localStorage.setItem(key, String(value)); } catch { /* 무시 */ }
  }
  pendingRatios.clear();
}

/** 테스트/리셋 경로 — 대기 중인 쓰기를 버린다. */
function cancelPendingRatios(): void {
  for (const [, timer] of ratioSaveTimers) clearTimeout(timer);
  ratioSaveTimers.clear();
  pendingRatios.clear();
}

// QA7(B-LOW): pagehide flush 대상 — 디바운스 미발화 pending 값. 앱 종료(Cmd+Q)/새로고침 시
// 300ms(설정)·200ms(패널폭) 발화 전이면 값이 소실됐다(테마/언어 토글 직후 종료 등). 종료
// 직전 pagehide 에서 즉시 커밋한다. localStorage 는 동기라 확실히 저장되고, 설정 IPC 는
// 비동기라 완료 보장은 없으나 best-effort 로 즉시 발화한다.
let pendingSettingsPayload: Record<string, unknown> | null = null;

export function flushPendingWrites(): Promise<void> {
  flushPendingRatios();
  // QA24(I5): 설정 IPC 착지를 기다린다. 종전에는 `void` 로 던지고 끝냈는데, 종료 handshake 는
  // 세션 persist promise 만 기다리므로 — 문서를 열지 않은 상태에서는 doPersistCurrentSession 이
  // 즉시 return 해 ack 가 곧바로 나가고 app.quit() 이 진행된다. 그 결과 "설정 화면에서 커스텀
  // 템플릿을 저장하고 곧바로 종료" 하면 300ms 디바운스분이 디스크에 닿지 못한 채 사라졌다.
  // QA10 이 세션에 대해 정확히 이 문제를 해결했는데 설정만 best-effort 로 남아 있었다.
  let settingsFlushed: Promise<void> = Promise.resolve();
  if (settingsSaveTimer !== null) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    // QA24(C-H1): 로드 실패로 봉인된 상태면 flush 도 하지 않는다 — 종료 경로가 게이트를
    // 우회하면 updateSettings 에서 막은 덮어쓰기가 그대로 성사된다(형제 누락 차단).
    const sealed = useAppStore.getState().settingsLoadFailed;
    if (!sealed && pendingSettingsPayload !== null && typeof window !== 'undefined' && window.electronAPI?.settings?.set) {
      try {
        settingsFlushed = Promise.resolve(window.electronAPI.settings.set(pendingSettingsPayload))
          .then(() => undefined, () => undefined);
      } catch { /* best-effort */ }
    }
    pendingSettingsPayload = null;
    // 대기자 settle — flush 로 타이머가 사라진 promise 를 영원히 대기하는 소비자 방지
    if (settingsCommitResolve) { settingsCommitResolve(); settingsCommitResolve = null; }
  }
  // QA8(A+C 수렴 MED): 세션 자동저장(요약·Q&A·RAG 인덱스)은 1500ms 디바운스라, 답변/요약/인덱싱
  // 완료 직후 종료(Cmd+Q)·새로고침(Ctrl+R)하면 useSessionPersistence 의 effect cleanup 이
  // 타이머만 clear 하고 persist 없이 소멸 → 마지막 턴/요약/인덱스가 소실됐다(≤1.5s, 비파괴적).
  // 저가치 데이터(테마·폭)는 flush 하면서 고가치 세션은 누락된 비대칭 해소. best-effort 로
  // 즉시 발화 — persistCurrentSession 은 실행 시점 getState() 를 읽는 직렬화 체인이고, 내부에서
  // 복원대기/컬렉션busy/persistSessions OFF 를 스스로 skip 하므로 여기서 무조건 호출해도 안전.
  // QA10(C-MED): persist 완료 promise 를 반환한다. 새로고침(pagehide)엔 이 반환이 무시되지만,
  // 종료 handshake(onFlushBeforeQuit)는 이 promise 착지를 기다린 뒤 ack 하여 main 이 persist 가
  // 디스크에 닿을 때까지 quit 을 보류한다(기존 pagehide 는 async 라 클라우드/외부 Ollama 사용자에서
  // ollamaManager.stop() 즉시리턴에 quit 이 persist 를 앞질러 마지막 델타를 소실했음).
  // QA12(B-MED): flush=true 로 호출 — 디바운스 경로는 생성 중 skip 하지만, 종료/새로고침 flush 는
  // 이미 커밋된 완성 요약·완료 Q&A턴을 committed-only 로 저장한다(요약 완료 직후 후속 질문 →
  // 종료 시 완성 요약 소실 창 제거). partial 스트림·trailing lone-user 는 doPersist 가 정규화.
  let persisted: Promise<void> = Promise.resolve();
  try { persisted = persistCurrentSession(true); } catch { /* best-effort */ }
  // QA24(I5): 세션과 설정 **둘 다** 착지한 뒤 ack — 어느 한쪽만 기다리면 나머지가 종료에 잘린다.
  return Promise.all([persisted, settingsFlushed]).then(() => undefined);
}

// QA10(C-MED): 종료 handshake 리스너. main 의 before-quit 이 app:flush-before-quit 를 보내면
// flush(설정·패널폭·세션 persist)를 수행하고 착지 후 flushBeforeQuitDone 으로 ack 한다. main 은
// ack 또는 하드 타임아웃까지 quit 을 보류하므로 무응답이어도 앱이 멈추지 않는다. 테스트/비-electron
// 환경(electronAPI.onFlushBeforeQuit 미존재)에서는 등록을 건너뛴다.
let flushBeforeQuitUnsub: (() => void) | null = null;
if (typeof window !== 'undefined' && window.electronAPI?.onFlushBeforeQuit) {
  flushBeforeQuitUnsub = window.electronAPI.onFlushBeforeQuit(() => {
    const ack = () => {
      try { window.electronAPI.flushBeforeQuitDone?.(); } catch { /* best-effort */ }
    };
    // flushPendingWrites 는 persist 완료 promise 를 반환 → 착지(성공/실패 무관) 후 1회 ack.
    Promise.resolve(flushPendingWrites()).then(ack, ack);
  });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // pagehide: 탭/창 종료·새로고침 직전 동기 실행 창(unload 보다 신뢰성 높음). 중복 등록은
  // HMR dispose 에서 해제.
  window.addEventListener('pagehide', flushPendingWrites);
}

// v0.18.22 R36 P4: 모듈 스코프 notice 타이머 — 기존엔 useAppStore 생성부 이후 (line 507) 에
// 선언되었으나 HMR dispose 핸들러(line 77) 와 setNotice (store 내부) 양쪽이 module init
// 후 closure 로 접근하므로 동작은 정상이었다. 다른 디바운스 타이머와 동일 영역에 배치하여
// "store 위쪽 타이머 / store 아래쪽 ...?" 라는 시각적 비대칭만 정리. 런타임 영향 없음.
const NOTICE_DISMISS_MS = 6000;
let noticeDismissTimer: ReturnType<typeof setTimeout> | null = null;

// crypto.randomUUID 는 secure context 에서만 동작. Electron file:// 는 secure context 로
// 간주되어 정상 동작하지만, 드물게 비정상 origin 또는 구 버전에서 throw 할 수 있음.
// 실패 시 충돌 가능성이 낮은 대체 식별자 생성.
function safeRandomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* fallthrough */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * in-flight AI 요청 abort (v0.18.20 R32 P2). 문서 교체 시 main 의 generator 가 계속 토큰을
 * yield 하면 두 세션 토큰이 인터리브되는 cross-session contamination 이 발생하고, 클라우드는
 * 버려질 응답에 계속 과금된다. 여기서 IPC 를 즉시 끊어 둘 다 차단한다.
 *
 * QA21(B-MED): resetSummaryState 안에 인라인돼 있던 것을 함수로 분리했다 — clearQa 도 같은
 * 처리가 필요한데(문서 교체 경로에서 resetSummaryState 보다 **먼저** 실행되며 qaRequestId 를
 * 지운다) 로직이 한쪽에만 있어 abort 가 유실됐다.
 *
 * window.electronAPI 가 없는 테스트 환경에서는 silent no-op.
 */
/**
 * **문서 교체가 진행 중이거나 임박한 상태** — 이 창에서 시작한 생성 작업(요약·질문·교차요약)은
 * 폐기되거나 **디스크의 기존 데이터를 파괴한다**. 모든 생성 진입 가드와 UI 비활성 조건은
 * 개별 플래그를 열거하지 말고 이 술어 하나를 쓴다.
 *
 * QA22(A-MED): 이 함수가 존재하는 이유는 **같은 결함이 세 사이클 연속 재발했기 때문**이다.
 *  - QA20: 요약 버튼에만 `isParsing` 을 넣고 Q&A·컬렉션을 빠뜨림
 *  - QA21: `isParsing`+`isTabSwitching` 을 넣으면서 `sessionRestorePending` 을 빠뜨림
 * 매번 "이번엔 다 훑었다" 고 판단했고 매번 하나가 남았다. 플래그를 하나씩 열거하는 방식이
 * 구조적으로 실패한다는 뜻이므로, 새 플래그가 생기면 **여기 한 곳만** 고치도록 모은다
 * (window-flush-policy.ts 가 QA16→17→18 3연속 결함 후 같은 방식으로 종결된 선례).
 *
 * 세 플래그가 덮는 구간이 서로 다르다는 점이 핵심이다:
 *  - `isParsing`            — 파싱 중(교체 **예정**). setDocument 전.
 *  - `isTabSwitching`       — 탭 전환 중(교체 예정). 세션-우선 복원은 isParsing 을 쓰지 않는다.
 *  - `sessionRestorePending`— 교체 **직후**, 복원(api.load)이 아직 진행 중. 앞의 둘은 이미 false 다.
 *    이 창에서 질문하면 `isQaGenerating` 때문에 복원의 `setQaMessages` 가 skip 되어 옛 대화가
 *    메모리에 오르지 못하고, 이어지는 자동저장이 `qaMessages` 를 **통째 교체**(요약과 달리 머지
 *    대상이 아니다)해 디스크의 대화를 파괴한다.
 *
 * ⚠️ 부작용 인지: `sessionRestorePending` 이 고착되면(session:load IPC 가 영영 resolve 되지 않는
 * 경우) 생성 기능이 전부 막힌다. 기존에도 그 상태에서 RAG 빌드가 영구 보류였으므로 새로운
 * 실패 모드는 아니지만 영향 범위는 넓어졌다. 복원은 정상 경로에서 수백 ms 안에 끝난다.
 */
export function isDocSwapPending(
  s: Pick<AppState, 'isParsing' | 'isTabSwitching' | 'sessionRestorePending' | 'collectionOpenInFlight'>,
): boolean {
  // QA28(B-Important): 문서 교체 구간을 잠그는 store 플래그는 **넷**인데 이 술어엔 셋뿐이었다.
  // openCollection 은 첫 멤버 복원으로 document 를 세운 뒤에도 남은 멤버의 session.load 루프를
  // 계속 돌고, 그 창에서 sessionRestorePending 은 이미 내려가 있어 요약/Q&A 시작이 통과했다
  // (isTabSwitchBlocked 는 막는데 이 술어만 안 막는 구간). 두 술어의 "교체 예정" 집합을 일치시킨다.
  return s.isParsing || s.isTabSwitching || s.sessionRestorePending || s.collectionOpenInFlight;
}

function abortInFlightAiRequests(...requestIds: (string | null | undefined)[]): void {
  const electronAPI = (globalThis as { window?: { electronAPI?: { ai?: { abort?: (id: string) => Promise<unknown> } } } })
    .window?.electronAPI;
  if (!electronAPI?.ai?.abort) return;
  for (const id of requestIds) {
    if (id) electronAPI.ai.abort(id).catch(() => {});
  }
}

// appendStream 배치 처리용 버퍼 (50ms 간격 flush)
// 캡슐화하여 HMR/테스트 시 안전한 리셋 지원
const streamState = {
  buffer: '',
  flushTimer: null as ReturnType<typeof setTimeout> | null,
  cleared: false,
  reset() {
    this.buffer = '';
    this.cleared = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  },
};

// Q&A 스트림 배치 버퍼 (요약 버퍼와 격리)
const qaStreamState = {
  buffer: '',
  flushTimer: null as ReturnType<typeof setTimeout> | null,
  cleared: false,
  reset() {
    this.buffer = '';
    this.cleared = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  },
};

// HMR 시 이전 모듈의 타이머 정리 (고스트 토큰 방지)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _meta = import.meta as any;
if (_meta.hot) {
  _meta.hot.dispose(() => {
    streamState.reset();
    qaStreamState.reset();
    if (settingsSaveTimer) { clearTimeout(settingsSaveTimer); settingsSaveTimer = null; }
    // 커밋 대기자 settle — dispose 로 타이머가 사라진 promise 를 영원히 대기하는 소비자 방지
    if (settingsCommitResolve) { settingsCommitResolve(); settingsCommitResolve = null; }
    cancelPendingRatios();
    // R31 (v0.18.18 patch): noticeDismissTimer HMR 누락 — 이전 store 인스턴스의 6초
    // 타이머가 fire 하면 새 store 의 notice 를 잘못 dismiss 하려 시도하므로 같이 정리.
    if (noticeDismissTimer) { clearTimeout(noticeDismissTimer); noticeDismissTimer = null; }
    // QA7: pending flush 상태 + pagehide 리스너 정리(이전 모듈 인스턴스 누수 방지).
    pendingSettingsPayload = null;
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', flushPendingWrites);
    }
    // QA10(C-MED): 종료 handshake IPC 리스너도 해제(이전 인스턴스 중복 ack 방지).
    if (flushBeforeQuitUnsub) { flushBeforeQuitUnsub(); flushBeforeQuitUnsub = null; }
  });
}

interface AppState {
  // PDF
  document: PdfDocument | null;
  isParsing: boolean;
  setDocument: (doc: PdfDocument | null) => void;
  setIsParsing: (v: boolean) => void;

  // 다중 문서 탭 (multi-doc Phase 1) — 메타데이터만 보관, 무거운 상태는 활성 문서 단일 유지.
  // 활성 탭 = document?.filePath 파생 (별도 state 없음 — drift 원천 차단).
  openTabs: OpenTab[];
  /** 성공 로드 시 탭 등록/갱신 — filePath 중복이면 메타만 갱신 (탭 순서 유지) */
  upsertOpenTab: (tab: OpenTab) => void;
  /** 이미 열려 있는 탭의 필드만 갱신 — 없으면 no-op(닫힌 탭을 되살리지 않는다). */
  patchOpenTab: (filePath: string, patch: Partial<OpenTab>) => void;
  /** 탭 목록에서 제거만 담당 — 활성 문서 정리/이웃 전환은 lib/tabs.ts 가 오케스트레이션 */
  removeOpenTab: (filePath: string) => void;

  // 다중 문서 컬렉션 Q&A (multi-doc Phase 2) — 여러 문서에 걸친 교차 RAG 검색 대상 선택.
  collection: CollectionState;
  /** 컬렉션 Q&A 모드 on/off. on 전환 시 멤버 목록은 호출자(UI)가 기본값으로 채운다. */
  setCollectionEnabled: (enabled: boolean) => void;
  /** 질의 대상 멤버 docHash 목록 교체 */
  setCollectionMembers: (memberHashes: string[]) => void;
  setSavedCollection: (saved: { id: string; name: string } | null) => void;
  /** 단일 멤버 포함/제외 토글 (체크박스) */
  toggleCollectionMember: (docHash: string) => void;
  // 교차 요약 "준비(gather) 단계" 표식 — generateCollectionSummary 가 setIsQaGenerating(true) 를
  // gather 뒤에야 세팅하던 사이, 입력창·버튼이 활성으로 남아 handleAsk/handleSummarize 가 끼어들어
  // qaStream/qaRequestId 를 클로버링하던 race 차단(QA R: 컬렉션 요약 동시성). 진입 즉시 동기 세팅.
  isCollectionBusy: boolean;
  setCollectionBusy: (v: boolean) => void;
  // C5-M4(QA cycle5): openCollection(탭 세트 재구성) 진행 표식. 기존 tabs.ts 모듈 플래그는
  // isTabSwitchBlocked 만 볼 수 있어, 그 경로를 거치지 않는 문서 열기(드롭/최근문서/전역검색/
  // Ctrl+O → handlePdfData 직행)가 컬렉션 복원 루프와 인터리브돼 탭 세트가 뒤섞였다.
  // store 로 옮겨 handlePdfData 진입 가드에서도 참조한다(zustand set 은 동기 — 가드 의미 동일).
  collectionOpenInFlight: boolean;
  setCollectionOpenInFlight: (v: boolean) => void;
  /**
   * QA21(B/A-MED, 데이터손실): 탭 전환/닫기/새 탭(+) 진행 표식. 위 collectionOpenInFlight 와
   * **같은 사유의 두 번째 이관**이다 — tabs.ts 의 모듈 로컬 플래그는 store 밖이라 훅(useSummarize/
   * use-qa/use-collection-summary)과 UI(TabBar)가 볼 수 없었다. 그래서 세션-우선 복원 경로
   * (isParsing 을 세우지 않는다)의 `await persistCurrentSession()` → `await session.load()`
   * (index.bin 수 MB) 두 await 동안 요약/질문 버튼이 살아 있었고, 거기서 시작한 작업은
   * 복원이 끝나며 clearStream/clearQa/setDocument 로 조용히 폐기됐다.
   *
   * ⚠️ handlePdfData 는 이 플래그를 참조해선 안 된다 — openTabTarget 의 파일 재파싱 fallback 이
   * handlePdfData 를 호출하므로 자기 차단이 된다(tabs.ts 상단 주석의 제약을 그대로 유지).
   */
  isTabSwitching: boolean;
  setTabSwitching: (v: boolean) => void;

  // 요약
  summary: Summary | null;
  summaryStream: string;
  /** QA18(A-MED): summaryStream 을 생성한 요약 타입(영속 저장 키의 단일 출처). */
  summaryStreamType: ActiveSummaryType | null;
  /**
   * QA20(C-MED, 데이터손실): 현재 summaryStream 이 **완주한 요약**인가.
   *
   * 저장 자격 판정에 쓴다. 기존 방어(`persistCommitted = flush && isGenerating`)는 종료·새로고침
   * flush 경로에만 있었는데, 중지·타임아웃·실패는 `setIsGenerating(false)` 를 **먼저** 실행하므로
   * 그 뒤의 일반 자동저장(디바운스)이 부분 스트림을 "완성본"으로 오인해 **같은 타입의 기존 완성
   * 요약을 디스크에서 덮어썼다**(재요약 중지 한 번으로 원본 소실).
   *
   * false → 미완주(run 시작 직후·중단·실패). true → 성공 커밋(setSummary) 또는 세션 복원본.
   */
  summaryStreamComplete: boolean;
  summaryType: ActiveSummaryType;
  // 페이지 범위 요약 — null 이면 전체. {start,end} 는 1-based inclusive. 문서 전환 시 리셋.
  summaryPageRange: { start: number; end: number } | null;
  isGenerating: boolean;
  currentRequestId: string | null;
  progress: number;
  progressInfo: ProgressInfo | null;
  // H1(UX): 요약 뷰어 비파괴적 접기. ✕ 닫기가 문서·요약·Q&A 를 전부 버리던(resetSummaryState→
  // document:null) 결함을 대체 — collapse 시 상태는 보존하고 뷰어만 숨겨 문서 화면에서 재진입한다.
  summaryCollapsed: boolean;
  setSummaryCollapsed: (v: boolean) => void;
  setSummary: (summary: Summary | null) => void;
  appendStream: (token: string) => void;
  flushStream: () => void;
  /**
   * QA18(A-MED): 현재 summaryStream 을 생성한 요약 타입. 영속화 시 저장 키의 단일 출처다.
   * 인자를 주면 스트림을 비우면서 소유 타입을 함께 등록한다(요약 run 시작 시).
   */
  clearStream: (ownerType?: ActiveSummaryType | null) => void;
  /** 후처리된 전체 내용으로 summaryStream을 교체. 호출 전에 반드시 flushStream() 수행. */
  replaceSummaryStream: (content: string) => void;
  setSummaryType: (type: ActiveSummaryType) => void;
  setSummaryPageRange: (range: { start: number; end: number } | null) => void;
  setIsGenerating: (v: boolean) => void;
  setCurrentRequestId: (id: string | null) => void;
  setProgress: (p: number) => void;
  setProgressInfo: (info: ProgressInfo | null) => void;
  resetSummaryState: () => void;

  // Q&A
  qaMessages: QaMessage[];
  qaStream: string;
  isQaGenerating: boolean;
  qaRequestId: string | null;
  // v0.18.0: 답변 검증 단계(초안 생성 + RAG 대조) 중 UI 에 "답변 준비 중..." 인디케이터 표시용.
  // qaStream 은 draft 를 담지 않음 — verifying=true 인 동안 사용자에게 표시되는 건 스피너뿐.
  // refine 단계 또는 good-draft flush 시 qaStream 이 채워지면서 verifying=false 로 전환.
  qaVerifying: boolean;
  addQaMessage: (msg: Omit<QaMessage, 'id'>) => void;
  // session-persistence: 복원 시 Q&A 대화 일괄 복원 (id 보존)
  setQaMessages: (messages: QaMessage[]) => void;
  appendQaStream: (token: string) => void;
  flushQaStream: () => void;
  clearQaStream: () => void;
  setIsQaGenerating: (v: boolean) => void;
  setQaRequestId: (id: string | null) => void;
  setQaVerifying: (v: boolean) => void;
  clearQa: () => void;

  // RAG
  ragIndex: VectorStore;
  ragState: RagIndexState;
  setRagState: (state: Partial<RagIndexState>) => void;
  // session-persistence: 복원 시 직렬화된 인덱스로 VectorStore 인스턴스 교체 (재임베딩 0)
  setRagIndex: (vs: VectorStore) => void;
  // 복원 결정(session.load) 동안 useRagBuilder 의 자동 재임베딩을 보류시키는 게이트.
  // 문서 로드 직후 true, 복원 hit(인덱스 주입)/miss(정상 빌드) 결정 후 false.
  sessionRestorePending: boolean;
  setSessionRestorePending: (v: boolean) => void;
  // QA31(C-High): 복원이 **실패**했음을 남기는 파생 상태. sessionRestorePending 은 "복원이
  // 진행 중" 만 뜻하고 성공/실패를 구분하지 않아서, api.load 가 throw 하면 게이트만 열린 채
  // 메모리는 빈 상태(qaMessages=[])로 남았다. 그 뒤 자동저장이 디스크를 덮어쓰는데 요약은
  // loadMeta 머지가 살리고 qaMessages 는 머지 대상이 아니라 **대화만 조용히 소실**됐다.
  // preserveDiskIndex 가 인덱스에 대해 하는 일(메모리가 진실이 아닐 때 디스크를 보존)을
  // 세션 전체에 대해 한다. 복원 시도마다 false 로 리셋되고, 실패 시에만 true 가 된다.
  sessionRestoreFailed: boolean;
  setSessionRestoreFailed: (v: boolean) => void;
  // 복원된 인덱스 마커 — useRagBuilder 가 같은 doc+provider 면 재빌드를 skip (재임베딩 0 보장).
  restoredSession: { docId: string; provider: string; embedModel: string | null } | null;
  setRestoredSession: (v: { docId: string; provider: string; embedModel: string | null } | null) => void;

  // Page citation (Design Ref: §4.2) — page-citation-viewer 기능
  // null 이면 PdfViewer 패널 비활성, { page: N } 이면 해당 페이지로 스크롤
  citationTarget: { page: number } | null;
  setCitationTarget: (target: { page: number } | null) => void;
  // v0.28.1 M1: 동일 페이지 재점프도 스크롤을 발화시키는 단조 증가 카운터.
  // citationTarget.page 가 원시 숫자라 같은 페이지를 다시 지정하면 PdfViewer scroll effect
  // 의 deps 가 안 바뀌어 재스크롤이 안 됐다(목차에서 현재 대상 페이지 항목 클릭 시 no-op).
  // setCitationTarget(non-null) 마다 증가시켜 effect deps 로 사용한다.
  citationJumpNonce: number;
  // DR-01: 우측 PdfViewer 패널 너비 비율 (0.0 ~ 1.0). SummaryViewer 전체 폭 중
  // 우측 패널이 차지하는 비율. 좌측(요약+Q&A)은 자동으로 1 - 비율.
  // 기본 0.5 (50/50), min 0.2 / max 0.8.
  citationPanelWidth: number;
  setCitationPanelWidth: (ratio: number) => void;
  /**
   * 요약 패널의 **세로** 분할 — 위(요약 본문)가 차지하는 비율. 기본 0.5, 0.2~0.8.
   *
   * 왜 필요한가: 컬렉션 통합/비교 요약의 결과는 `addQaMessage` 로 **채팅 쪽**에 렌더된다.
   * 즉 이 앱에서 가장 긴 출력이 고정 50% 공간에 들어갔고, 요약 접기 토글은 Q&A까지 함께
   * 숨기므로(App.tsx) **채팅을 크게 볼 방법이 하나도 없었다**(실사용 보고, 2026-09-03).
   */
  summarySplitRatio: number;
  setSummarySplitRatio: (ratio: number) => void;
  // 원본 PDF 바이트 (PdfViewer 가 lazy 마운트 시 참조).
  // document 와 라이프사이클 동일 — setDocument(null) / 새 문서 로드 시 교체.
  pdfBytes: Uint8Array | null;
  setPdfBytes: (bytes: Uint8Array | null) => void;

  // Vision 이미지 분석으로 enrich 된 page-level 텍스트. use-summarize 에서 요약 파이프라인
  // 진입 직후 세팅되며, useRagBuilder 는 이 값이 있으면 raw pageTexts 대신 이를 사용해
  // RAG 인덱스를 재빌드한다 — 그 결과 "요약에는 이미지 설명이 있지만 Q&A 검색은 못 봄" 비대칭 해소.
  // 문서 전환(setDocument) 시 자동으로 null 로 초기화.
  enrichedPageTexts: string[] | null;
  // v0.18.19 patch R32 P3: setEnrichedPageTexts 가 호출될 때마다 단조 증가하는 카운터.
  // useRagBuilder 의 fingerprint 가 이전엔 `e${pageTexts.length}` 였는데 length 가 동일한
  // 두 번째 Vision 패스는 동일 fingerprint → 재빌드 트리거 안 됨 (Surface 1 P4). 이 카운터를
  // 사용해 같은 길이/다른 내용의 enrichment 도 감지한다.
  enrichedPageTextsVersion: number;
  setEnrichedPageTexts: (pages: string[] | null) => void;

  // 설정
  settings: AppSettings;
  updateSettings: (settings: AppSettings) => void;
  loadSettings: () => Promise<void>;
  /**
   * QA24(C-H1): settings:get 이 **일시 I/O 오류**로 실패했음을 표시. true 인 동안 저장을 막는다.
   *
   * 왜 필요한가 — main 의 settings:set 도 read 실패 시 쓰기를 중단하지만, 그 가드는 오류가
   * **지속되는 동안만** 유효하다. EBUSY 가 1초 뒤 풀리면 read 는 성공하고, 그때 렌더러가 들고
   * 있는 것은 "로드 실패로 기본값이 된 스토어" 전량이므로 그대로 디스크를 덮어쓴다. 즉 실제
   * 방어선은 렌더러 쪽이다(부재/손상으로 인한 정상 기본값과 구분해야 하므로 플래그가 필요).
   */
  settingsLoadFailed: boolean;

  // OCR
  ocrProgress: { current: number; total: number } | null;
  setOcrProgress: (p: { current: number; total: number } | null) => void;

  // Ollama 상태
  ollamaStatus: OllamaStatus;
  setOllamaStatus: (status: OllamaStatus) => void;

  // UI
  view: 'main' | 'settings' | 'setup';
  setView: (view: 'main' | 'settings' | 'setup') => void;
  error: AppError | null;
  setError: (error: AppError | null) => void;
  // v0.18.6 D1 fix: 에러와 분리된 정보성 notice 채널.
  // 다중 파일 드롭 등 "처리는 정상, 사용자에게 안내만" 케이스에서 setError 채널을 쓰면
  // 후속 setError(null) (파싱 성공 시 pdf-parser 가 호출) 으로 경고가 즉시 지워졌다.
  notice: { message: string } | null;
  setNotice: (notice: { message: string } | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  // PDF
  document: null,
  isParsing: false,
  // 다중 문서 탭 (multi-doc Phase 1)
  openTabs: [],
  upsertOpenTab: (tab) => set((s) => {
    const idx = s.openTabs.findIndex((t) => t.filePath === tab.filePath);
    if (idx === -1) return { openTabs: [...s.openTabs, tab] };
    const next = s.openTabs.slice();
    // QA27(C-Low): 통째 교체가 아니라 **병합**한다. 호출자 4곳 중 pdf-parser 의 성공 경로만
    // docHash 를 넘기지 않는데(해시는 그 뒤 restoreSessionForDocument 가 계산한다), 교체
    // 시맨틱이면 이미 열려 있던 탭을 재파싱할 때 그 탭의 docHash 가 잠시 사라진다. 그 창에서
    // 탭은 openDocHashes(LRU pin)와 컬렉션 후보 어디에도 잡히지 않고, 복원이 upsert 전에
    // 반환·throw 하면 소실이 영구가 된다. 부분 갱신이 기존 필드를 지우지 않게 한다.
    next[idx] = { ...s.openTabs[idx]!, ...tab };
    return { openTabs: next };
  }),
  patchOpenTab: (filePath, patch) => set((s) => {
    // upsert 와 달리 **없으면 만들지 않는다.** 호출부(restoreSessionForDocument)는 이미 등록된
    // 탭에 docHash 를 덧붙이는 것이 목적인데, 그 사이 await 이 있어 사용자가 탭을 닫을 수 있다.
    // upsert 였을 때는 닫은 탭이 되살아났다(QA31 잔여) — 탭 등록은 호출부의 관심사가 아니다.
    const idx = s.openTabs.findIndex((t) => t.filePath === filePath);
    if (idx === -1) return {};
    const next = s.openTabs.slice();
    next[idx] = { ...s.openTabs[idx]!, ...patch };
    return { openTabs: next };
  }),
  removeOpenTab: (filePath) => set((s) => {
    const removed = s.openTabs.find((t) => t.filePath === filePath);
    const openTabs = s.openTabs.filter((t) => t.filePath !== filePath);
    // 닫힌 탭의 docHash 를 컬렉션 멤버에서도 제거 — 닫은 문서가 조용히 검색되거나
    // memberHashes 가 openTabs 와 어긋나 stale 상태로 남는 것을 방지.
    let collection = s.collection;
    if (removed?.docHash && collection.memberHashes.includes(removed.docHash)) {
      collection = { ...collection, memberHashes: collection.memberHashes.filter((h) => h !== removed.docHash) };
    }
    // 컬렉션 후보(docHash 보유 탭)가 2개 미만이면 컬렉션 모드 초기화 — CollectionBar 는
    // candidates<2 에서 렌더되지 않아(토글 UI 소멸) enabled 가 잔존하면 끌 방법이 없고,
    // resolveCollectionSearch 가 컬렉션 경로로 진입해 모든 답변에 오도성 강등 경고가 붙는다
    // (QA6-C M1: 탭 2→1 축소 유령 활성). 0개(전체 닫힘) 리셋의 일반화 — 다음 묶음 누수 방지 겸용.
    // (탭 전환/+ 새 탭은 openTabs 가 줄지 않으므로 컬렉션 상태 유지)
    const candidateCount = openTabs.filter((t) => t.docHash).length;
    // QA23(A/D-MED): 해제 조건이 enabled·memberHashes 만 봐서, **저장된 컬렉션을 열자마자의
    // 정상 상태**(둘 다 비어 있고 saved 만 있음)에서는 리셋이 아예 실행되지 않았다. 그 결과 탭을
    // 전부 닫아도 소속이 남아, 이후 무관한 문서를 열어 저장하면 이름이 프리필된 채 같은 id 로
    // upsert 돼 원본 컬렉션 멤버가 통째로 교체됐다(회수 불가). saved 도 해제 트리거에 포함한다.
    if (candidateCount < 2 && (collection.enabled || collection.memberHashes.length > 0 || collection.saved)) {
      // saved 도 함께 버린다 — 복원된 세트가 해체된 뒤의 저장은 "그 컬렉션의 갱신"이 아니다.
      collection = { enabled: false, memberHashes: [] };
    }
    return { openTabs, collection };
  }),

  // 다중 문서 컬렉션 Q&A (multi-doc Phase 2)
  collection: { enabled: false, memberHashes: [] },
  setCollectionEnabled: (enabled) => set((s) => ({
    collection: { ...s.collection, enabled },
  })),
  setCollectionMembers: (memberHashes) => set((s) => ({
    collection: { ...s.collection, memberHashes },
  })),
  // 저장된 컬렉션에서 탭 세트를 복원했을 때만 설정(재저장이 신규 항목이 아니라 갱신이 되도록).
  setSavedCollection: (saved) => set((s) => ({
    collection: saved ? { ...s.collection, saved } : { ...s.collection, saved: undefined },
  })),
  toggleCollectionMember: (docHash) => set((s) => {
    const has = s.collection.memberHashes.includes(docHash);
    const memberHashes = has
      ? s.collection.memberHashes.filter((h) => h !== docHash)
      : [...s.collection.memberHashes, docHash];
    return { collection: { ...s.collection, memberHashes } };
  }),
  isCollectionBusy: false,
  setCollectionBusy: (isCollectionBusy) => set({ isCollectionBusy }),
  collectionOpenInFlight: false,
  setCollectionOpenInFlight: (collectionOpenInFlight) => set({ collectionOpenInFlight }),
  isTabSwitching: false,
  setTabSwitching: (isTabSwitching) => set({ isTabSwitching }),
  setDocument: (document) => {
    if (!document) {
      // 문서 닫기 시 RAG 인덱스 + 요약/Q&A 상태 전부 해제. resetSummaryState 와 수렴.
      // 기존에는 summary/summaryStream/qaMessages 가 stale 하게 남아 다른 호출 경로에서
      // 새 문서 없이 이전 요약이 재표시되는 문제가 있었음.
      useAppStore.getState().resetSummaryState();
    } else {
      // R28 P2 (v0.18.12): 새 문서 로드 시에도 resetSummaryState 를 먼저 호출해
      // 이전 문서의 summary / summaryStream / qaMessages / pdfBytes / RAG 인덱스가 stale
      // 상태로 누출되지 않도록 함. 이전에는 호출자가 reset 을 미리 호출하는 것에 암묵적으로
      // 의존했고, 새로운 호출 경로(예: 추후 추가될 IPC drag-drop) 가 그 가드를 잊으면
      // 이전 문서의 요약이 새 문서에 따라붙는 회귀가 가능했다.
      useAppStore.getState().resetSummaryState();
      // resetSummaryState 가 document 를 null 로 비운 직후 새 document 로 교체.
      // Zustand set 은 synchronous 라 두 호출은 같은 batch 로 단일 re-render 만 유발.
      set({ document, enrichedPageTexts: null });
    }
  },
  setIsParsing: (isParsing) => set({ isParsing }),

  // 요약
  summary: null,
  summaryStream: '',
  // QA18(A-MED): summaryStream 을 만든 요약 타입. setSummary 는 성공 완주 시에만 호출되므로
  // s.summary(마지막 성공 커밋)를 스트림의 타입 키로 쓰면 중단·실패 run 에서 영구히 어긋난다.
  summaryStreamType: null,
  // QA20(C-MED): 새 run 이 시작되기 전에는 완주본이 없다.
  summaryStreamComplete: false,
  summaryCollapsed: false,
  setSummaryCollapsed: (summaryCollapsed) => set({ summaryCollapsed }),
  summaryType: 'full',
  summaryPageRange: null,
  isGenerating: false,
  currentRequestId: null,
  progress: 0,
  progressInfo: null,
  // QA20(C-MED): setSummary 는 **성공 완주** 또는 **세션 복원** 시에만 호출된다(중단·타임아웃
  // 경로는 호출하지 않음). 따라서 여기서 스트림을 '완주본'으로 표시하면, 이후 자동저장이
  // 부분 스트림으로 기존 완성 요약을 덮어쓰는 것을 막을 수 있다.
  setSummary: (summary) => set({ summary, summaryStreamComplete: summary !== null }),
  appendStream: (token) => {
    // v0.18.22 R36 P1: 세션이 이미 종료된 상태(isGenerating=false)면 토큰을 무시한다.
    // appendQaStream(R32 P3) 과 대칭 — 사용자 Stop → handleAbort 가 flushStream + setIsGenerating(false)
    // 직후, in-flight for-await 루프가 다음 iteration 의 isGenerating 체크 전에 추가 토큰을
    // append 하면 cleared 가 false 로 reset 되어 50ms flush 가 ghost token 을 summaryStream 으로
    // 흘리던 경로. QA 측 입구 게이트(line 334) 의 미러.
    if (!useAppStore.getState().isGenerating) return;
    streamState.cleared = false;
    streamState.buffer += token;
    if (!streamState.flushTimer) {
      streamState.flushTimer = setTimeout(() => {
        if (streamState.cleared) { streamState.flushTimer = null; return; }
        const buffered = streamState.buffer;
        streamState.buffer = '';
        streamState.flushTimer = null;
        set((s) => ({ summaryStream: s.summaryStream + buffered }));
      }, 50);
    }
  },
  flushStream: () => {
    if (streamState.flushTimer) {
      clearTimeout(streamState.flushTimer);
      streamState.flushTimer = null;
    }
    if (streamState.buffer) {
      const buffered = streamState.buffer;
      streamState.buffer = '';
      set((s) => ({ summaryStream: s.summaryStream + buffered }));
    }
  },
  clearStream: (ownerType) => {
    // cleared 플래그로 이미 dequeue된 flush 타이머 콜백의 실행 방지 (ghost text 방지)
    streamState.cleared = true;
    streamState.buffer = '';
    if (streamState.flushTimer) {
      clearTimeout(streamState.flushTimer);
      streamState.flushTimer = null;
    }
    // QA20(C-MED): 새 run 의 스트림은 완주 전이다 — 저장 자격 초기화.
    set({ summaryStream: '', summaryStreamType: ownerType ?? null, summaryStreamComplete: false });
  },
  replaceSummaryStream: (content) => {
    // 후처리된 전체 내용으로 교체. 이미 flushStream 호출 이후이므로 버퍼 정리만 수행.
    streamState.buffer = '';
    if (streamState.flushTimer) {
      clearTimeout(streamState.flushTimer);
      streamState.flushTimer = null;
    }
    set({ summaryStream: content });
  },
  setSummaryType: (summaryType) => set({ summaryType }),
  setSummaryPageRange: (summaryPageRange) => set({ summaryPageRange }),
  setIsGenerating: (isGenerating) => set({ isGenerating }),
  setCurrentRequestId: (currentRequestId) => set({ currentRequestId }),
  setProgress: (progress) => set({ progress }),
  setProgressInfo: (progressInfo) => set({ progressInfo }),
  resetSummaryState: () => {
    streamState.reset();
    qaStreamState.reset();
    // v0.18.20 R32 P2: in-flight ai 요청 abort. 이전에는 setDocument(newDoc) → resetSummaryState
    // 가 store 플래그만 비우고 main 의 AiClient.summarize generator 는 계속 토큰을 yield 했다.
    // 사용자가 새 문서로 빠르게 질문하면 stale 루프가 새 세션의 qaStream / appendQaStream 으로
    // 토큰을 흘려보내 두 세션 토큰이 인터리브되는 cross-session contamination 발생
    // (R32 Surface 1 P2). 여기서 IPC 를 즉시 끊어 root cause 차단 — 비용(클라우드 토큰)도
    // 같이 절약. window.electronAPI 가 없는 테스트 환경에서는 silent no-op.
    const prevState = useAppStore.getState();
    abortInFlightAiRequests(prevState.qaRequestId, prevState.currentRequestId);
    // RAG 인덱스 초기화
    const { ragIndex } = prevState;
    ragIndex.clear();
    set({
      document: null,
      summaryStream: '',
      summaryStreamType: null,
      // QA20(C-MED): 문서 전환 시 저장 자격도 초기화(이전 문서의 완주 표식 승계 방지).
      summaryStreamComplete: false,
      summaryCollapsed: false,
      summaryPageRange: null, // 페이지 범위는 문서별이므로 전환 시 전체로 리셋
      isGenerating: false,
      progress: 0,
      progressInfo: null,
      summary: null,
      currentRequestId: null,
      qaMessages: [],
      qaStream: '',
      isQaGenerating: false,
      qaRequestId: null,
      qaVerifying: false,
      ocrProgress: null,
      ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
      // 문서 전환 시 PdfViewer 패널도 닫히고 원본 바이트도 해제
      citationTarget: null,
      pdfBytes: null,
      enrichedPageTexts: null,
      // session-persistence: 이전 문서의 복원 마커/게이트 초기화 (stale skip 방지).
      // handlePdfData 는 setDocument 직후 다시 sessionRestorePending=true 로 설정한다.
      restoredSession: null,
      sessionRestorePending: false,
      // 이전 문서의 복원 실패가 새 문서의 저장을 막지 않도록 함께 내린다.
      sessionRestoreFailed: false,
    });
  },

  // Q&A
  qaMessages: [],
  qaStream: '',
  isQaGenerating: false,
  qaRequestId: null,
  qaVerifying: false,
  setQaVerifying: (qaVerifying) => set({ qaVerifying }),
  addQaMessage: (msg) => set((s) => {
    const MAX_QA_TURNS = 10;
    const MAX_MSGS = MAX_QA_TURNS * 2;
    const msgs = [...s.qaMessages, { ...msg, id: safeRandomId() }];
    // v0.18.5 M3 fix: 이전에는 `slice(-MAX_MSGS)` 로 단일 메시지 drop 시
    // 윈도우 선두가 assistant 로 시작하는 orphan 상태가 만들어졌다 (user→assistant
    // 쌍이 깨져 LLM history 주입 시 "질문 없는 답변" 패턴이 컨텍스트 오염).
    // 항상 user→assistant 쌍 단위(짝수)로 drop 하여 정합성 유지.
    if (msgs.length > MAX_MSGS) {
      const excess = msgs.length - MAX_MSGS;
      // 홀수 excess 면 다음 짝까지 추가로 1개 더 drop (pair-align)
      const dropCount = excess + (excess % 2);
      return { qaMessages: msgs.slice(dropCount) };
    }
    return { qaMessages: msgs };
  }),
  appendQaStream: (token) => {
    // v0.18.19 patch R32 P3: 세션이 이미 종료된 상태(isQaGenerating=false)면 토큰을 무시한다.
    // 이전엔 handleQaAbort 가 clearQaStream 으로 cleared=true 를 세팅한 직후라도, in-flight
    // for-await 루프가 next iteration 의 isQaGenerating 체크 전에 추가 토큰을 append 하면
    // cleared 가 false 로 reset 되어 50ms flush 가 ghost token 을 qaStream 에 흘리던 경로
    // (R32 Surface 1 P4). 토큰 입구에서 한 번 더 게이트.
    if (!useAppStore.getState().isQaGenerating) return;
    qaStreamState.cleared = false;
    qaStreamState.buffer += token;
    if (!qaStreamState.flushTimer) {
      qaStreamState.flushTimer = setTimeout(() => {
        if (qaStreamState.cleared) { qaStreamState.flushTimer = null; return; }
        const buffered = qaStreamState.buffer;
        qaStreamState.buffer = '';
        qaStreamState.flushTimer = null;
        set((s) => ({ qaStream: s.qaStream + buffered }));
      }, 50);
    }
  },
  flushQaStream: () => {
    if (qaStreamState.flushTimer) {
      clearTimeout(qaStreamState.flushTimer);
      qaStreamState.flushTimer = null;
    }
    if (qaStreamState.buffer) {
      const buffered = qaStreamState.buffer;
      qaStreamState.buffer = '';
      set((s) => ({ qaStream: s.qaStream + buffered }));
    }
  },
  clearQaStream: () => {
    qaStreamState.cleared = true;
    qaStreamState.buffer = '';
    if (qaStreamState.flushTimer) {
      clearTimeout(qaStreamState.flushTimer);
      qaStreamState.flushTimer = null;
    }
    set({ qaStream: '' });
  },
  setQaMessages: (messages) => set({ qaMessages: messages }),
  setIsQaGenerating: (isQaGenerating) => set({ isQaGenerating }),
  setQaRequestId: (qaRequestId) => set({ qaRequestId }),
  clearQa: () => {
    qaStreamState.reset();
    // QA21(B-MED, 과금): in-flight Q&A 요청을 **id 를 지우기 전에** 끊는다. 호출자는 둘 다 문서
    // 교체 경로(pdf-parser / tabs)인데, 순서가 `clearQa()` → `setDocument()` 라서 뒤이은
    // resetSummaryState 의 abort 가 이미 null 이 된 qaRequestId 를 보고 아무것도 하지 않았다.
    // 그 결과 클라우드 Q&A 요청이 끊기지 않고 완주하며 계속 과금됐다(응답은 버려지므로 순손실).
    abortInFlightAiRequests(useAppStore.getState().qaRequestId);
    set({ qaMessages: [], qaStream: '', isQaGenerating: false, qaRequestId: null, qaVerifying: false });
  },

  // RAG
  ragIndex: new VectorStore(),
  ragState: { isIndexing: false, progress: null, isAvailable: false, model: null, chunkCount: 0, error: null },
  setRagState: (partial) => set((s) => ({ ragState: { ...s.ragState, ...partial } })),
  setRagIndex: (ragIndex) => set({ ragIndex }),
  sessionRestorePending: false,
  setSessionRestorePending: (sessionRestorePending) => set({ sessionRestorePending }),
  sessionRestoreFailed: false,
  setSessionRestoreFailed: (sessionRestoreFailed) => set({ sessionRestoreFailed }),
  restoredSession: null,
  setRestoredSession: (restoredSession) => set({ restoredSession }),

  // Page citation — Design Ref §4.2
  citationTarget: null,
  citationJumpNonce: 0,
  setCitationTarget: (target) =>
    set((s) => ({
      citationTarget: target,
      // 점프 지정(non-null)마다 nonce 증가 → 동일 페이지여도 effect 재발화. 닫기(null)는 유지.
      citationJumpNonce: target ? s.citationJumpNonce + 1 : s.citationJumpNonce,
    })),
  pdfBytes: null,
  setPdfBytes: (bytes) => set({ pdfBytes: bytes }),

  enrichedPageTexts: null,
  enrichedPageTextsVersion: 0,
  // R32 P3: 매 호출마다 version 증가 → useRagBuilder fingerprint 가 길이만 같고 내용이 다른
  // enrichment 도 정확히 감지하여 재빌드 트리거.
  // v0.18.22 R36 P2: 동일 reference(특히 반복적인 null) 호출은 no-op 으로 처리하여 불필요한
  // version bump 를 차단. fingerprint 가 향후 `r` 분기에서 version 을 포함하도록 바뀌어도
  // false-positive 재빌드가 발생하지 않도록 방어적 가드.
  setEnrichedPageTexts: (pages) => set((s) => (
    s.enrichedPageTexts === pages
      ? s
      : { enrichedPageTexts: pages, enrichedPageTextsVersion: s.enrichedPageTextsVersion + 1 }
  )),
  // DR-01: 패널 너비 비율 — localStorage 에서 복원, 기본 0.5
  citationPanelWidth: readStoredRatio('citationPanelWidth', 0.5),
  setCitationPanelWidth: (ratio) => {
    const clamped = clampRatio(ratio);
    set({ citationPanelWidth: clamped });
    persistRatio('citationPanelWidth', clamped);
  },
  summarySplitRatio: readStoredRatio('summarySplitRatio', 0.5),
  setSummarySplitRatio: (ratio) => {
    const clamped = clampRatio(ratio);
    set({ summarySplitRatio: clamped });
    persistRatio('summarySplitRatio', clamped);
  },

  // 설정
  settings: DEFAULT_SETTINGS,
  settingsLoadFailed: false,
  updateSettings: (newSettings) => {
    set({ settings: newSettings as AppSettings });
    // QA24(C-H1): 로드가 일시 I/O 오류로 실패했다면 지금 스토어에 있는 값은 사용자의 설정이
    // 아니라 기본값이다. 이걸 저장하면 디스크의 진짜 설정(커스텀 요약 템플릿 포함, 유일 사본)이
    // 영구 교체된다. 화면 변경은 남기되 **디스크 쓰기만 막고** 사유를 표시한다.
    if (useAppStore.getState().settingsLoadFailed) {
      const lang = useAppStore.getState().settings.uiLanguage;
      set({
        error: {
          code: 'SETTINGS_LOAD_FAIL' as const,
          message: lang === 'en'
            ? 'Settings could not be read, so saving is paused to avoid overwriting them. Restart the app and try again.'
            : '설정을 읽지 못해, 기존 설정을 덮어쓰지 않도록 저장을 중단했습니다. 앱을 다시 시작한 뒤 시도해주세요.',
        },
      });
      return;
    }
    // 디바운스: 빠른 연속 변경 시 마지막 1건만 IPC 전송 (TOCTOU 경쟁 방지)
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    // C5-M3: 커밋 대기자 arm — whenSettingsCommitted() 소비자(RAG 재빌드)가 main settings.json
    // 이 실제로 갱신될 때까지 기다릴 수 있게 한다. 연속 변경은 같은 promise 로 수렴(마지막
    // flush 에서 일괄 settle).
    if (!settingsCommitResolve) {
      settingsCommitPromise = new Promise<void>((resolve) => { settingsCommitResolve = resolve; });
    }
    pendingSettingsPayload = newSettings as unknown as Record<string, unknown>; // pagehide flush 대상
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null;
      pendingSettingsPayload = null;
      // 성공/실패/컨텍스트 소실 모두에서 settle — 소비자는 "커밋 시도가 끝났다"만 알면 된다
      // (실패 시 main 은 구 설정으로 남지만, 에러 배너가 뜨고 다음 변경에서 재시도).
      // QA6-D: 단, 새 pending flush(settingsSaveTimer 비-null)가 있으면 settle 을 그 flush 로
      // 이월 — A 의 IPC in-flight 중 변경 B 가 들어오면 같은 promise 를 공유하는데, A 완료
      // 시점에 settle 하면 B 미커밋 상태에서 whenSettingsCommitted() 가 통과해 구 프로바이더로
      // 임베딩하는 창(C5-M3 가 막으려던 결과)이 남았다.
      const settleCommit = () => {
        if (settingsSaveTimer !== null) return;
        settingsCommitResolve?.();
        settingsCommitResolve = null;
      };
      // 300ms 후 발화 시점에 렌더러 컨텍스트(window/electronAPI)가 이미 사라졌을 수 있다
      // (앱 종료 직전, 테스트 환경 teardown). 동기 ReferenceError(unhandled)를 막기 위해 가드.
      if (typeof window === 'undefined' || !window.electronAPI?.settings?.set) { settleCommit(); return; }
      window.electronAPI.settings.set(newSettings as unknown as Record<string, unknown>).then(settleCommit, () => {
        // store 에서 i18n 모듈을 직접 import 하면 circular dependency 발생 (i18n → store).
        // 대신 store 자체에서 현재 uiLanguage 를 읽어 최소 번역을 inline 으로 수행.
        const lang = useAppStore.getState().settings.uiLanguage;
        const message = lang === 'en'
          ? 'Failed to save settings. Please try again.'
          : '설정 저장에 실패했습니다. 다시 시도해주세요.';
        set({ error: { code: 'SETTINGS_SAVE_FAIL' as const, message } });
        settleCommit();
      });
    }, 300);
  },
  loadSettings: async () => {
    try {
      const saved = await window.electronAPI.settings.get();
      set((s) => {
        const merged = { ...s.settings, ...saved } as AppSettings;
        const update: Partial<AppState> = { settings: merged, settingsLoadFailed: false };
        // defaultSummaryType 설정을 summaryType에 반영
        if (merged.defaultSummaryType) {
          update.summaryType = merged.defaultSummaryType;
        }
        return update;
      });
    } catch {
      // QA24(C-H1): main 의 loadSettings 는 이제 **일시 I/O 오류에서만** reject 한다(파일 부재·
      // 손상 JSON 은 종전대로 defaults 를 반환하며 성공한다). 따라서 여기 도달했다는 것은
      // "디스크에 사용자의 설정이 있는데 지금 읽지 못했다"는 뜻이고, 스토어의 기본값은 사용자
      // 설정이 아니다. 저장을 봉인해 덮어쓰기를 막는다(updateSettings 의 게이트).
      set({ settingsLoadFailed: true });
    }
  },

  // OCR
  ocrProgress: null,
  setOcrProgress: (ocrProgress) => set({ ocrProgress }),

  // Ollama 상태
  ollamaStatus: { installed: false, running: false, models: [] },
  setOllamaStatus: (ollamaStatus) => set({ ollamaStatus }),

  // UI
  view: 'main',
  setView: (view) => set({ view }),
  error: null,
  // v0.18.20 R32 P2: 모든 setError 호출에 sanitizeErrorPath 자동 적용.
  // 이전에는 AppErrorBoundary 의 render-time exception 경로만 sanitize 되고,
  // setError({ message: err.message }) 식으로 직접 banner 에 들어가는 경로(App.tsx
  // drop/Ctrl+O, PdfUploader handleFileSelect, store 자체의 SETTINGS_SAVE_FAIL 등)는
  // pdfjs / main process 의 절대경로를 그대로 노출했다 (R32 Surface 3 P2). 중앙집중
  // sanitize 로 미래에 추가될 호출자도 자동 커버.
  setError: (error) => set({
    error: error ? { ...error, message: sanitizeErrorPath(error.message) } : null,
  }),
  notice: null,
  // R30 P2 (v0.18.18): notice 는 사용자에게 영구 표시할 게 아닌 일시적 알림 (다중 파일 드롭
  // 안내 등) 이라 자동 dismiss 가 자연스럽다. 새 setNotice 가 호출되면 이전 타이머는 cancel.
  setNotice: (notice) => {
    if (noticeDismissTimer !== null) {
      clearTimeout(noticeDismissTimer);
      noticeDismissTimer = null;
    }
    set({ notice });
    if (notice !== null) {
      noticeDismissTimer = setTimeout(() => {
        // 타이머 fire 시점에 동일 notice 가 여전히 있는지 비교 — 사이에 새 notice 로 교체된
        // 경우 그것의 타이머에 의존해야 하므로 dismiss 하지 않음.
        if (useAppStore.getState().notice === notice) {
          set({ notice: null });
        }
        noticeDismissTimer = null;
      }, NOTICE_DISMISS_MS);
    }
  },
}));
