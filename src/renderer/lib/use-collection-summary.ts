import { useAppStore } from './store';
import { AiClient } from './ai-client';
import { resolveMembers } from './collection';
import { t } from './i18n';
import { sanitizePromptInput } from './use-qa';
import type { PersistedSession, ResolvedMember } from '../types';

/**
 * 교차 문서 요약/비교 (multi-doc Phase 3 / module-3, A).
 *
 * Design Ref: multi-doc-phase3.design.md §2.A — map-reduce. 각 멤버의 **저장된 단일-문서 요약**을
 * 재사용(재요약 0)하고, 없으면 본문 발췌로 대체한 뒤 reduce 프롬프트(통합 요약 또는 비교 분석)로
 * 합성한다. 결과는 QaChat 메시지 영역(기존 UI 재사용 — 새 패널 없음)에 스트리밍한다.
 *
 * Q-A2 단순화: 요약 부재 멤버는 그 자리에서 생성·저장하지 않고 본문 발췌(EXCERPT)로 대체한다
 * (타 문서 세션에 cross-write 하는 위험 회피 — 인라인 생성+영속화는 차기 refinement).
 */

export type CollectionSummaryKind = 'unified' | 'comparison';

/** 토큰/비용 가드 — 합성에 포함할 최대 멤버 수(설계 §10 Q-A4) */
export const COLLECTION_SUMMARY_MAX_MEMBERS = 10;
/** 요약이 없는 멤버의 본문 발췌 상한(문자) */
const MEMBER_EXCERPT_CHARS = 1500;

interface MemberBlock { fileName: string; content: string; }

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
    .map((b) => `## ${sanitizePromptInput(b.fileName.replace(/[\r\n]+/g, ' '))}\n${sanitizePromptInput(b.content)}`)
    .join('\n\n');
  return `${instruction}\n\n${body}`;
}

/** ready 멤버들의 표현(요약 우선, 없으면 본문 발췌)을 수집. session.load 로 본문/요약을 읽음. */
async function gatherMemberBlocks(
  members: ResolvedMember[],
  summaryType: string,
): Promise<MemberBlock[]> {
  const blocks: MemberBlock[] = [];
  for (const m of members.slice(0, COLLECTION_SUMMARY_MAX_MEMBERS)) {
    const loaded = await window.electronAPI.session.load(m.docHash).catch(() => null);
    const session = loaded?.session as PersistedSession | undefined;
    if (!session) continue;
    const summary = pickSummary(session, summaryType);
    const content = summary
      ?? (typeof session.extractedText === 'string' ? session.extractedText.slice(0, MEMBER_EXCERPT_CHARS) : null);
    if (content && content.trim()) blocks.push({ fileName: m.fileName, content });
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
  if (collectionSummaryInFlight || st.isGenerating || st.isQaGenerating || st.ragState.isIndexing) return;
  const activeTab = st.openTabs.find((tb) => tb.filePath === st.document?.filePath);
  const activeDocHash = activeTab?.docHash;
  if (!activeDocHash) return;
  collectionSummaryInFlight = true;

  let requestId: string | null = null;
  let started = false; // setIsQaGenerating(true) 까지 진행했는지 — finally 정리 게이트
  try {
    const memberHashes = st.collection.memberHashes.includes(activeDocHash)
      ? st.collection.memberHashes
      : [activeDocHash, ...st.collection.memberHashes];
    const manifest = await window.electronAPI.session.list().catch(() => []);
    const ready = resolveMembers(
      memberHashes,
      { docHash: activeDocHash, model: st.ragIndex.model, dim: st.ragIndex.dimension },
      manifest,
      st.openTabs,
    ).filter((m) => m.status === 'ready');
    if (ready.length < 2) {
      useAppStore.getState().setNotice({ message: t('collection.summaryNeedsMembers') });
      return;
    }

    const blocks = await gatherMemberBlocks(ready, st.summaryType);
    if (blocks.length < 2) {
      useAppStore.getState().setNotice({ message: t('collection.summaryNeedsMembers') });
      return;
    }
    // 결과 배지(R47 UX): 교차 요약 결과를 일반 Q&A 답변과 구분하도록 제목 헤더를 앞에 붙인다.
    const resultTitle = kind === 'comparison'
      ? t('collection.compareResultTitle', { count: blocks.length })
      : t('collection.unifiedResultTitle', { count: blocks.length });

    const prompt = buildCollectionSummaryPrompt(kind, blocks, st.settings.summaryLanguage || 'ko');
    const client = new AiClient(st.settings);
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
      // 소유권 가드(R47): 사용자 Stop 후 새 Q&A 가 시작됐으면(qaRequestId 교체) stale 스트림은 종료.
      const s = useAppStore.getState();
      if (!s.isQaGenerating || s.qaRequestId !== requestId) break;
      s.appendQaStream(token);
      answer += token;
    }
    // 소유권 확인 후에만 flush/커밋 — handleAsk 의 stillOurs 가드와 동형(고아 메시지/클로버링 방지)
    const post = useAppStore.getState();
    if (post.qaRequestId === requestId) {
      post.flushQaStream();
      post.clearQaStream();
      if (answer.trim()) post.addQaMessage({ role: 'assistant', content: `**${resultTitle}**\n\n${answer}` });
    }
  } catch (err) {
    if (useAppStore.getState().qaRequestId === requestId) {
      useAppStore.getState().setError({
        code: 'GENERATE_FAIL',
        message: err instanceof Error ? err.message : t('collection.summaryFail'),
      });
    }
  } finally {
    collectionSummaryInFlight = false;
    // 우리 소유일 때만 전역 생성 상태 해제 — stale 핸들러가 새 세션을 끄지 않도록.
    if (started && useAppStore.getState().qaRequestId === requestId) {
      useAppStore.getState().setIsQaGenerating(false);
      useAppStore.getState().setQaRequestId(null);
    }
  }
}
