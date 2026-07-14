// 요약 마인드맵 — 요약 마크다운의 heading 계층(# ## ###…)을 트리로 파싱하는 순수 함수.
// 외부 의존 0. 각 노드는 섹션(해당 heading ~ 다음 heading 직전) 내 첫 [p.N] 인용을 실어
// 마인드맵 노드 클릭 시 해당 페이지로 점프하는 데 쓴다. citation.ts 의 CITATION_REGEX 를 재사용.

import { CITATION_REGEX } from './citation';

export interface SummaryTreeNode {
  /** 안정적 노드 id (heading 등장 순서 기반). */
  id: string;
  /** heading 레벨 1~6. */
  level: number;
  /** 인용 토큰·강조 마커를 제거한 표시용 제목. */
  title: string;
  /** 섹션 내 첫 [p.N] 인용 페이지(≥1). 없으면 null → 점프 배지 미표시. */
  page: number | null;
  /** 교차 문서 인용(`[문서명 p.N]`)의 출처 문서명. 단일 문서 인용이면 null. CitationButton 라우팅용. */
  docName: string | null;
  children: SummaryTreeNode[];
}

/** 매 호출마다 stateful g-flag 오염을 피하려 fresh RegExp 를 만든다(citation.ts stripCitations 와 동일 원리). */
function freshCitationRe(): RegExp {
  return new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
}

/**
 * heading 텍스트에서 인용 토큰과 "짝을 이룬" 강조 마커만 제거.
 * QA15(A-LOW): 이전엔 `[*_`~]` 를 무조건 제거해 정당한 제목(snake_case `my_doc`, 범위 `2020~2024`,
 * 코드/수식)을 훼손했다. 단일 `_`/`~` 는 보존하고 페어(**·*·__·`·~~)만 벗긴다.
 */
function cleanTitle(raw: string): string {
  return raw
    .replace(freshCitationRe(), '')
    .replace(/\*\*([^*]+?)\*\*/g, '$1')  // **bold**
    .replace(/\*([^*\n]+?)\*/g, '$1')    // *italic* (CommonMark 은 intraword * 허용 → 텍스트뷰와 일관)
    .replace(/__([^_]+?)__/g, '$1')      // __bold__ (단일 _ 는 미제거 → snake_case 보존)
    .replace(/`([^`]+?)`/g, '$1')        // `code`
    .replace(/~~([^~]+?)~~/g, '$1')      // ~~strike~~ (단일 ~ 는 미제거 → 범위 보존)
    .replace(/\s+/g, ' ')
    .trim();
}

/** 텍스트 내 첫 유효 인용(≥1). 없으면 null. 교차 문서 접두 doc 도 함께 추출. */
function firstCitationIn(text: string): { page: number; doc: string | null } | null {
  const m = freshCitationRe().exec(text);
  const raw = m?.groups?.page;
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return null;
  const doc = m?.groups?.doc;
  return { page: n, doc: doc ? doc.trim() : null };
}

interface RawHeading { level: number; title: string; line: number; }

/**
 * 코드펜스를 (선택적으로) 건너뛰며 ATX heading 수집.
 * respectFences=true 로 1차 수집하되 EOF 에서 펜스가 안 닫혔으면(danglingFence) 호출측이
 * respectFences=false 로 재수집한다(QA15 A/B-MED: 미닫힌 stray 펜스가 이후 모든 heading 을 삼켜
 * 마인드맵 구조가 통째로 붕괴하던 것 방지 — 네비게이션 보조용이라 CommonMark 보다 관용적으로 처리).
 */
function collectHeadings(lines: string[], respectFences: boolean): { heads: RawHeading[]; danglingFence: boolean } {
  const heads: RawHeading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (respectFences && /^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // 닫는 `#` 시퀀스(예: `## 제목 ##`)도 허용, 제목만 캡처.
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && h[1] && h[2]) heads.push({ level: h[1].length, title: h[2], line: i });
  }
  return { heads, danglingFence: inFence };
}

/**
 * 요약 마크다운을 heading 계층 트리로 변환.
 * - ATX heading(`#`~`######`)만 인식. 닫힌 코드펜스 안의 `#` 은 무시(미닫힌 펜스는 위 참조).
 * - 레벨 점프(예: `#` 다음 바로 `###`)는 스택으로 그대로 수용(가장 가까운 상위에 부착).
 * - heading 이 하나도 없으면 [] (호출측이 빈 상태 안내를 렌더).
 */
export function parseSummaryToTree(markdown: string): SummaryTreeNode[] {
  if (!markdown) return [];
  const lines = markdown.split('\n');

  // 1) heading 수집. 미닫힌 펜스가 남으면 펜스 무시로 재수집(구조 붕괴 방지).
  const first = collectHeadings(lines, true);
  const heads = first.danglingFence ? collectHeadings(lines, false).heads : first.heads;
  if (heads.length === 0) return [];

  // 2) heading 별 섹션(자기 줄 ~ 다음 heading 직전)에서 첫 인용 추출.
  const flat: SummaryTreeNode[] = heads.map((h, idx) => {
    const next = heads[idx + 1];
    const end = next ? next.line : lines.length;
    const section = lines.slice(h.line, end).join('\n');
    const cite = firstCitationIn(section);
    return {
      id: `mm-${idx}`,
      level: h.level,
      title: cleanTitle(h.title),
      page: cite ? cite.page : null,
      docName: cite ? cite.doc : null,
      children: [],
    };
  });

  // 3) 레벨 기반 스택으로 계층 구성.
  const roots: SummaryTreeNode[] = [];
  const stack: SummaryTreeNode[] = [];
  for (const node of flat) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top && top.level < node.level) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}
