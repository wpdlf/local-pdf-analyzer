import { useEffect } from 'react';
import { useAppStore } from './store';
import { hashDocumentText } from './session-hash';
import { VectorStore } from './vector-store';
import type { PdfDocument, PersistedSession, Summary, DefaultSummaryType } from '../types';
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
        restoredType = firstEntry[0] as DefaultSummaryType;
        persistedSummary = firstEntry[1];
      }
    }
    if (persistedSummary) {
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

    // Q&A 복원
    if (Array.isArray(session.qaMessages) && session.qaMessages.length > 0) {
      store.setQaMessages(session.qaMessages);
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

/** 현재 store 상태를 세션으로 저장 (best-effort, 직렬화). 생성 중/복원 대기 중에는 skip. */
export function persistCurrentSession(): Promise<void> {
  persistChain = persistChain.then(doPersistCurrentSession, doPersistCurrentSession);
  return persistChain;
}

async function doPersistCurrentSession(): Promise<void> {
  const s = useAppStore.getState();
  const doc = s.document;
  const api = window.electronAPI?.session;
  if (!doc || !s.settings.persistSessions || !api) return;
  // R43 I-2: ragState.isIndexing 가드 — provider 전환 재빌드 도중 디바운스가 발화하면
  // 빌드 중간의 부분 청크(model/dim 은 이미 세팅됨)가 완전한 인덱스처럼 영속화되고,
  // 그 창에서 앱을 종료하면 다음 복원이 잘린 인덱스를 채택해 검색 범위가 영구 축소된다.
  if (s.isGenerating || s.isQaGenerating || s.sessionRestorePending || s.ragState.isIndexing) return;
  try {
    const docHash = await hashDocumentText(doc.extractedText);
    if (useAppStore.getState().document?.id !== doc.id) return; // 레이스
    const serialized = s.ragIndex.serialize();
    const hasIndex = serialized.chunkMeta.length > 0;

    // 기존 세션의 타입별 요약을 머지(다른 요약 타입 보존)
    let summaries: PersistedSession['summaries'] = {};
    try {
      const existing = await api.load(docHash);
      const existSession = existing?.session as PersistedSession | undefined;
      if (existSession?.summaries) summaries = { ...existSession.summaries };
    } catch { /* 무시 */ }
    if (s.summaryStream && s.summary) {
      summaries[s.summary.type] = {
        content: s.summaryStream,
        model: s.summary.model,
        provider: s.summary.provider,
      };
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
      embedModel: hasIndex ? serialized.model : null,
      embedDim: hasIndex ? serialized.dimension : null,
      chunkMeta: serialized.chunkMeta,
    };
    const meta: SessionSaveMeta = {
      docHash,
      fileName: doc.fileName,
      filePath: doc.filePath,
      pageCount: doc.pageCount,
      embedModel: session.embedModel,
      embedDim: session.embedDim,
      chunkCount: serialized.chunkMeta.length,
    };
    await api.save({ meta, session, blob: hasIndex ? serialized.buffer : null });
  } catch { /* best-effort — 저장 실패는 작업을 막지 않음 */ }
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
  const persistEnabled = useAppStore((s) => s.settings.persistSessions);
  const pending = useAppStore((s) => s.sessionRestorePending);

  useEffect(() => {
    if (!persistEnabled || !document || pending) return;
    // R43 I-2: 인덱싱 중 보류 — 완료 후 chunkCount settle 시 저장 (부분 인덱스 영속화 방지)
    if (isGenerating || isQaGenerating || ragIsIndexing) return; // 생성 중 보류 — 완료 후 settle 시 저장
    const hasContent = !!summaryStream || qaMessages.length > 0 || ragChunkCount > 0;
    if (!hasContent) return;
    const timer = setTimeout(() => { void persistCurrentSession(); }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [document, summaryStream, qaMessages, ragChunkCount, ragIsIndexing, isGenerating, isQaGenerating, persistEnabled, pending]);
}
