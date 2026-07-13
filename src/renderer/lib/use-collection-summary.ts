import { useAppStore } from './store';
import { AiClient } from './ai-client';
import { resolveMembers } from './collection';
import { t } from './i18n';
import { sanitizePromptInput } from './use-qa';
import { isCustomSummaryType } from '../types';
import type { PersistedSession, ResolvedMember, SummaryType, AppSettings } from '../types';

/**
 * 교차 문서 요약/비교 (multi-doc Phase 3 / module-3, A).
 *
 * Design Ref: multi-doc-phase3.design.md §2.A — map-reduce. 각 멤버의 **저장된 단일-문서 요약**을
 * 재사용(재요약 0)하고, 없으면 본문에서 인라인 생성한 뒤 reduce 프롬프트(통합 요약 또는 비교
 * 분석)로 합성한다. 결과는 QaChat 메시지 영역(기존 UI 재사용 — 새 패널 없음)에 스트리밍한다.
 *
 * 인라인 요약 생성+영속화(Q-A2 refinement): 요약 부재 멤버는 그 자리에서 본문(앞 N자 캡)으로
 * 단일-문서 요약을 생성하고, **그 멤버 세션의 summaries 한 칸만** 병합 저장(session:saveSummary)한다.
 * 비활성 멤버에 cross-write 하지만 메인의 read-merge-write(쓰기 mutex 직렬화)로 다른 필드를 stale
 * 값으로 덮지 않아 안전하다(설계 검토 결론). 생성/영속화 실패 시 본문 발췌(EXCERPT) fallback 유지.
 */

export type CollectionSummaryKind = 'unified' | 'comparison';

/** 토큰/비용 가드 — 합성에 포함할 최대 멤버 수(설계 §10 Q-A4) */
export const COLLECTION_SUMMARY_MAX_MEMBERS = 10;
/** 요약이 없는 멤버의 본문 발췌 상한(문자) */
const MEMBER_EXCERPT_CHARS = 1500;
/**
 * 멤버 요약 블록 1개의 상한(문자). 저장된 단일-문서 요약은 발췌보다 밀도가 높아 상한을 더
 * 두지만, 무제한이면 멤버 10개 합성 시 소형 로컬 모델(gemma3 등) 컨텍스트를 초과해 출력이
 * 깨졌다 — R48 MED-1: 발췌 분기만 캡돼 있던 것을 요약 분기에도 캡 적용.
 */
const MEMBER_SUMMARY_CHARS = 3000;
/**
 * reduce 프롬프트에 넣는 멤버 본문 총량 상한(문자). 멤버 수×블록 상한이 누적돼 컨텍스트를
 * 넘기는 것을 막는 토큰/비용 가드(설계 §10 Q-A4 연장). 남은 예산이 MIN_BLOCK_CHARS 미만이면 중단.
 */
const COLLECTION_REDUCE_TOTAL_CHARS = 12000;
/** 남은 예산이 이보다 작으면 의미 있는 블록을 못 만들어 수집 중단 */
const MIN_BLOCK_CHARS = 200;
/**
 * 인라인 요약 생성 시 모델에 넣는 본문 입력 상한(문자). v1 단순화 — useSummarize 의 청킹 대신
 * 앞 N자만 요약해 소형 로컬 모델 컨텍스트 초과를 원천 차단한다(발췌 1500자보다 월등, 정식
 * 청킹 요약보다는 약간 낮은 품질 — 차기 업그레이드 여지). 설계 검토 결정 사항.
 */
const INLINE_SUMMARY_INPUT_CHARS = 6000;

interface MemberBlock { fileName: string; content: string; }

/**
 * 활성 문서의 in-memory 표현(디스크 폴백용). gatherMemberBlocks 는 활성 문서를 디스크-우선으로
 * 읽되, persist 디바운스(1.5s) 전이거나 persistSessions=OFF 라 디스크 세션이 비어 있을 때
 * 메모리 값으로 폴백해 "화면에 보이는 활성 문서가 컬렉션 요약에서 통째 누락" 되던 결함을 막는다
 * (QA M1). docId 는 gather 도중 탭 전환(문서 교체)을 감지해 이후 멤버 준비를 중단하는 취소 신호.
 */
