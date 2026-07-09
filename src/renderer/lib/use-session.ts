import { useEffect } from 'react';
import { useAppStore } from './store';
import { t } from './i18n';
import { hashDocumentText } from './session-hash';
import { VectorStore } from './vector-store';
import type { PdfDocument, PersistedSession, Summary, ActiveSummaryType, SerializedIndex } from '../types';
import { SESSION_SCHEMA_VERSION, type SessionSaveMeta } from '../../shared/session-types';

/**
 * 세션 영속화 통합 (module-3).
 *
 * Design Ref: §2.2 데이터 흐름. 문서 로드 직후 콘텐츠 해시로 세션을 조회해 요약·Q&A·인덱스를
 * 복원하고(restoreSessionForDocument), 변경이 settle 되면 자동 저장한다(useSessionPersistence).
 *
 * 복원↔자동 재임베딩 경합은 store.sessionRestorePending 게이트로 차단: 문서 로드 시 true 로
 * 설정되어 useRagBuilder 의 자동 빌드를 보류시키고, 복원 hit(인덱스 주입 + restoredSession
 * 마커)/miss(게이트 해제 → 정상 빌드) 결정 후 false 가 된다.
 */

const PERSIST_DEBOUNCE_MS = 1500;

// serialize-skip 시그니처: 디스크 index.bin 과 일치한다고 판단되는 인덱스의 (인스턴스, revision).
// 자동저장이 현재 ragIndex 와 이 시그니처를 비교해 "직전 영속화 이후 무변경"이면 blob 재직렬화/
// 재전송/index.bin 재기록을 생략(keepIndex)한다. WeakRef 로 보관해 교체된 옛 인덱스를 붙들지 않는다
// (인덱스가 GC 되면 deref()→undefined 라 자동으로 불일치=full save 로 안전 폴백).
// 설정 시점: ①전체 blob 저장 성공 직후 ②복원 직후(디스크에서 막 로드해 일치 보장).
let persistedIndexSig: { ref: WeakRef<object>; revision: number } | null = null;

