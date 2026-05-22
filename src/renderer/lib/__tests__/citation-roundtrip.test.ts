import { describe, it, expect } from 'vitest';
import { formatPageLabel, parseCitations, CITATION_REGEX } from '../citation';
import { chunkTextWithOverlapByPage } from '../chunker';

/**
 * R35 회귀 가드 — 생산(formatPageLabel) ↔ 소비(CITATION_REGEX/parseCitations) 포맷 정합성.
 *
 * 배경: 기존 단위 테스트는 formatPageLabel 과 parseCitations 를 *따로* 검증할 뿐,
 * "RAG 컨텍스트 라벨로 생산된 문자열이 최종 출력 파서를 통과해 클릭 가능한 인용으로
 * 살아남는가" 라는 **왕복(round-trip)** 은 검증하지 않았다. 바로 이 생산-소비 포맷
 * 드리프트(생산: `[p.N-M]` 범위 라벨 / 소비: 단일 `[p.N]` 만 인식)가 citation 매치율
 * 88.8% 미달의 1차 원인이었다. 이 파일은 두 끝점을 한 테스트에서 연결해 R35 결함 클래스를
 * 영구적으로 가드한다.
 *
 * 데이터 흐름 재현 (use-qa.ts:357 ragSearch 라벨 빌드 → ai-service 프롬프트 → LLM 응답 →
 * safe-markdown parseCitations):
 *   chunk.pageStart → formatPageLabel(pageStart) → 프롬프트 컨텍스트 라벨
 *   → LLM 이 라벨을 문장 끝에 verbatim 복사 → parseCitations 가 클릭 가능한 citation 으로 파싱
 */
describe('R35 round-trip: 라벨 생산 ↔ 인용 소비 포맷 정합성', () => {
  // ragSearch(use-qa.ts:357) 의 라벨 빌드를 동일하게 재현: 항상 단일 인자.
  const buildContextLabel = (pageStart?: number): string => formatPageLabel(pageStart);

  // LLM 이 컨텍스트 라벨을 문장 끝에 그대로 복사하는 동작을 시뮬레이션.
  const llmEchoesLabel = (label: string): string => `핵심 사실 서술입니다${label}.`;

  it('단일 페이지 청크: 라벨이 클릭 가능한 인용으로 왕복한다', () => {
    const label = buildContextLabel(12);
    expect(label).toBe('[p.12]');

    const answer = llmEchoesLabel(label);
    const segments = parseCitations(answer);
    const citations = segments.filter((s) => s.type === 'citation');
    expect(citations).toHaveLength(1);
    expect(citations[0]?.page).toBe(12);
  });

  it('멀티페이지 청크(pageStart≠pageEnd)라도 단일 라벨로 왕복한다 (핵심 회귀)', () => {
    // 과거: formatPageLabel(5, 7) → "[p.5-7]" → LLM 이 복사 → parseCitations 가 단일 [p.5] 만
    //       매칭하려다 "-7]" 에서 실패 → 인용 소실. 이제 생산 측이 단일만 방출.
    const label = buildContextLabel(5); // pageEnd(7) 은 라벨에 영향을 주지 않는다
    expect(label).toBe('[p.5]');
    expect(label).not.toContain('-');

    const segments = parseCitations(llmEchoesLabel(label));
    const citations = segments.filter((s) => s.type === 'citation');
    expect(citations).toHaveLength(1);
    expect(citations[0]?.page).toBe(5);
  });

  it('formatPageLabel 의 모든 유효 출력은 CITATION_REGEX 로 재매칭된다 (포맷 계약)', () => {
    for (const page of [1, 7, 12, 100, 999]) {
      const label = formatPageLabel(page);
      const re = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
      const matches = Array.from(label.matchAll(re));
      expect(matches).toHaveLength(1);
      expect(matches[0]?.[1]).toBe(String(page));
    }
  });

  it('실제 chunker 출력 → 라벨 → 파싱 전 구간 통합 (페이지 경계를 가로지르는 청크)', () => {
    // 짧은 페이지 여러 개를 큰 청크 크기로 묶어, 하나의 청크 body 가 여러 페이지를
    // 가로지르도록 구성한다 (R35 body 기준 귀속에서 pageStart≠pageEnd 가 생기는 조건).
    const pageTexts = ['1쪽 내용', '2쪽 내용', '3쪽 내용', '4쪽 내용', '5쪽 내용'];
    const chunks = chunkTextWithOverlapByPage(pageTexts, 500, 0.1);
    expect(chunks.length).toBeGreaterThanOrEqual(1);

    // 페이지 경계를 가로지르는 청크(범위)가 실제로 존재함을 확인 — 즉 과거라면
    // 범위 라벨 `[p.N-M]` 이 방출됐을 조건. R35 후에는 그래도 단일 라벨이어야 한다.
    const hasMultiPageChunk = chunks.some((c) => c.pageStart !== c.pageEnd);
    expect(hasMultiPageChunk).toBe(true);

    for (const chunk of chunks) {
      const label = buildContextLabel(chunk.pageStart);
      // 라벨은 절대 범위가 아니어야 한다
      expect(label).not.toMatch(/\[p\.\d+-\d+\]/);
      // 그리고 LLM 복사 → 파싱 왕복에서 정확히 chunk.pageStart 인용으로 살아남아야 한다
      const segments = parseCitations(llmEchoesLabel(label));
      const citations = segments.filter((s) => s.type === 'citation');
      expect(citations).toHaveLength(1);
      expect(citations[0]?.page).toBe(chunk.pageStart);
    }
  });

  it('소비 측 한계 문서화: 범위 라벨은 단일 인용으로 파싱되지 않는다 (생산 측이 범위를 내면 안 되는 이유)', () => {
    // 이 테스트는 "왜 생산 측을 단일로 고정해야 하는가" 를 인코딩한다.
    // 범위 라벨이 LLM 출력에 들어오면 parseCitations 는 이를 클릭 가능한 인용으로
    // 복원하지 못한다(소비 측 계약). 따라서 생산 측(formatPageLabel)이 범위를 방출하지
    // 않는 것이 유일하게 견고한 해법이다.
    const segments = parseCitations('범위 라벨 사례[p.5-7].');
    const citations = segments.filter((s) => s.type === 'citation');
    // "[p.5" 부분이 단일로 매칭되지 않음 → 0개 (전체가 텍스트로 보존)
    expect(citations).toHaveLength(0);
  });
});