interface ActiveDocContext { docHash: string; summary: string | null; text: string | null; docId: string | null; }

// C5-M5(QA cycle5): gather 단계 취소 인프라. gather(요약 부재 멤버의 인라인 요약 — 최대 10건
// 순차 LLM 호출, 로컬 모델이면 분 단위) 동안 isCollectionBusy 가 모든 탈출 경로(탭 전환/새 파일/
// ask/summarize/설정 AI 필드)를 막아, 기존의 내부 취소 신호(활성 문서 교체 감지)는 도달 불가능한
// 데드코드였다 — 사용자는 앱 강제 종료 외에 탈출 수단이 없었고 클라우드 토큰이 계속 소모됐다.
// 컨트롤러 + in-flight requestId 를 모듈에 보관해 QaChat 의 중지 버튼이 즉시 끊을 수 있게 한다.
let gatherAbortController: AbortController | null = null;
let gatherRequestId: string | null = null;

/** 교차 요약 gather 단계 취소 — QaChat 중지 버튼(isCollectionBusy && !isQaGenerating) 전용.
 * reduce 스트리밍 단계(isQaGenerating)는 기존 handleQaAbort(qaRequestId abort)가 담당한다. */
export function abortCollectionGather(): void {
  gatherAbortController?.abort();
  const reqId = gatherRequestId;
  if (reqId) {
    try { void window.electronAPI.ai.abort(reqId); } catch { /* 테스트/구 preload — 무시 */ }
  }
}

/**
 * 멤버 본문에서 단일-문서 요약을 인라인 생성(헤드리스 — 활성 문서 store 미오염). 토큰을 문자열로
 * 수집해 반환. reduce 단계와 동일한 AiClient.summarize 경로(임베딩/RAG 비의존)를 재사용한다.
 * requestId 를 모듈에 등록해 abortCollectionGather 가 in-flight 호출을 즉시 끊을 수 있게 한다(C5-M5).
 */
async function generateMemberSummary(client: AiClient, text: string, summaryType: SummaryType, signal?: AbortSignal): Promise<string> {
  const reqId = client.prepareSummarize();
  gatherRequestId = reqId;
  let out = '';
  try {
    for await (const tk of client.summarize(text.slice(0, INLINE_SUMMARY_INPUT_CHARS), summaryType, reqId)) {
      if (signal?.aborted) break;
      out += tk;
    }
  } finally {
    if (gatherRequestId === reqId) gatherRequestId = null;
  }
  return out;
}

/** 세션의 타입별 요약 중 현재 타입 우선, 없으면 첫 항목 선택. 둘 다 없으면 null. */
function pickSummary(session: PersistedSession, summaryType: string): string | null {
  const byType = session.summaries?.[summaryType as keyof typeof session.summaries];
  if (byType?.content) return byType.content;
  const first = Object.values(session.summaries ?? {})[0];
  return first?.content ?? null;
}

/**
 * reduce 프롬프트 빌더 (순수 — 단위 테스트 대상). 멤버 블록을 "## 문서명\n내용" 으로 묶고
 * 통합/비교 지시를 붙인다. 출처는 문서명 기준으로 표기하도록 유도(교차 인용 [문서명 p.N]).
 */