/** 문서 로드 직후 호출 — 세션 복원 시도 후 restore-pending 게이트 해제. */
export async function restoreSessionForDocument(doc: PdfDocument): Promise<void> {
  const store = useAppStore.getState();
  const api = window.electronAPI?.session;
  // 토글 OFF 또는 API 부재(테스트) → 게이트만 해제해 정상 빌드 흐름으로
  if (!store.settings.persistSessions || !api) {
    if (useAppStore.getState().document?.id === doc.id) store.setSessionRestorePending(false);
    return;
  }
  try {
    const docHash = await hashDocumentText(doc.extractedText);
    // multi-doc Phase 1: 탭에 콘텐츠 해시 기록 — 파일 재읽기가 불가능한 탭(이름-경로/파일
    // 이동)도 영속 세션에서 직접 복원해 전환할 수 있게 하는 fallback 키 (tabs.ts).
    useAppStore.getState().upsertOpenTab({
      filePath: doc.filePath, fileName: doc.fileName, pageCount: doc.pageCount, docHash,
    });
    const res = await api.load(docHash);
    // abort-replace 레이스: 그 사이 다른 문서로 교체됐으면 아무것도 건드리지 않음(새 흐름이 관리)
    if (useAppStore.getState().document?.id !== doc.id) return;
    if (!res || !res.session) {
      store.setSessionRestorePending(false);
      return;
    }
    const session = res.session as PersistedSession;
    // Plan SC: 콘텐츠/스키마 무효화 — 불일치 시 복원하지 않고 정상 재계산
    if (session.schemaVersion !== SESSION_SCHEMA_VERSION || session.docHash !== docHash) {
      store.setSessionRestorePending(false);
      return;
    }

    // C5-M2(QA cycle5): 복원 결정(api.load) 이 in-flight 인 동안 사용자가 이미 생성을 시작했으면
    // 요약/Q&A 를 덮어쓰지 않는다. 이전엔 문서 정체성만 검사해, in-flight 요약 위로
    // replaceSummaryStream 이 옛 본문을 주입 → 새 토큰이 그 뒤에 append → "옛+새 연결본"이
    // 완료 요약으로 커밋·영속화됐다(빠른 클릭/느린 디스크에서 재현). 새 run 이 요약의 진실이
    // 되고, 다른 타입의 디스크 요약은 자동저장의 loadMeta 머지가 보존한다.
    // (인덱스 복원은 스트림과 무관하므로 계속 진행 — useRagBuilder 채택/재빌드 결정에 필요.)
    const genState = useAppStore.getState();
    const skipSummaryRestore = genState.isGenerating;
    const skipQaRestore = genState.isQaGenerating || genState.isCollectionBusy;

    // 요약 복원 (현재 summaryType 우선, 없으면 첫 항목).
    // R41 High fix: fallback 으로 다른 타입 요약을 채택할 때는 그 요약의 **실제 타입**으로
    // 라벨링해야 한다. 이전엔 라벨을 session.summaryType 로 고정해 "keywords 탭인데 full 본문"
    // 불일치가 발생했고, 그 stale 조합이 자동저장으로 흘러가 summaries[summaryType]=다른본문 으로
    // 디스크 세션을 손상시켰다.
    let restoredType = session.summaryType;
    let persistedSummary = session.summaries?.[session.summaryType];
    if (!persistedSummary) {
      const firstEntry = Object.entries(session.summaries ?? {})[0];
      if (firstEntry) {
        restoredType = firstEntry[0] as ActiveSummaryType;
        persistedSummary = firstEntry[1];
      }
    }
    // QA6-B: 본문 필드값 검증 — 수기 편집/parseable 손상 세션의 비문자열 content 는 main 스토어의
    // normalize 철학과 비대칭하게 무검증 주입되어, SafeMarkdown ErrorBoundary 렌더 크래시 흡수
    // 이후에도 다음 Q&A 턴의 formatHistory→sanitizePromptInput 이 TypeError 로 턴을 실패시켰다.
    if (persistedSummary && typeof persistedSummary.content !== 'string') {
      persistedSummary = undefined;
    }
    if (persistedSummary && !skipSummaryRestore) {
      const summary: Summary = {
        id: `restored-${doc.id}`,
        documentId: doc.id,
        type: restoredType,
        content: persistedSummary.content,
        model: persistedSummary.model,
        provider: persistedSummary.provider,
        createdAt: new Date(),
        durationMs: 0,
      };
      store.setSummary(summary);
      store.setSummaryType(restoredType);
      store.replaceSummaryStream(persistedSummary.content);
    }

    // Q&A 복원 (C5-M2: in-flight Q&A/컬렉션 스트리밍 위로 덮어쓰지 않음)
    // QA6-B: 항목 정규화 — role/content 가 유효한 메시지만 주입(위 summary 검증과 동일 사유).
    if (!skipQaRestore && Array.isArray(session.qaMessages) && session.qaMessages.length > 0) {
      const validMessages = session.qaMessages.filter((m) =>
        !!m && typeof m === 'object'
        && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string');
      if (validMessages.length > 0) store.setQaMessages(validMessages);
    }

    // 인덱스 복원 — 현재 임베딩 모델과 일치할 때만(불일치 → useRagBuilder 가 재빌드).
    // Plan SC: 재오픈 시 재임베딩 0 (모델 일치 시).
    if (res.blob && session.embedModel && session.embedDim) {
      try {
        const embedCheck = await window.electronAPI.ai.checkEmbedModel();
        if (useAppStore.getState().document?.id !== doc.id) return;
        if (embedCheck.available && embedCheck.model === session.embedModel) {
          const vs = VectorStore.restore({
            model: session.embedModel,
            dimension: session.embedDim,
            chunkMeta: session.chunkMeta ?? [],
            buffer: res.blob,
          });
          store.setRagIndex(vs);
          // serialize-skip baseline: 방금 디스크 index.bin 에서 복원했으므로 디스크와 일치.
          // 첫 자동저장부터 keepIndex 로 불필요한 index.bin 재기록을 피한다.
          persistedIndexSig = { ref: new WeakRef(vs), revision: vs.revision };
          store.setRagState({
            isIndexing: false, progress: null, isAvailable: true,
            model: session.embedModel, chunkCount: vs.size,
          });
          // useRagBuilder 가 같은 doc+provider 면 재빌드 skip 하도록 마커 설정.
          // R41 fix: provider 는 함수 진입 스냅샷(store)이 아니라 마커 설정 직전 최신값을 읽는다 —
          // load+checkEmbedModel 두 await 사이 provider 토글 시 stale provider 가 박혀 잘못된 인덱스를
          // 오채택할 위험 차단.
          store.setRestoredSession({
            docId: doc.id,
            provider: useAppStore.getState().settings.provider,
            embedModel: session.embedModel,
          });
        }
      } catch { /* 블롭 손상/크기 불일치 → 마커 미설정 → 재빌드 */ }
    }

    // 인덱스 복원 여부와 무관하게 게이트 해제 (마커 유무로 skip/build 가 갈림)
    store.setSessionRestorePending(false);
  } catch {
    if (useAppStore.getState().document?.id === doc.id) {
      useAppStore.getState().setSessionRestorePending(false);
    }
  }
}

// R41 fix: persist 직렬화 체인. persistCurrentSession 은 async 본문(load→merge→save)이 await 로
// 겹칠 수 있어, 디바운스만으로는 두 인스턴스가 동시 in-flight 되면 인덱스 메타가 stale 스냅샷으로
// 덮어써질 수 있다(재임베딩 0 위반). 체인으로 순차 실행하면 각 doPersist 가 실행 시점의 최신
// getState() 를 읽어 last-write-wins 가 보장된다.
let persistChain: Promise<void> = Promise.resolve();

// 성능(P1): docHash 는 로드된 문서(doc.id)에 대해 불변(extractedText 의 SHA-256)인데, 자동저장이
// Q&A 턴마다 호출돼 멀티MB 본문을 매번 재해시했다. doc.id 기준 메모로 재계산을 제거한다.
// 탭 전환 왕복도 캐시되도록 작은 Map(상한 32, FIFO evict — 열린 탭 수보다 넉넉)을 둔다.
const docHashCache = new Map<string, string>();
const DOC_HASH_CACHE_MAX = 32;
async function getCachedDocHash(docId: string, extractedText: string): Promise<string> {
  const cached = docHashCache.get(docId);
  if (cached !== undefined) return cached;
  const hash = await hashDocumentText(extractedText);
  docHashCache.set(docId, hash);
  if (docHashCache.size > DOC_HASH_CACHE_MAX) {
    const oldest = docHashCache.keys().next().value;
    if (oldest !== undefined) docHashCache.delete(oldest);
  }
  return hash;
}

/** 현재 store 상태를 세션으로 저장 (best-effort, 직렬화). 생성 중/복원 대기 중에는 skip. */
export function persistCurrentSession(): Promise<void> {
  persistChain = persistChain.then(doPersistCurrentSession, doPersistCurrentSession);
  return persistChain;
}

// E3: 세션 자동저장은 best-effort 라 디스크 포화·권한 거부 등으로 영구 실패해도 무음이었다 →
// 사용자는 정상으로 믿다가 재오픈 시 요약·Q&A·인덱스가 전부 소실(재계산 비용 재발생). 연속 실패가
// 임계치를 넘으면 1회만 notice 로 통지하고, 한 번이라도 성공하면 카운터·통지 플래그를 리셋한다.
// (정상 시 무소음 유지 — 디바운스 저장마다 알림이 뜨는 과알림 방지)
let consecutiveSaveFailures = 0;
let saveFailureNotified = false;
const SAVE_FAILURE_NOTICE_THRESHOLD = 3;
function recordSaveResult(ok: boolean): void {
  if (ok) { consecutiveSaveFailures = 0; saveFailureNotified = false; return; }
  consecutiveSaveFailures++;
  if (consecutiveSaveFailures >= SAVE_FAILURE_NOTICE_THRESHOLD && !saveFailureNotified) {
    saveFailureNotified = true;
    useAppStore.getState().setNotice({ message: t('session.saveFailedNotice') });
  }
}

async function doPersistCurrentSession(): Promise<void> {
  const s = useAppStore.getState();
  const doc = s.document;
  const api = window.electronAPI?.session;
  if (!doc || !s.settings.persistSessions || !api) return;
  // isCollectionBusy(컬렉션 gather) 중에는 활성 문서 자동저장을 보류 — 머지 read(mutex 밖)와
  // 컬렉션 인라인 요약 cross-write 의 TOCTOU lost-update 방지. 명시적 flush(탭전환 등)도 가드.
  if (s.isGenerating || s.isQaGenerating || s.sessionRestorePending || s.isCollectionBusy) return;
  // R43 I-2: ragState.isIndexing 중 부분 인덱스(빌드 중간 청크) 영속화 금지는 유지하되,
  // 전체 skip 은 하지 않는다 — 탭 전환/새 탭(+)의 명시적 flush 가 인덱싱 타이밍에 조용히
  // skip 되면 방금 연 문서의 세션이 디스크에 없어, 경로가 없는 탭(드롭)의 세션 fallback
  // 전환이 실패한다(multi-doc Phase 1 사용자 버그). 인덱싱 중에는 텍스트·요약·Q&A 만
  // 저장하고 인덱스 필드/블롭은 기존 디스크 세션의 것을 보존한다.
  const indexing = s.ragState.isIndexing;
  try {
    const docHash = await getCachedDocHash(doc.id, doc.extractedText);
    if (useAppStore.getState().document?.id !== doc.id) return; // 레이스

    const ragIndex = s.ragIndex;
    const hasIndex = !indexing && ragIndex.size > 0;
    // serialize-skip: 인덱스가 직전 영속화 이후 무변경이고 디스크에 이미 있으면(시그니처 일치)
    // blob 재직렬화/재전송/index.bin 재기록을 생략한다. 불변 인덱스 재처리가 자동저장 비용의
    // 대부분(Q&A 턴마다 멀티MB 벡터 버퍼 재작성)이었다.
    let idxUnchanged =
      hasIndex &&
      persistedIndexSig?.ref.deref() === ragIndex &&
      persistedIndexSig.revision === ragIndex.revision;

    // ── 부분저장 fast-path (Tier3, serialize-skip 의 짝) ──
    // 인덱스 무변경 ⟹ 직전 전체저장/복원으로 디스크에 완전한 session.json+index.bin 이 존재.
    // 불변 본문(extractedText/pageTexts/chunkMeta)·blob 재전송 없이 변하는 qa/summary delta 만
    // 보내고 main 이 디스크 session.json 을 패치한다(IPC ~5MB→~50KB, 렌더러측 loadMeta 읽기도 생략).
    if (idxUnchanged && typeof api.savePartial === 'function') {
      const summaryPatch = (s.summaryStream && s.summary)
        ? { type: s.summary.type, content: s.summaryStream, model: s.summary.model, provider: s.summary.provider }
        : null;
      let partialOk = false;
      try {
        const r = await api.savePartial({
          docHash,
          summary: summaryPatch,
          summaryType: s.summaryType,
          qaMessages: s.qaMessages,
        });
        partialOk = r?.ok === true;
      } catch { partialOk = false; }
      if (partialOk) { recordSaveResult(true); return; }
      // 디스크 세션 부재(LRU evict 등)/실패 → 시그니처 무효화 후 전체 저장으로 재생성(blob 포함).
      persistedIndexSig = null;
      idxUnchanged = false;
    }

    // 기존 세션의 타입별 요약을 머지(다른 요약 타입 보존) + 인덱싱 중이면 기존 인덱스 보존
    let summaries: PersistedSession['summaries'] = {};
    let prevIndex: { embedModel: string; embedDim: number; chunkMeta: PersistedSession['chunkMeta']; blob: ArrayBuffer } | null = null;
    try {
      if (indexing) {
        // 인덱싱 중 flush: 기존 인덱스(blob) 보존이 필요하므로 full load.
        const existing = await api.load(docHash);
        const existSession = existing?.session as PersistedSession | undefined;
        if (existSession?.summaries) summaries = { ...existSession.summaries };
        if (existing?.blob && existSession?.embedModel && existSession.embedDim) {
          prevIndex = {
            embedModel: existSession.embedModel,
            embedDim: existSession.embedDim,
            chunkMeta: existSession.chunkMeta ?? [],
            blob: existing.blob,
          };
        }
      } else {
        // 일반 경로: 머지에 summaries 만 필요 → index.bin(수 MB) 재읽기·구조화복제 생략(성능 P).
        const existing = await (api.loadMeta?.(docHash) ?? api.load(docHash));
        const existSession = existing?.session as PersistedSession | undefined;
        if (existSession?.summaries) summaries = { ...existSession.summaries };
      }
    } catch {
      // QA 정합성: 머지 read 가 실제 I/O 오류로 실패하면(load/loadMeta 가 throw) 디스크엔 유효
      // 세션이 있을 수 있는데, 여기서 그대로 진행하면 타 타입 요약을 빈 {}로 덮어쓰거나(전체저장)
      // 멀쩡한 index.bin 을 삭제(인덱싱 flush, R41 회귀)한다. 파괴적 쓰기 대신 이번 저장을
      // 건너뛰어 디스크를 보존하고, 실패로 집계해 연속 실패 시 통지(다음 디바운스에서 재시도).
      // (부재/손상은 read 함수가 null 로 반환하므로 여기 도달 안 함 — 첫 저장은 정상 진행.)
      recordSaveResult(false);
      return;
    }
    if (s.summaryStream && s.summary) {
      summaries[s.summary.type] = {
        content: s.summaryStream,
        model: s.summary.model,
        provider: s.summary.provider,
      };
    }

    // 인덱스 필드/blob/keepIndex 결정 — 4-상태:
    //  ①idxUnchanged → keepIndex(blob 미전송, 메타만 경량 추출, main 이 index.bin 보존)
    //  ②hasIndex(변경/최초) → 전체 serialize 후 blob 기록
    //  ③indexing → 디스크의 기존 인덱스 보존(prevIndex.blob)
    //  ④그 외(인덱스 없음) → blob:null(main 이 stale index.bin 제거)
    let embedModel: string | null;
    let embedDim: number | null;
    let chunkMeta: PersistedSession['chunkMeta'];
    let blob: ArrayBuffer | null;
    let keepIndex = false;
    let fullSerialized: SerializedIndex | null = null;
    if (idxUnchanged) {
      const m = ragIndex.serializeMeta(); // 벡터 버퍼 생성 없이 chunkMeta/model/dim 만
      embedModel = m.model; embedDim = m.dimension; chunkMeta = m.chunkMeta;
      blob = null; keepIndex = true;
    } else if (hasIndex) {
      fullSerialized = ragIndex.serialize();
      embedModel = fullSerialized.model; embedDim = fullSerialized.dimension; chunkMeta = fullSerialized.chunkMeta;
      blob = fullSerialized.buffer;
    } else if (indexing) {
      embedModel = prevIndex?.embedModel ?? null;
      embedDim = prevIndex?.embedDim ?? null;
      chunkMeta = prevIndex?.chunkMeta ?? [];
      blob = prevIndex?.blob ?? null;
    } else {
      embedModel = null; embedDim = null; chunkMeta = []; blob = null;
    }

    const session: PersistedSession = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      docHash,
      fileName: doc.fileName,
      filePath: doc.filePath,
      pageCount: doc.pageCount,
      extractedText: doc.extractedText,
      pageTexts: doc.pageTexts,
      chapters: doc.chapters,
      isOcr: doc.isOcr,
      summaries,
      summaryType: s.summaryType,
      qaMessages: s.qaMessages,
      embedModel,
      embedDim,
      chunkMeta,
    };
    const meta: SessionSaveMeta = {
      docHash,
      fileName: doc.fileName,
      filePath: doc.filePath,
      pageCount: doc.pageCount,
      embedModel,
      embedDim,
      chunkCount: chunkMeta.length,
    };
    const result = await api.save({ meta, session, blob, keepIndex });
    const ok = result?.ok !== false; // {ok:false}=실패, 그 외(true/구형 undefined)=성공 취급
    // 전체 blob 을 성공적으로 기록했을 때만 시그니처 갱신 → 다음 턴부터 동일 인덱스는 keepIndex.
    if (ok && fullSerialized) {
      persistedIndexSig = { ref: new WeakRef(ragIndex), revision: ragIndex.revision };
    }
    recordSaveResult(ok);
  } catch {
    // 저장 실패는 작업을 막지 않음(best-effort) — 단 연속 실패는 집계해 임계 초과 시 1회 통지(E3)
    recordSaveResult(false);
  }
}

