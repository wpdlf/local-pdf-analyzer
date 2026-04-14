import { describe, it, expect } from 'vitest';
import { parseCitations, formatPageLabel, clampCitationPage, CITATION_REGEX, normalizeCitationPlacement } from '../citation';

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

  // 레거시 quote 포맷 호환 — DR-03 하이라이트 기능은 제거됐지만 LLM 이 여전히
  // `[p.N|quote]` 를 생성할 수 있어 정규식이 이를 인식하되 quote 는 무시해야 함.
  it('quote 포함 형식 [p.12|원문] 도 page 만 추출 (quote 는 drop)', () => {
    const segments = parseCitations('결론[p.12|메모리 누수]');
    const citation = segments.find((s) => s.type === 'citation');
    expect(citation?.page).toBe(12);
    // quote 필드 자체가 interface 에서 제거됨
    expect((citation as { quote?: string }).quote).toBeUndefined();
  });

  it('quote 포함 + 연속 인용도 정상 파싱', () => {
    const segments = parseCitations('사실1[p.1|first] 사실2[p.2|second]');
    const citations = segments.filter((s) => s.type === 'citation');
    expect(citations).toHaveLength(2);
    expect(citations.map((c) => c.page)).toEqual([1, 2]);
  });
});

describe('normalizeCitationPlacement', () => {
  it('괄호로 감싸진 인용 `([p.5])` → `[p.5]`', () => {
    expect(normalizeCitationPlacement('문장 ([p.5]).')).toBe('문장 [p.5].');
  });

  it('괄호 내부 공백 허용 `( [p.5] )`', () => {
    expect(normalizeCitationPlacement('문장 ( [p.5] ).')).toBe('문장 [p.5].');
  });

  it('quote 포함 인용도 괄호 해제 `([p.5|quote])`', () => {
    expect(normalizeCitationPlacement('문장 ([p.5|원문 조각]).')).toBe('문장 [p.5|원문 조각].');
  });

  it('여러 괄호 인용 동시 해제', () => {
    const input = '사실 A ([p.1]). 사실 B ([p.2]).';
    expect(normalizeCitationPlacement(input)).toBe('사실 A [p.1]. 사실 B [p.2].');
  });

  it('독립 라인 `- [p.44]` 를 이전 문장 끝에 부착', () => {
    const input = '핵심 결론은 다음과 같다.\n- [p.44]';
    const out = normalizeCitationPlacement(input);
    expect(out).toContain('[p.44]');
    // 더 이상 독립 bullet 라인이 없어야 함
    expect(out).not.toMatch(/^-\s*\[p\.44\]/m);
  });

  it('독립 라인의 여러 인용 모두 이전 라인에 부착', () => {
    const input = '결론은 중요하다.\n- [p.10]\n- [p.11]';
    const out = normalizeCitationPlacement(input);
    expect(out).toContain('[p.10]');
    expect(out).toContain('[p.11]');
    expect(out.split('\n').filter((l) => /^-\s*\[p\./.test(l))).toHaveLength(0);
  });

  it('bullet 없는 단독 `[p.5]` 라인도 부착', () => {
    const input = '핵심 사실\n[p.5]';
    const out = normalizeCitationPlacement(input);
    expect(out).toBe('핵심 사실[p.5]');
  });

  it('이전 문장 끝 마침표 앞에 삽입', () => {
    const input = '결론이다.\n- [p.5]';
    const out = normalizeCitationPlacement(input);
    expect(out).toBe('결론이다[p.5].');
  });

  it('정상 인용은 건드리지 않음', () => {
    const input = '메모리 누수[p.12]. 해결책은 pipe[p.13].';
    expect(normalizeCitationPlacement(input)).toBe(input);
  });

  it('빈/공백 입력', () => {
    expect(normalizeCitationPlacement('')).toBe('');
    expect(normalizeCitationPlacement('   ')).toBe('   ');
  });

  it('일반 괄호 표현은 건드리지 않음', () => {
    const input = '함수 (foo) 는 인자를 받는다[p.3].';
    expect(normalizeCitationPlacement(input)).toBe(input);
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