export function buildCollectionSummaryPrompt(
  kind: CollectionSummaryKind,
  blocks: MemberBlock[],
  language: string,
): string {
  const ko = language === 'ko'; // ko 외(en/ja 등)는 중립적 영문 지시
  const instruction = kind === 'comparison'
    ? (ko
      // 소형 로컬 모델은 마크다운 표 구분선(|---|)을 자주 빠뜨려 표가 깨진다. 글머리표를
      // 우선시키고 표는 금지해 렌더 안정성을 확보(R: 비교 결과 깨짐 수정).
      ? '다음 여러 문서의 내용을 비교 분석하라. **마크다운 표는 사용하지 말고**, "## 공통점"과 "## 차이점" 두 섹션으로 나눠 각 항목을 글머리표(- )로 정리하라. 차이점은 문서별로 어떻게 다른지 명시하고, 각 근거에 출처를 [문서명 p.N] 형식으로 표기하라.'
      : 'Compare the following documents. **Do not use markdown tables.** Use two sections "## Commonalities" and "## Differences" with bullet points (- ); for differences, state how each document differs, and cite each point with [filename p.N].')
    : (ko
      ? '다음 여러 문서의 내용을 하나로 통합 요약하라. 문서 간 관계를 드러내고, 각 핵심 사실에 출처를 [문서명 p.N] 형식으로 표기하라.'
      : 'Synthesize the following documents into one unified summary. Surface relationships across documents and cite each key fact with [filename p.N].');
  const body = blocks
    // 보안(R47): 문서명도 정제 — 파일명은 세션 JSON 에 저장돼 외부 편집으로 개행/마커 주입이
    // 가능하므로, 헤더 개행 제거 후 sanitize 하여 reduce 프롬프트 구조 오염(인젝션)을 차단.
    // QA post-v0.31.15: content 의 라인 선두 마크다운 헤더(#)도 이스케이프 — 멤버 블록 구분자
    // (`## 문서명`)를 모방한 허위 문서블록 주입(가짜 사실을 실제 문서명에 귀속)을 차단.
    // sanitizePromptInput 은 [질문]/--- 등 전역 마커만 알고 `##` 는 이 프롬프트 고유 구분자라 여기서 처리.
    .map((b) => {
      const name = sanitizePromptInput(b.fileName.replace(/[\r\n]+/g, ' '));
      const content = sanitizePromptInput(b.content).replace(/^(\s*)(#{1,6})/gm, '$1\\$2');
      return `## ${name}\n${content}`;
    })
    .join('\n\n');
  return `${instruction}\n\n${body}`;
}

/**
 * ready 멤버들의 표현을 수집. session.load 로 본문/요약을 읽고, 요약이 없으면 본문에서 인라인
 * 생성(+그 멤버 세션에 영속화)한다. 생성 실패 시 본문 발췌 fallback. summaryType 키로 생성·조회해
 * 다음 합성/단일 열람에서 재사용(재요약 0)되게 한다.
 */
async function gatherMemberBlocks(
  members: ResolvedMember[],
  summaryType: SummaryType,
  client: AiClient,
  settings: AppSettings,
  active: ActiveDocContext,
  signal: AbortSignal,
): Promise<MemberBlock[]> {
  const blocks: MemberBlock[] = [];
  let budget = COLLECTION_REDUCE_TOTAL_CHARS;
  for (const m of members.slice(0, COLLECTION_SUMMARY_MAX_MEMBERS)) {
    if (budget < MIN_BLOCK_CHARS) break; // 총량 예산 소진 — 이후 멤버는 제외(컨텍스트 초과 방지)
    // C5-M5: 사용자 취소(중지 버튼) — 이후 멤버 준비 즉시 중단.
    if (signal.aborted) break;
    // 취소 신호(QA L1): gather 도중 탭 전환으로 활성 문서가 바뀌면 이후 멤버의 인라인 요약 생성을
    // 중단해 낭비(클라우드 호출 과금)를 막는다. 이미 만든 블록은 어차피 결과 커밋 단계의 소유권
    // 가드(document.id 절)에서 버려진다.
    if (active.docId !== null && useAppStore.getState().document?.id !== active.docId) break;

    const isActive = m.docHash === active.docHash;
    const loaded = await window.electronAPI.session.load(m.docHash).catch(() => null);
    const session = loaded?.session as PersistedSession | undefined;

    // 본문/요약 출처. 활성 문서는 디스크-우선 + 메모리 폴백(QA M1: persist 디바운스 전/persistSessions
    // OFF 로 디스크가 비어 활성 문서가 통째 누락되던 문제). 비활성 멤버는 세션이 없으면 제외.
    let summary = session ? pickSummary(session, summaryType) : null;
    let text = session && typeof session.extractedText === 'string' ? session.extractedText : null;
    if (isActive) {
      if (summary == null) summary = active.summary;
      if (text == null || !text.trim()) text = active.text;
    } else if (!session) {
      continue;
    }

    // 요약 부재 멤버: 본문에서 인라인 생성 → 그 멤버 세션에 영속화(Q-A2 refinement). 생성 실패 시
    // 아래 발췌 fallback 으로 자연 강등. 진행 표시는 첫 생성 시 notice 한 번(map 단계는 스트리밍 X).
    if (summary == null && typeof text === 'string' && text.trim().length > 0) {
      useAppStore.getState().setNotice({ message: t('collection.preparingMember', { name: m.fileName }) });
      const gen = await generateMemberSummary(client, text, summaryType, signal).catch(() => '');
      // C5-M5: 취소로 끊긴 부분 생성물은 사용/영속화하지 않는다 — 부분 요약이 멤버 세션에
      // 완성본처럼 저장되면 다음 합성에서 재사용돼 품질이 조용히 저하된다.
      if (signal.aborted) break;
      if (gen.trim().length > 0) {
        summary = gen;
        // 영속화는 best-effort — 실패해도 이번 합성에는 생성분을 그대로 사용. saveSummary 부재(구
        // preload) 환경에서도 옵셔널 체이닝으로 안전.
        void window.electronAPI.session.saveSummary?.({
          docHash: m.docHash,
          type: summaryType,
          summary: { content: gen, model: settings.model, provider: settings.provider },
        }).catch(() => undefined);
      }
    }

    // 요약(저장/생성) 우선(상한 MEMBER_SUMMARY_CHARS) → 없으면 본문 발췌(상한 MEMBER_EXCERPT_CHARS).
    // 무제한 연결로 인한 컨텍스트 초과(R48 MED-1)는 블록당 캡 + 총량 예산으로 이중 차단.
    const raw = summary != null
      ? summary.slice(0, MEMBER_SUMMARY_CHARS)
      : (typeof text === 'string' ? text.slice(0, MEMBER_EXCERPT_CHARS) : null);
    if (!raw || !raw.trim()) continue;
    const content = raw.length > budget ? raw.slice(0, budget) : raw;
    if (!content.trim()) continue; // 예산 절단으로 공백만 남은 블록은 제외(빈 헤더 방지)
    budget -= content.length;
    blocks.push({ fileName: m.fileName, content });
  }
  return blocks;
}

// 재진입 가드(R47): generateCollectionSummary 는 setIsQaGenerating(true) 를 await 들 뒤에야
// 세팅하므로, 버튼 연타 시 두 번째 호출이 await 사이 창에서 가드를 통과해 두 스트림이 같은
// qaStream 에 교차 append 될 수 있었다. 동기 모듈 플래그로 함수 진입 즉시 차단.
let collectionSummaryInFlight = false;

/**
 * 교차 요약/비교 실행 — 결과를 QaChat 스레드에 스트리밍(사용자 요청 메시지 + assistant 결과).
 * ready 멤버 2개 미만이거나 수집 블록이 2개 미만이면 안내 후 중단.
 */
export async function generateCollectionSummary(kind: CollectionSummaryKind): Promise<void> {
  const st = useAppStore.getState();
  if (collectionSummaryInFlight || st.isGenerating || st.isQaGenerating || st.isCollectionBusy || st.ragState.isIndexing) return;
  const activeTab = st.openTabs.find((tb) => tb.filePath === st.document?.filePath);
  const activeDocHash = activeTab?.docHash;
  if (!activeDocHash) return;
  // 소유권 가드용 활성 문서 정체성(R48 LOW): handleAsk 와 동형으로 document.id 도 함께 확인해
  // stale 스트림이 (전환이 풀린 뒤) 다른 문서의 Q&A 스레드에 결과를 쓰는 것을 방어한다.
  const activeDocId = st.document?.id;
  collectionSummaryInFlight = true;
  // race 차단(QA R): gather(session.list/load + 인라인 멤버 요약) 동안 isQaGenerating 은 아직
  // false 라 입력창·버튼이 활성으로 남는다. 진입 즉시 동기 세팅해 handleAsk/handleSummarize 가
  // 그 사이 끼어들어 qaStream/qaRequestId 를 클로버링하는 것을 막고, UI 도 즉시 비활성화한다.
  useAppStore.getState().setCollectionBusy(true);
  // C5-M5: gather 취소 컨트롤러 — QaChat 중지 버튼(abortCollectionGather)이 끊는다.
  const gatherController = new AbortController();
  gatherAbortController = gatherController;

  // 활성 문서 in-memory 표현(디스크 폴백용 — QA M1). summaryStream(후처리 전체 요약) 우선, 없으면
  // store.summary.content. 본문은 document.extractedText.
  // QA12(LOW): 표시 요약은 st.summaryType 유형의 산출물이다. 커스텀 템플릿이면 gatherType 이 'full'
  // 로 폴백(아래)되므로, 커스텀 산출물을 'full' 합성에 seed 하면 "커스텀 미적용" 고지와 모순된다 →
  // 이 경우 메모리 폴백을 비워 활성 멤버가 디스크 'full' 요약 또는 인라인 'full' 생성 경로를 타게 한다.
  const activeSummary = isCustomSummaryType(st.summaryType)
    ? null
    : (st.summaryStream && st.summaryStream.trim()
        ? st.summaryStream
        : (st.summary?.content ?? null));
  const activeCtx: ActiveDocContext = {
    docHash: activeDocHash,
    summary: activeSummary,
    text: st.document?.extractedText ?? null,
    docId: activeDocId ?? null,
  };

  let requestId: string | null = null;
  let started = false; // setIsQaGenerating(true) 까지 진행했는지 — finally 정리 게이트
  try {
    const memberHashes = st.collection.memberHashes.includes(activeDocHash)
      ? st.collection.memberHashes
      : [activeDocHash, ...st.collection.memberHashes];
    const manifest = await window.electronAPI.session.list().catch(() => []);
    // 요약 자격(QA M2): 교차 요약은 순수 텍스트 합성이라 임베딩 동질성(status==='ready')이 아니라
    // "본문/요약 텍스트가 있는가"가 기준이다. 'missing'(저장 세션 없음)만 제외하고 'no-index'·
    // 'model-mismatch' 도 포함한다(검색 경로 collectionRagSearch 는 자체적으로 'ready'만 쓰므로 무영향).
    // 활성 문서는 메모리 본문이 항상 있으므로 인덱스 유무와 무관하게 포함된다('missing' 불가).
    const eligible = resolveMembers(
      memberHashes,
      { docHash: activeDocHash, model: st.ragIndex.model, dim: st.ragIndex.dimension },
      manifest,
      st.openTabs,
    ).filter((m) => m.status !== 'missing');
    if (eligible.length < 2) {
      useAppStore.getState().setNotice({ message: t('collection.summaryNeedsMembers') });
      return;
    }

    // client 를 gather 전에 생성 — 요약 부재 멤버의 인라인 생성에도 동일 인스턴스를 재사용.
    const client = new AiClient(st.settings);
    // 컬렉션 교차 요약은 기본 유형만 지원 — 커스텀 템플릿 선택 시 'full' 로 폴백(멤버 요약 gather 기준).
    // 무음 폴백은 "커스텀 프롬프트대로 나오겠지" 기대와 어긋나므로 1회 고지(앱의 다른 무음-폴백 고지와 일관, ②C).
    // isCustomSummaryType 을 인라인 가드로 유지해야 else 에서 st.summaryType 이 SummaryType 으로 narrow 됨.
    const gatherType: SummaryType = isCustomSummaryType(st.summaryType) ? 'full' : st.summaryType;
    if (isCustomSummaryType(st.summaryType)) {
      useAppStore.getState().setNotice({ message: t('collection.customTemplateNotApplied') });
    }
    const blocks = await gatherMemberBlocks(eligible, gatherType, client, st.settings, activeCtx, gatherController.signal);
    // C5-M5: 사용자 취소 — 안내 없이 조용히 종료(의도적 액션, finally 가 busy/notice 정리).
    if (gatherController.signal.aborted) {
      useAppStore.getState().setNotice(null);
      return;
    }
    if (blocks.length < 2) {
      useAppStore.getState().setNotice({ message: t('collection.summaryNeedsMembers') });
      return;
    }
    // 인라인 생성 진행 notice 제거 — 곧 reduce 스트리밍이 시작되어 결과가 표시된다.
    useAppStore.getState().setNotice(null);
    // 결과 배지(R47 UX): 교차 요약 결과를 일반 Q&A 답변과 구분하도록 제목 헤더를 앞에 붙인다.
    const resultTitle = kind === 'comparison'
      ? t('collection.compareResultTitle', { count: blocks.length })
      : t('collection.unifiedResultTitle', { count: blocks.length });

    const prompt = buildCollectionSummaryPrompt(kind, blocks, st.settings.summaryLanguage || 'ko');
    requestId = client.prepareSummarize();

    // 사용자 요청 메시지 + assistant 결과를 기존 Q&A 스레드에 표시(요약 영역 재사용 — 새 패널 없음)
    useAppStore.getState().addQaMessage({
      role: 'user',
      content: kind === 'comparison' ? t('collection.compareRequest') : t('collection.unifiedRequest'),
    });
    useAppStore.getState().setIsQaGenerating(true);
    useAppStore.getState().setQaRequestId(requestId);
    useAppStore.getState().clearQaStream();
    started = true;

    let answer = '';
    for await (const token of client.summarize(prompt, 'qa', requestId)) {
      // 소유권 가드(R47/R48): 사용자 Stop 후 새 Q&A 가 시작됐으면(qaRequestId 교체) 또는 문서가
      // 바뀌었으면(document.id 교체) stale 스트림은 종료 — handleAsk 의 stillOurs 가드와 동형.
      const s = useAppStore.getState();
      if (!s.isQaGenerating || s.qaRequestId !== requestId || s.document?.id !== activeDocId) break;
      s.appendQaStream(token);
      answer += token;
    }
    // 소유권 확인 후에만 flush/커밋 — handleAsk 의 stillOurs 가드와 동형(고아 메시지/클로버링 방지)
    const post = useAppStore.getState();
    if (post.qaRequestId === requestId && post.document?.id === activeDocId) {
      post.flushQaStream();
      post.clearQaStream();
      if (answer.trim()) {
        post.addQaMessage({ role: 'assistant', content: `**${resultTitle}**\n\n${answer}` });
      } else {
        // QA post-v0.31.14: 비-abort 빈 응답이면 위에서 추가한 user 메시지가 홀로 남아 짝 FIFO
        // 불변식이 깨진다. handleAsk 와 동일하게 meta='cancelled' placeholder 로 짝 유지.
        post.addQaMessage({ role: 'assistant', content: t('qa.answerEmpty'), meta: 'cancelled' });
      }
    }
  } catch (err) {
    if (useAppStore.getState().qaRequestId === requestId) {
      useAppStore.getState().setError({
        code: 'COLLECTION_SUMMARY_FAIL',
        message: err instanceof Error ? err.message : t('collection.summaryFail'),
      });
    }
  } finally {
    collectionSummaryInFlight = false;
    if (gatherAbortController === gatherController) gatherAbortController = null; // C5-M5 정리
    useAppStore.getState().setCollectionBusy(false); // gather/스트리밍 종료 — 입력창·버튼 복구
    // 우리 소유일 때만 전역 생성 상태 해제 — stale 핸들러가 새 세션을 끄지 않도록.
    if (started && useAppStore.getState().qaRequestId === requestId) {
      useAppStore.getState().setIsQaGenerating(false);
      useAppStore.getState().setQaRequestId(null);
    }
  }
}
