import { describe, it, expect } from 'vitest';
import { parseCitations, formatPageLabel, clampCitationPage, CITATION_REGEX } from '../citation';

describe('parseCitations', () => {
  it('단일 인용을 3 세그먼트로 분리한다', () => {
    const segments = parseCitations('text [p.12] tail');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toMatchObject({ type: 'text', content: 'text ' });
    expect(segments[1]).toMatchObject({ type: 'citation', page: 12, raw: '[p.12]' });
    expect(segments[2]).toMatchObject({ type: 'text', content: ' tail' });
  });

  it('다중 인용을 올바른 순서로 파싱한다', () => {
    const segments = parseCitations('a [p.1] b [p.2] c');
    const citations = segments.filter((s) => s.type === 'citation');
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.page)).toEqual([1, 2]);
  });

  it('p. 과 숫자 사이 공백을 허용한다', () => {
    const segments = parseCitations('[p. 12]');
    const citation = segments.find((s) => s.type === 'citation');
    expect(citation?.page).toBe(12);
  });

  it('대소문자 무시', () => {
    const segments = parseCitations('[P.5]');
    const citation = segments.find((s) => s.type === 'citation');
    expect(citation?.page).toBe(5);
  });

  it('인용이 없으면 단일 text 세그먼트 반환 (legacy 호환)', () => {
    const segments = parseCitations('plain text without citation');
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ type: 'text', content: 'plain text without citation' });
  });

  it('빈 문자열은 빈 배열', () => {
    expect(parseCitations('')).toEqual([]);
  });

  it('잘못된 포맷 [p.abc] 는 text 로 취급', () => {
    const segments = parseCitations('[p.abc]');
    expect(segments.filter((s) => s.type === 'citation')).toHaveLength(0);
  });

  it('0 페이지는 invalid citation → text 로 보존', () => {
    const segments = parseCitations('[p.0]');
    // 정규식은 매칭하지만 page < 1 이므로 citation 이 아닌 text 로 보존
    expect(segments.filter((s) => s.type === 'citation')).toHaveLength(0);
    expect(segments[0]?.content).toBe('[p.0]');
  });

  it('연속 인용 [p.1][p.2] 도 각각 파싱', () => {
    const segments = parseCitations('[p.1][p.2]');
    const citations = segments.filter((s) => s.type === 'citation');
    expect(citations.map((c) => c.page)).toEqual([1, 2]);
  });

  it('문장 끝 인용 + 마침표', () => {
    const segments = parseCitations('결론[p.12].');
    expect(segments).toHaveLength(3);
    expect(segments[1]).toMatchObject({ type: 'citation', page: 12 });
    expect(segments[2]).toMatchObject({ type: 'text', content: '.' });
  });

  it('CITATION_REGEX 의 g flag 상태 오염이 발생하지 않음 (반복 호출 안전)', () => {
    // 같은 정규식 인스턴스를 여러 번 호출해도 동일 결과가 나와야 함
    const text = 'a [p.1] b [p.2]';
    const first = parseCitations(text);
    const second = parseCitations(text);
    const third = parseCitations(text);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });
});

describe('formatPageLabel', () => {
  it('단일 페이지', () => {
    expect(formatPageLabel(5, 5)).toBe('[p.5]');
    expect(formatPageLabel(5)).toBe('[p.5]');
  });

  it('범위', () => {
    expect(formatPageLabel(5, 7)).toBe('[p.5-7]');
  });

  it('pageStart 없으면 빈 문자열', () => {
    expect(formatPageLabel(undefined, 5)).toBe('');
    expect(formatPageLabel(0)).toBe('');
  });

  it('잘못된 범위(pageEnd < pageStart)는 단일 페이지로 fallback', () => {
    expect(formatPageLabel(10, 5)).toBe('[p.10]');
  });
});

describe('clampCitationPage', () => {
  it('유효 범위 내 페이지 반환', () => {
    expect(clampCitationPage(2, 5)).toBe(2);
    expect(clampCitationPage(1, 5)).toBe(1);
    expect(clampCitationPage(5, 5)).toBe(5);
  });

  it('범위 초과는 null', () => {
    expect(clampCitationPage(6, 5)).toBeNull();
    expect(clampCitationPage(100, 5)).toBeNull();
  });

  it('0 또는 음수는 null', () => {
    expect(clampCitationPage(0, 5)).toBeNull();
    expect(clampCitationPage(-1, 5)).toBeNull();
  });

  it('non-finite 는 null', () => {
    expect(clampCitationPage(NaN, 5)).toBeNull();
    expect(clampCitationPage(Infinity, 5)).toBeNull();
    expect(clampCitationPage(5, NaN)).toBeNull();
  });

  it('소수점은 floor 처리', () => {
    expect(clampCitationPage(3.7, 5)).toBe(3);
  });
});

describe('CITATION_REGEX', () => {
  it('g flag 포함', () => {
    expect(CITATION_REGEX.flags).toContain('g');
  });

  it('i flag 포함 (대소문자 무시)', () => {
    expect(CITATION_REGEX.flags).toContain('i');
  });
});
