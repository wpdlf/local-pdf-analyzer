// 요약 마인드맵 — 요약 마크다운의 heading 계층(# ## ###…)을 트리로 파싱하는 순수 함수.
// 외부 의존 0. 각 노드는 섹션(해당 heading ~ 다음 heading 직전) 내 첫 [p.N] 인용을 page 로 실어
// 마인드맵 노드 클릭 시 해당 페이지로 점프하는 데 쓴다. citation.ts 의 CITATION_REGEX 를 재사용.

import { CITATION_REGEX } from './citation';

export interface SummaryTreeNode {
  /** 안정적 노드 id (heading 등장 순서 기반). */
  id: string;
  /** heading 레벨 1~6. */
  level: number;
  /** 인용 토큰·강조 마커를 제거한 표시용 제목. */
  title: string;
  /** 섹션 내 첫 [p.N] 페이지(1-based). 없으면 null → 점프 배지 미표시. */
  page: number | null;
  children: SummaryTreeNode[];
}

/** 매 호출마다 stateful g-flag 오염을 피하려 fresh RegExp 를 만든다(citation.ts stripCitations 와 동일 원리). */
function freshCitationRe(): RegExp {
  return new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
}

/** heading 텍스트에서 인용 토큰과 기본 강조 마커(* _ ` ~)를 제거. */
function cleanTitle(raw: string): string {
  return raw
    .replace(freshCitationRe(), '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 텍스트 내 첫 유효 인용 페이지(≥1). 없으면 null. */
function firstPageIn(text: string): number | null {
  const m = freshCitationRe().exec(text);
  const raw = m?.groups?.page;
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

interface RawHeading { level: number; title: string; line: number; }

/**
 * 요약 마크다운을 heading 계층 트리로 변환.
 * - ATX heading(`#`~`######`)만 인식. 코드펜스(``` / ~~~) 안의 `#` 은 무시.
 * - 레벨 점프(예: `#` 다음 바로 `###`)는 스택으로 그대로 수용(가장 가까운 상위에 부착).
 * - heading 이 하나도 없으면 [] (호출측이 빈 상태 안내를 렌더).
 */
export function parseSummaryToTree(markdown: string): SummaryTreeNode[] {
  if (!markdown) return [];
  const lines = markdown.split('\n');

  // 1) 코드펜스를 건너뛰며 heading 수집.
  const heads: RawHeading[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // 닫는 `#` 시퀀스(예: `## 제목 ##`)도 허용, 제목만 캡처.
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h && h[1] && h[2]) heads.push({ level: h[1].length, title: h[2], line: i });
  }
  if (heads.length === 0) return [];

  // 2) heading 별 섹션(자기 줄 ~ 다음 heading 직전)에서 첫 인용 페이지 추출.
  const flat: SummaryTreeNode[] = heads.map((h, idx) => {
    const next = heads[idx + 1];
    const end = next ? next.line : lines.length;
    const section = lines.slice(h.line, end).join('\n');
    return { id: `mm-${idx}`, level: h.level, title: cleanTitle(h.title), page: firstPageIn(section), children: [] };
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
