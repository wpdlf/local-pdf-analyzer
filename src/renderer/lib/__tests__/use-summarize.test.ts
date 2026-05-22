import { describe, it, expect } from 'vitest';
import { labelParagraphsWithPages } from '../use-summarize';
import { parseCitations, CITATION_REGEX } from '../citation';

/**
 * use-summarize 오케스트레이션 핵심 — 페이지 라벨링(labelParagraphsWithPages) 단위 테스트.
 *
 * 이 함수는 요약 프롬프트의 페이지 인용 정확도를 좌우하는 순수 로직이지만 그동안 미테스트였다.
 * 특히 R35 의 핵심 불변식("citation 라벨은 항상 단일 [p.N], 절대 범위 [p.N-M] 아님")이
 * **요약 경로에도 성립**함을 가드한다 — Q&A 경로(use-qa.ragSearch)는 R35 전까지 범위 라벨에
 * 의존하다 인용 소실을 겪었으나, 요약 경로는 단락별 단일 라벨을 인라인 삽입해 원천 회피한다.
 * 그 사실에 대한 자동 회귀 가드가 없었다.
 */
describe('labelParagraphsWithPages — 요약 경로 페이지 라벨링', () => {
  it('단락마다 1-based 단일 [p.N] 라벨을 앞에 붙인다', () => {
    const out = labelParagraphsWithPages(['첫 페이지 본문']);
    expect(out).toBe('[p.1] 첫 페이지 본문');
  });

  it('한 페이지 내 여러 단락은 모두 같은 페이지 라벨을 받는다', () => {
    const out = labelParagraphsWithPages(['단락 하나\n\n단락 둘\n\n단락 셋']);
    expect(out).toBe('[p.1] 단락 하나\n\n[p.1] 단락 둘\n\n[p.1] 단락 셋');
  });

  it('여러 페이지는 1-based 로 증가하는 라벨을 받는다', () => {
    const out = labelParagraphsWithPages(['1쪽', '2쪽', '3쪽']);
    expect(out).toBe('[p.1] 1쪽\n\n[p.2] 2쪽\n\n[p.3] 3쪽');
  });

  it('빈/공백 페이지는 건너뛰되 페이지 번호(인덱스)는 보존된다', () => {
    // index 1(2쪽)이 비어 있어도 index 2 는 여전히 [p.3] 이어야 한다 (off-by-one 방지).
    const out = labelParagraphsWithPages(['1쪽 내용', '   ', '3쪽 내용']);
    expect(out).toBe('[p.1] 1쪽 내용\n\n[p.3] 3쪽 내용');
    expect(out).not.toContain('[p.2]');
  });

  it('연속된 빈 줄(\\n\\n+)을 단락 경계로 정규화한다', () => {
    const out = labelParagraphsWithPages(['A\n\n\n\nB']);
    expect(out).toBe('[p.1] A\n\n[p.1] B');
  });

  it('빈 입력/전부 공백이면 빈 문자열', () => {
    expect(labelParagraphsWithPages([])).toBe('');
    expect(labelParagraphsWithPages(['', '  ', '\n\n'])).toBe('');
  });

  // ─── R35 불변식 가드 ───

  it('R35: 멀티페이지 입력에도 범위 라벨 [p.N-M] 을 절대 방출하지 않는다', () => {
    const out = labelParagraphsWithPages(['1쪽', '2쪽', '3쪽', '4쪽', '5쪽']);
    expect(out).not.toMatch(/\[p\.\d+-\d+\]/);
  });

  it('R35: 방출된 모든 라벨이 CITATION_REGEX 로 단일 인용으로 재파싱된다 (생산-소비 정합)', () => {
    const out = labelParagraphsWithPages(['첫 단락\n\n둘째 단락', '셋째 페이지']);
    // 라벨 토큰만 추출
    const re = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
    const matches = Array.from(out.matchAll(re));
    // 단락 3개 → 라벨 3개, 모두 단일 페이지
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m[1])).toEqual(['1', '1', '2']);

    // parseCitations 로도 클릭 가능한 citation 세그먼트로 복원되어야 한다
    const citations = parseCitations(out).filter((s) => s.type === 'citation');
    expect(citations).toHaveLength(3);
    expect(citations.map((c) => c.page)).toEqual([1, 1, 2]);
  });
});