/** 요약·Q&A·인덱스 변경이 settle 되면 디바운스로 자동 저장. App 에 1회 마운트. */
export function useSessionPersistence(): void {
  const document = useAppStore((s) => s.document);
  const summaryStream = useAppStore((s) => s.summaryStream);
  const qaMessages = useAppStore((s) => s.qaMessages);
  const ragChunkCount = useAppStore((s) => s.ragState.chunkCount);
  const ragIsIndexing = useAppStore((s) => s.ragState.isIndexing);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const isCollectionBusy = useAppStore((s) => s.isCollectionBusy);
  const persistEnabled = useAppStore((s) => s.settings.persistSessions);
  const pending = useAppStore((s) => s.sessionRestorePending);

  useEffect(() => {
    if (!persistEnabled || !document || pending) return;
    // R43 I-2: 인덱싱 중 보류 — 완료 후 chunkCount settle 시 저장 (부분 인덱스 영속화 방지)
    // isCollectionBusy(컬렉션 gather) 중 보류 — 활성 문서 머지 read 와 컬렉션 인라인 요약
    // cross-write 의 lost-update 방지. busy 해제 시 deps 변화로 effect 재실행되어 재예약.
    if (isGenerating || isQaGenerating || ragIsIndexing || isCollectionBusy) return;
    const hasContent = !!summaryStream || qaMessages.length > 0 || ragChunkCount > 0;
    if (!hasContent) return;
    const timer = setTimeout(() => { void persistCurrentSession(); }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [document, summaryStream, qaMessages, ragChunkCount, ragIsIndexing, isGenerating, isQaGenerating, isCollectionBusy, persistEnabled, pending]);
}
