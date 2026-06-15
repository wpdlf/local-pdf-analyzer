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
      ? '다음 여러 문서의 내용을 항목별로 비교 분석하라. 공통점·차이점을 표 또는 항목으로 정리하고, 각 근거에 출처를 [문서명 p.N] 형식으로 표기하라.'
      : 'Compare the following documents point by point. Summarize commonalities and differences as a table or bullet list, citing each point with [filename p.N].')
    : (ko
      ? '다음 여러 문서의 내용을 하나로 통합 요약하라. 문서 간 관계를 드러내고, 각 핵심 사실에 출처를 [문서명 p.N] 형식으로 표기하라.'
      : 'Synthesize the following documents into one unified summary. Surface relationships across documents and cite each key fact with [filename p.N].');
  const body = blocks
    .map((b) => `## ${b.fileName}\n${sanitizePromptInput(b.content)}`)
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

/**
 * 교차 요약/비교 실행 — 결과를 QaChat 스레드에 스트리밍(사용자 요청 메시지 + assistant 결과).
 * ready 멤버 2개 미만이거나 수집 블록이 2개 미만이면 안내 후 중단.
 */
export async function generateCollectionSummary(kind: CollectionSummaryKind): Promise<void> {
  const st = useAppStore.getState();
  if (st.isGenerating || st.isQaGenerating || st.ragState.isIndexing) return;
  const activeTab = st.openTabs.find((tb) => tb.filePath === st.document?.filePath);
  const activeDocHash = activeTab?.docHash;
  if (!activeDocHash) return;

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

  const prompt = buildCollectionSummaryPrompt(kind, blocks, st.settings.summaryLanguage || 'ko');
  const client = new AiClient(st.settings);
  const requestId = client.prepareSummarize();

  // 사용자 요청 메시지 + assistant 결과를 기존 Q&A 스레드에 표시(요약 영역 재사용 — 새 패널 없음)
  useAppStore.getState().addQaMessage({
    role: 'user',
    content: kind === 'comparison' ? t('collection.compareRequest') : t('collection.unifiedRequest'),
  });
  useAppStore.getState().setIsQaGenerating(true);
  useAppStore.getState().setQaRequestId(requestId);
  useAppStore.getState().clearQaStream();

  let answer = '';
  try {
    for await (const token of client.summarize(prompt, 'qa', requestId)) {
      if (!useAppStore.getState().isQaGenerating) break;
      useAppStore.getState().appendQaStream(token);
      answer += token;
    }
    useAppStore.getState().flushQaStream();
    useAppStore.getState().clearQaStream();
    if (answer.trim()) {
      useAppStore.getState().addQaMessage({ role: 'assistant', content: answer });
    }
  } catch (err) {
    useAppStore.getState().setError({
      code: 'GENERATE_FAIL',
      message: err instanceof Error ? err.message : t('collection.summaryFail'),
    });
  } finally {
    useAppStore.getState().setIsQaGenerating(false);
    useAppStore.getState().setQaRequestId(null);
  }
}
