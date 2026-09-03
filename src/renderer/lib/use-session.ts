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
  // 이 시도의 결과로 판정한다 — 직전 시도의 실패가 남아 저장을 영영 막지 않도록.
  store.setSessionRestoreFailed(false);
  try {
    const docHash = await hashDocumentText(doc.extractedText);
    // multi-doc Phase 1: 탭에 콘텐츠 해시 기록 — 파일 재읽기가 불가능한 탭(이름-경로/파일
    // 이동)도 영속 세션에서 직접 복원해 전환할 수 있게 하는 fallback 키 (tabs.ts).
    //
    // QA31 잔여: 여기는 **upsert 가 아니라 patch** 여야 한다. 이 함수는 호출부 셋 모두에서
    // `void` 로 띄워지므로(pdf-parser:1259 / tabs.ts:152) 호출부의 setTabSwitching 구간이
    // 이미 끝난 뒤에도 계속 돈다 — 그 창에서는 closeTab 이 열려 있다. 위 `hashDocumentText`
    // await 사이에 사용자가 이 탭을 닫으면 upsert 가 **닫은 탭을 되살렸다**. 탭 등록은 두
    // 호출부가 이 함수를 부르기 **전에** 이미 끝내 놓으므로(둘 다 upsert 후 호출), 여기서
    // 삽입이 일어날 정당한 경우는 없다. 아래 :48 의 소유권 검사와 같은 관심사이고, 그것이
    // 이 쓰기보다 뒤에 있어서 여기만 무보호였다.
    useAppStore.getState().patchOpenTab(doc.filePath, {
      fileName: doc.fileName, pageCount: doc.pageCount, docHash,
    });
    const res = await api.load(docHash);
    // abort-replace 레이스: 그 사이 다른 문서로 교체됐으면 아무것도 건드리지 않음(새 흐름이 관리)
    if (useAppStore.getState().document?.id !== doc.id) return;
    if (!res || !res.session) {
      store.setSessionRestorePending(false);
      return;
    }
    const session = res.session as PersistedSession;
    // Plan SC: 콘텐츠 무효화 — 다른 문서의 세션이면 복원하지 않고 정상 재계산.
    if (session.docHash !== docHash) {
      store.setSessionRestorePending(false);
      return;
    }
    // 스키마 버전 불일치(= SESSION_SCHEMA_VERSION 을 올린 뒤 구버전 세션을 만난 경우):
    // 파생 필드(인덱스 blob/chunkMeta)는 포맷이 바뀌었을 수 있으므로 신뢰하지 않고 재빌드하되,
    // **재계산 불가능한 사용자 데이터**(요약 본문·Q&A 대화)는 아래 검증 경로로 최대한 살린다.
    //
    // 이전엔 여기서 통째로 early-return 했다. 그러면 게이트가 열린 직후 자동저장이 발화해
    // 빈 s.qaMessages 로 디스크 session.json 을 덮어썼고(doPersistCurrentSession), 요약은
    // loadMeta 머지가 보존하지만 qaMessages 는 머지 대상이 아니라 대화가 조용히 소실됐다.
    // 살아남은 필드를 그대로 읽어 현재 버전으로 다시 쓰는 read-old/write-new 가 곧 마이그레이션이다.
    // (필드가 통째로 개명되는 파괴적 변경은 여기서 방어할 수 없다 — 그때는 명시적 변환이 필요.)
    const schemaMismatch = session.schemaVersion !== SESSION_SCHEMA_VERSION;

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
    // QA22(백로그): 삭제된 커스텀 템플릿의 요약(`custom:<없는 id>`)은 복원 대상에서 제외한다.
    // 이전엔 그 키가 그대로 복원돼 activeSummaryType 이 존재하지 않는 유형이 됐고, 곧바로
    // SummaryTypeSelector 의 폴백이 'full' 로 되돌려 **"full 탭인데 커스텀 본문"** 조합이 남았다
    // (R41 이 없앴던 라벨↔본문 불일치의 재현 — 그 stale 조합은 자동저장으로도 흘러간다).
    // 특히 fallback 은 summaries 의 **첫 항목**을 집으므로 고아 요약 하나가 정상 요약을 가릴 수 있다.
    // 디스크의 고아 요약 자체는 지우지 않는다(사용자가 만든 산출물이고, 용량은 세션 LRU 가 관리).
    const activeTemplates = useAppStore.getState().settings.customSummaryTemplates ?? [];
    const isRestorableType = (type: string): boolean =>
      !type.startsWith('custom:')
      || activeTemplates.some((tpl) => `custom:${tpl.id}` === type && tpl.name.trim() && tpl.prompt.trim());

    let restoredType = session.summaryType;
    let persistedSummary = isRestorableType(session.summaryType)
      ? session.summaries?.[session.summaryType]
      : undefined;
    if (!persistedSummary) {
      const firstEntry = Object.entries(session.summaries ?? {}).find(([type]) => isRestorableType(type));
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
    // schemaMismatch 면 chunkMeta/blob 포맷을 신뢰할 수 없으므로 채택하지 않고 재빌드에 맡긴다.
    if (!schemaMismatch && res.blob && session.embedModel && session.embedDim) {
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
    //
    // QA32(B): 소유권을 다시 본다. 위 `:154` 의 doc 검사는 try **안**에 있어서, 그 뒤의
    // `checkEmbedModel()` 이 reject 하면 inner catch 가 삼키고 여기로 떨어지는데 이 경로엔
    // 재확인이 없었다. 게이트는 문서별이 아니라 **전역**이라, 그 사이 전환된 새 문서의 복원이
    // 세운 pending 을 옛 흐름이 내린다 → useRagBuilder 자동 재빌드와 doPersistCurrentSession
    // (이 게이트로 막고 있다)이 반쯤 복원된 문서에 대해 발화한다. 바깥 catch 는 이미 doc 검사를
    // 받았는데 이 정상 경로만 남아 있었다(형제 누락).
    if (useAppStore.getState().document?.id !== doc.id) return;
    store.setSessionRestorePending(false);
  } catch {
    if (useAppStore.getState().document?.id === doc.id) {
      // QA31(C-High): 이전엔 게이트만 열었다. 그러면 메모리는 qaMessages=[] 인 채로 자동저장이
      // 발화해 디스크의 대화를 통째로 지웠다 — 요약은 loadMeta 머지가 살리지만 qaMessages 는
      // 머지 대상이 아니다(use-session.ts 상단 schemaMismatch 주석이 이 메커니즘을 이미
      // 서술하고 있었는데, QA11 은 그 경로 하나만 고치고 이 catch 를 남겼다 = 형제 누락).
      //
      // 복원 실패는 "디스크에 무엇이 있는지 모른다" 는 뜻이므로 **덮어쓰지 않는 쪽**을 택한다.
      // 대가로 이 세션의 새 작업도 저장되지 않으므로 반드시 알린다(조용한 데이터 손실보다
      // 시끄러운 미저장이 낫다). 다음 열기에서 복원이 성공하면 표식은 위에서 내려간다.
      useAppStore.getState().setSessionRestoreFailed(true);
      useAppStore.getState().setNotice({ message: t('session.restoreFailedNotice') });
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
export function persistCurrentSession(flush = false): Promise<void> {
  const run = () => doPersistCurrentSession(flush);
  persistChain = persistChain.then(run, run);
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

async function doPersistCurrentSession(flush = false): Promise<void> {
  const s = useAppStore.getState();
  const doc = s.document;
  const api = window.electronAPI?.session;
  if (!doc || !s.settings.persistSessions || !api) return;
  // 복원 대기 중(문서 불일치)은 어떤 경로에서도 skip — 아직 이 문서의 진실이 메모리에 없다.
  if (s.sessionRestorePending) return;
  // QA31(C-High): 복원이 실패한 문서도 같다 — 메모리가 비어 있는데 디스크에는 대화가 있을 수
  // 있다. flush 경로(savePartial=patchSession)도 qaMessages 를 통째로 실으므로 함께 막는다.
  if (s.sessionRestoreFailed) return;
  // isCollectionBusy(컬렉션 gather) 중에는 활성 문서 자동저장을 보류 — 머지 read(mutex 밖)와
  // 컬렉션 인라인 요약 cross-write 의 TOCTOU lost-update 방지.
  // QA18(B-MED, 데이터손실): 단 종료/새로고침 flush 까지 통째로 skip 하면, 컬렉션 통합요약
  // (로컬 모델이면 분 단위 gather) 도중 종료 시 직전에 완료된 Q&A 턴·요약이 디스크에 닿지
  // 못한 채 사라진다 — QA10 handshake 가 no-op persist 를 기다리는 무의미 상태(QA12 는
  // isGenerating/isQaGenerating 만 flush-aware 로 바꾸고 이 줄은 남겨뒀다).
  // flush 경로는 아래 savePartial(patchSession) 만 허용한다: main 의 write mutex 안에서
  // read-modify-write 하며 summaries[type] 한 칸만 교체하므로 컬렉션 인라인 요약과의
  // lost-update 가 구조적으로 발생하지 않는다. 부분저장이 불가/실패면 전체저장으로
  // 폴백하지 않고 보류한다(전체저장은 타 타입 요약을 덮어쓸 수 있다).
  const partialOnly = flush && s.isCollectionBusy;
  if (!flush && s.isCollectionBusy) return;
  // QA12(B-MED): 디바운스 경로는 생성 중 skip(부분 스트림 영속화 방지). 그러나 종료/새로고침
  // flush(handshake/pagehide)까지 통째로 skip 하면, 요약 완료 직후 후속 질문(isQaGenerating)으로
  // 디바운스가 취소·미재예약된 상태에서 종료 시 "완성 요약"이 디스크에 닿지 못해 소실됐다
  // (QA10 handshake 가 no-op persist 를 기다리는 무의미 상태). flush 경로는 이미 커밋된 데이터만
  // committed-only 로 정규화해 저장한다(아래 summaryContentToPersist / safeQaMessages).
  if (!flush && (s.isGenerating || s.isQaGenerating)) return;
  // flush 중 요약 생성(isGenerating)이면 summaryStream 은 새 타입의 부분 스트림이므로 s.summary
  // (직전 완성본)를 대신 기록해 부분 요약이 완성본을 덮어쓰는 것을 막는다. 생성 중이 아니면
  // summaryStream 이 곧 완성 요약이다(setSummary 는 완료 시 커밋되어 summary.type 과 일치).
  const persistCommitted = flush && s.isGenerating;
  const summaryContentToPersist = persistCommitted
    ? (s.summary?.content ?? null)
    : (s.summaryStream || null);
  // QA18(A-MED, 데이터손실 2건): 저장 키는 "이 콘텐츠를 만든 요약 타입"이어야 한다. 기존엔
  // 콘텐츠는 summaryStream, 키·메타는 s.summary(마지막 성공 커밋)에서 가져와 이원화돼 있었다.
  // setSummary 는 성공 완주 시에만 호출되므로 중단·실패로 끝난 run 은 둘이 영구히 어긋난다:
  //  (1) 'full' 완성 후 'keywords' 요약을 Stop → summaries['full'] 에 잘린 키워드표가 덮어써져
  //      원본 완성 요약이 파괴됐다.
  //  (2) 첫 요약이 마지막 통합 단계에서만 실패하면 s.summary===null → `&& s.summary` 게이트에
  //      걸려 완주한 청크 요약 전체가 한 글자도 저장되지 않았다(화면엔 보이므로 사용자는 인지 못함).
  // summaryStreamType 은 run 시작 시 clearStream(type) 으로 등록되는 단일 출처다. 복원 세션
  // (run 없이 디스크에서 채운 경우)은 null 이므로 s.summary.type 으로 폴백한다.
  const persistType = persistCommitted
    ? (s.summary?.type ?? null)
    : (s.summaryStreamType ?? s.summary?.type ?? null);
  // QA21(A-MED, v0.31.34 회귀 수정): QA20 이 도입한 미완주 판정을 두 조각으로 정확히 나눈다.
  // 원 게이트는 `s.summaryStreamComplete` 하나였는데, 이 플래그는 **미완주**뿐 아니라
  //  ① flush 중 재요약(진행 중인 새 run 의 clearStream 이 내려놓은 상태 — 정작 저장 대상은
  //     s.summary 라는 **커밋된 완주본**이다) 과
  //  ② 요약을 한 번도 하지 않은 문서(초기값 false — 저장할 요약 자체가 없다)
  // 에서도 false 라, 둘 다 "미완주" 로 오인해 차단했다. ①은 방금 완주한 요약을 소실시키고,
  // ②는 컬렉션 gather 중 flush 에서 fast-path 를 막아(그 뒤 partialOnly return) **아무것도
  // 저장되지 않게** 만들었다(QA18 이 열어둔 유일한 통로 봉쇄 = Q&A 턴 소실).
  // 교훈: 판정 플래그를 도입할 때는 그 값이 각 값을 갖는 **모든 정상 상태**를 열거할 것.
  const summaryIsCommitted = persistCommitted || s.summaryStreamComplete;
  // 메타(model/provider)는 커밋본이 같은 타입일 때만 그것을 쓰고, 아니면 현재 설정을 기록한다.
  const persistMeta = (s.summary && s.summary.type === persistType)
    ? { model: s.summary.model, provider: s.summary.provider }
    : { model: s.settings.model, provider: s.settings.provider };
  // flush 중 Q&A 생성이면 마지막 메시지가 짝 없는 user(스트리밍 답변 대기)일 수 있다 → 복원 시
  // orphan-Q 불변식(formatHistory) 위반을 막기 위해 trailing lone-user 만 제거(완료 턴은 보존).
  let safeQaMessages = s.qaMessages;
  if (flush && s.isQaGenerating && safeQaMessages.length > 0
      && safeQaMessages[safeQaMessages.length - 1]?.role === 'user') {
    safeQaMessages = safeQaMessages.slice(0, -1);
  }
  // R43 I-2: ragState.isIndexing 중 부분 인덱스(빌드 중간 청크) 영속화 금지는 유지하되,
  // 전체 skip 은 하지 않는다 — 탭 전환/새 탭(+)의 명시적 flush 가 인덱싱 타이밍에 조용히
  // skip 되면 방금 연 문서의 세션이 디스크에 없어, 경로가 없는 탭(드롭)의 세션 fallback
  // 전환이 실패한다(multi-doc Phase 1 사용자 버그). 인덱싱 중에는 텍스트·요약·Q&A 만
  // 저장하고 인덱스 필드/블롭은 기존 디스크 세션의 것을 보존한다.
  const indexing = s.ragState.isIndexing;
  // QA19(C-MED, 데이터손실): 빌드 실패(ragState.error, 대개 네트워크 단절) 상태도 "디스크 인덱스
  // 보존" 대상에 포함한다. 실패 시 use-qa 가 메모리 인덱스를 clear(부분 저장 방지)하는데, 이걸
  // "인덱스 없음(blob:null)"으로 저장하면 main 이 디스크의 이전 정상 index.bin 을 unlink 해버려
  // 재오픈 시 재임베딩을 강제한다. indexing 과 동일하게 디스크 blob 을 보존하면, 재오픈 시
  // 마지막 정상 인덱스가 복원된다(실패 이전의 완전한 인덱스).
  // QA23(D-HIGH): QA19 는 표식(error)을 **배치 실패 3곳에만** 붙였고, 가장 흔한 진입점인
  // **가용성 체크 실패**(Ollama 미기동 / API 키 부재 / 오프라인)는 `isAvailable:false, error:null`
  // 로 끝난다. 그래서 이 술어가 꺼진 채 자동저장이 돌아, 사용자가 **문서를 열어보기만 해도**
  // 디스크 index.bin 이 unlink 됐다(무음 · ok:true 라 실패 통지망도 통과). 다시 켜면 전 문서
  // 재임베딩 — 로컬은 수 분, 클라우드는 실과금.
  //
  // 표식을 한 곳 더 붙이는 대신(=네 번째 형제를 만드는 대신) **"쓸 수 있는 인덱스를 갖고 있지
  // 않다"는 하나의 파생 상태**로 승격한다. 디스크 인덱스를 지워도 되는 경우는 새 인덱스를
  // 실제로 기록할 때뿐이므로, 그 외에는 전부 보존이 안전한 기본값이다.
  // 판정 기준은 **메모리 인덱스의 실재**다(ragState 플래그가 아니라). 플래그는 빌드 단계마다
  // 달라지지만 "지금 기록할 인덱스를 갖고 있는가"는 이것 하나로 결정된다.
  const preserveDiskIndex = indexing || !!s.ragState.error || s.ragIndex.size === 0;
  try {
    const docHash = await getCachedDocHash(doc.id, doc.extractedText);
    if (useAppStore.getState().document?.id !== doc.id) return; // 레이스

    const ragIndex = s.ragIndex;
    const hasIndex = !preserveDiskIndex && ragIndex.size > 0;
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
    // QA20(C-MED, 데이터손실): 미완주 스트림(중지·타임아웃·실패)은 이 fast-path 를 타지 않는다.
    // fast-path 는 디스크의 기존 요약을 읽지 않으므로 "덮어써도 되는가"를 판정할 수 없고,
    // patchSession 은 summaries[type] 을 무조건 교체하기 때문이다. 아래 전체 경로로 내려가면
    // 기존 요약을 머지해 읽으므로 정확히 판정할 수 있다(미완주 상태는 드물어 비용도 미미).
    // QA21(A-MED): 단 **저장할 요약 델타가 없으면**(summaryPatch=null) patchSession 은
    // summaries 를 아예 건드리지 않으므로 덮어쓸 위험 자체가 없다 → fast-path 를 막을 이유가
    // 없다. 요약을 하지 않은 문서 전체가 이 경우이고, 그런 문서에서 fast-path 를 막으면
    // Tier3 최적화(IPC ~5MB→~50KB)가 무효화될 뿐 아니라 컬렉션 flush 가 통째로 소실된다.
    const summaryPatch = (summaryContentToPersist && persistType)
      ? { type: persistType, content: summaryContentToPersist, ...persistMeta }
      : null;
    if (idxUnchanged && typeof api.savePartial === 'function'
        && (summaryIsCommitted || summaryPatch === null)) {
      let partialOk = false;
      try {
        const r = await api.savePartial({
          docHash,
          summary: summaryPatch,
          summaryType: s.summaryType,
          qaMessages: safeQaMessages,
        });
        partialOk = r?.ok === true;
      } catch { partialOk = false; }
      if (partialOk) { recordSaveResult(true); return; }
      // 디스크 세션 부재(LRU evict 등)/실패 → 시그니처 무효화 후 전체 저장으로 재생성(blob 포함).
      persistedIndexSig = null;
      idxUnchanged = false;
    }
    // QA18(B-MED): 컬렉션 gather 중 flush 는 부분저장까지만 허용 — 전체저장은 mutex 밖 머지
    // read 를 거치므로 컬렉션 인라인 요약과 lost-update 를 일으킬 수 있다. 여기 도달했다는 건
    // 부분저장이 불가(인덱스 변경)하거나 실패했다는 뜻이므로 이번 저장은 보류한다.
    if (partialOnly) return;

    // 기존 세션의 타입별 요약을 머지(다른 요약 타입 보존) + 인덱싱 중이면 기존 인덱스 보존
    let summaries: PersistedSession['summaries'] = {};
    let prevIndex: { embedModel: string; embedDim: number; chunkMeta: PersistedSession['chunkMeta']; blob: ArrayBuffer } | null = null;
    try {
      // QA23(D-HIGH): 보존 여부와 **무거운 읽기 여부**를 분리한다. 이전에는 preserveDiskIndex 가
      // 곧바로 full load(수 MB blob + 구조화 복제)를 의미했는데, 보존 대상이 "인덱스를 못 만든
      // 모든 문서"로 넓어지면 **디스크에 인덱스가 아예 없는 문서까지** 매 자동저장마다 무거운
      // 경로를 타 Tier3 성능 최적화가 무효화된다(회귀 넷이 이를 잡았다).
      // → 항상 가벼운 loadMeta 로 먼저 읽고, **디스크에 실제로 인덱스가 있을 때만** blob 을
      //   가지러 한 번 더 읽는다. 인덱스 없는 문서의 비용은 종전과 동일하다.
      const light = await (api.loadMeta?.(docHash) ?? api.load(docHash)) as
        { session?: unknown; blob?: ArrayBuffer | null } | null;
      const lightSession = light?.session as PersistedSession | undefined;
      if (lightSession?.summaries) summaries = { ...lightSession.summaries };
      const diskHasIndex = !!lightSession?.embedModel && !!lightSession?.embedDim;
      if (preserveDiskIndex && diskHasIndex) {
        // loadMeta 는 blob 을 싣지 않는다 — 보존할 인덱스가 실재할 때만 full load 로 가져온다.
        const existing = light?.blob ? light : await api.load(docHash);
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
    if (summaryContentToPersist && persistType) {
      // QA20(C-MED, 데이터손실): 미완주 스트림은 **같은 타입의 기존 완성본을 덮어쓰지 않는다**.
      // 기존 방어(persistCommitted)는 flush 경로 전용인데, 중지·타임아웃·실패는 isGenerating 을
      // 먼저 끄므로 그 뒤의 일반 자동저장이 부분 스트림을 완성본으로 오인해 디스크의 완성 요약을
      // 파괴했다(같은 타입으로 재요약 → 중지 한 번이면 원본 소실, 복구 불가).
      // 단, 기존 요약이 **없으면** 부분 결과라도 저장한다 — QA18(A-MED)이 고친 "마지막 통합
      // 단계에서만 실패하면 완주한 청크 요약이 한 글자도 저장되지 않던" 동작을 유지하기 위함.
      // QA21(A-MED): 판정은 summaryIsCommitted — flush 중 재요약이면 저장 대상이 부분 스트림이
      // 아니라 **직전 완주본**(persistCommitted)이므로 미완주로 취급하면 안 된다. 원 게이트가
      // s.summaryStreamComplete 만 봐서 그 완주본을 차단했다(v0.31.34 데이터손실 회귀).
      const wouldOverwriteExisting = !!summaries[persistType];
      if (summaryIsCommitted || !wouldOverwriteExisting) {
        summaries[persistType] = {
          content: summaryContentToPersist,
          ...persistMeta,
        };
      }
    }

    // 인덱스 필드/blob/keepIndex 결정 — 4-상태:
    //  ①idxUnchanged → keepIndex(blob 미전송, 메타만 경량 추출, main 이 index.bin 보존)
    //  ②hasIndex(변경/최초) → 전체 serialize 후 blob 기록
    //  ③preserveDiskIndex(인덱싱 중 or 빌드 실패) → 디스크의 기존 인덱스 보존(prevIndex.blob)
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
    } else if (preserveDiskIndex) {
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
      imagesSkipped: doc.imagesSkipped,
      // QA27(A-Important): 이미지가 **있었다는 사실**을 함께 남긴다 — 복원 문서는 images:[] 라
      // imagesSkipped 만으로는 텍스트-only PDF 와 구분되지 않는다(types/index.ts 주석 참조).
      // QA28(A-Important): 값을 메모리에서 **재계산만** 하면 복원 문서(images:[])의 첫 전체
      // 저장이 디스크의 true 를 false 로 덮는다 — imagesSkipped 는 doc 필드를 그대로 싣는데
      // 같은 커밋이 추가한 이 표식만 파생값이라 왕복이 깨졌다. 인덱스 없는 문서(Ollama 미기동
      // 등)는 매 자동저장이 전체 저장이라 즉시 소거된다. 복원된 표식을 OR 로 보존한다.
      hadImages: doc.images.length > 0 || doc.hadImages === true,
      summaries,
      summaryType: s.summaryType,
      qaMessages: safeQaMessages,
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
    // QA21(C-MED): 열린 탭의 docHash 를 함께 보내 LRU evict 에서 제외(pin)한다. 비활성 탭의
    // 요약·Q&A 는 메모리에 없고 디스크 세션에만 있어(탭 전환 시 setSummary(null)/clearQa()),
    // evict 되면 그 탭으로 돌아갔을 때 복구 불가다. docHash 가 아직 없는 탭(첫 저장 전)은 제외.
    const openDocHashes = s.openTabs
      .map((tb) => tb.docHash)
      .filter((h): h is string => typeof h === 'string' && h.length > 0);
    const result = await api.save({ meta, session, blob, keepIndex, openDocHashes });
    const ok = result?.ok !== false; // {ok:false}=실패, 그 외(true/구형 undefined)=성공 취급
    // 전체 blob 을 성공적으로 기록했을 때만 시그니처 갱신 → 다음 턴부터 동일 인덱스는 keepIndex.
    if (ok && fullSerialized) {
      persistedIndexSig = { ref: new WeakRef(ragIndex), revision: ragIndex.revision };
    }
    // QA21(C-MED): main 이 "keepIndex 인데 디스크에 index.bin 이 없다" 를 알리면 시그니처를
    // 무효화한다. 그대로 두면 다음 자동저장도 idxUnchanged=true 로 판정해 **같은 keepIndex 저장을
    // 영원히 반복**하고, 디스크 인덱스는 끝내 복구되지 않는다(재오픈 시 재임베딩 강제).
    // 무효화하면 다음 저장이 blob 을 포함한 전체 저장으로 내려가 인덱스를 재기록하고 자가회복한다.
    // (main 은 이 경우에도 저장 자체는 성공시키고 manifest 의 인덱스 메타만 "없음" 으로 정규화한다 —
    // 거짓 "인덱스 있음" 이 검색·컬렉션에서 조용한 누락으로 전파되는 것을 막기 위함.)
    if ((result as { indexMissing?: boolean })?.indexMissing || (!ok && keepIndex)) {
      persistedIndexSig = null;
    }
    // QA21(C-MED, 데이터손실): LRU 정리는 지금까지 **완전 무음**이었다 — ok:true 로 반환되므로
    // 아래 연속실패 통지망도 통과했고, 사용자는 비활성 탭으로 돌아갔을 때 요약·Q&A 가 사라진
    // 것을 발견할 뿐 이유를 알 수 없었다(그 데이터는 메모리에 없고 디스크 세션에만 있어 영구
    // 소실이다). 삭제된 문서명을 통지해 최소한 원인을 알 수 있게 한다.
    // (열린 탭을 evict 대상에서 제외하는 pin 은 별도 작업 — main 이 열린 탭 집합을 모른다.)
    const evicted = (result as { evicted?: unknown })?.evicted;
    if (Array.isArray(evicted) && evicted.length > 0) {
      const names = evicted.filter((n): n is string => typeof n === 'string');
      if (names.length > 0) {
        useAppStore.getState().setNotice({
          message: t('session.evictedNotice', { count: String(names.length), names: names.slice(0, 3).join(', ') }),
        });
      }
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

/**
 * 모듈 스코프 상태 초기화 — **테스트 전용**.
 *
 * QA22(D-LOW): 이 모듈은 persist 체인·인덱스 시그니처·docHash 캐시·연속 실패 카운터를 모듈
 * 스코프에 들고 있는데 어떤 테스트도 이를 리셋하지 않았다. 특히 `saveFailureNotified` 는 한 번
 * true 가 되면 **래치**라, 그 뒤로는 같은 파일의 어떤 테스트에서도 `session.saveFailedNotice`
 * 통지가 영원히 발화하지 않는다. 지금은 그 경로를 검증하는 테스트가 뒤에 없어 무증상이지만,
 * 추가하는 순간 "앞 테스트 때문에 조용히 통과" 하는 함정이 된다 — 이번 사이클에서 세 파일이
 * 정확히 그 형태로 잘못 통과하고 있었으므로(use-session-persistence / ipc-handlers /
 * SettingsPanel) 같은 클래스를 미리 닫는다. 테스트의 beforeEach 에서 호출할 것.
 */
export function __resetSessionModuleStateForTest(): void {
  persistedIndexSig = null;
  persistChain = Promise.resolve();
  docHashCache.clear();
  consecutiveSaveFailures = 0;
  saveFailureNotified = false;
}
