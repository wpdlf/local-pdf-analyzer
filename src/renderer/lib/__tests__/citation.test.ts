import { describe, it, expect } from 'vitest';
import { parseCitations, formatPageLabel, clampCitationPage, CITATION_REGEX, normalizeCitationPlacement, stripCitations } from '../citation';

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

  // v0.18.5 B6 regression — 첫 줄이 단독 citation 일 때 drop 되던 데이터 손실 가드
  it('첫 줄이 단독 인용이면 dropped 되지 않고 보존된다', () => {
    const input = '[p.5]\n핵심 사실 본문';
    const out = normalizeCitationPlacement(input);
    // 인용이 살아있어야 함 (이전: continue 로 drop)
    expect(out).toContain('[p.5]');
  });

  it('연속된 단독 인용 라인 + 본문 → 인용 모두 보존', () => {
    const input = '[p.5]\n[p.6]\n본문 시작';
    const out = normalizeCitationPlacement(input);
    expect(out).toContain('[p.5]');
    expect(out).toContain('[p.6]');
  });

  it('단독 인용으로만 이루어진 답변 (비정상 LLM 응답) 도 인용 정보 보존', () => {
    const input = '[p.7]';
    const out = normalizeCitationPlacement(input);
    expect(out).toContain('[p.7]');
  });
});


describe('formatPageLabel', () => {
  it('단일 페이지', () => {
    expect(formatPageLabel(5)).toBe('[p.5]');
    expect(formatPageLabel(1)).toBe('[p.1]');
  });

  it('page 없거나 1 미만이면 빈 문자열', () => {
    expect(formatPageLabel(undefined)).toBe('');
    expect(formatPageLabel(0)).toBe('');
    expect(formatPageLabel(-3)).toBe('');
  });

  it('소수 페이지는 floor 처리', () => {
    expect(formatPageLabel(5.9)).toBe('[p.5]');
  });

  // R35 회귀 가드: formatPageLabel 은 멀티페이지 청크라도 절대 범위 라벨 `[p.N-M]` 을
  // 방출하지 않아야 한다. 범위 라벨은 CITATION_REGEX 가 인식하지 못해 인용이 소실되며,
  // 이것이 citation 매치율 88.8% 미달의 1차 원인이었다. 단일 라벨만 생산하므로,
  // 그 출력은 항상 CITATION_REGEX 로 다시 파싱 가능해야 한다(생산-소비 포맷 정합성).
  it('범위 라벨을 방출하지 않으며, 출력은 CITATION_REGEX 로 재파싱 가능하다', () => {
    const label = formatPageLabel(7);
    expect(label).not.toMatch(/-/);
    const re = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
    const matches = Array.from(label.matchAll(re));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.groups?.page).toBe('7');
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

// multi-doc Phase 2: 교차 문서 인용 `[문서명 p.N]` 파싱 (후방 호환 — `[p.N]` 은 docName 없음)
describe('parseCitations — 교차 문서 인용 (multi-doc Phase 2)', () => {
  it('단일 문서 인용 [p.N] 은 docName 없음 (후방 호환)', () => {
    const segs = parseCitations('결론 [p.12].');
    const cite = segs.find((s) => s.type === 'citation');
    expect(cite).toMatchObject({ page: 12 });
    expect(cite?.docName).toBeUndefined();
  });

  it('[문서명 p.N] 은 docName + page 파싱', () => {
    const segs = parseCitations('교차 근거 [Beta.pdf p.5] 입니다.');
    const cite = segs.find((s) => s.type === 'citation');
    expect(cite).toMatchObject({ page: 5, docName: 'Beta.pdf' });
  });

  it('공백 포함 한글 문서명도 파싱', () => {
    const segs = parseCitations('[Section 0 소개.pdf p.49] 참고');
    const cite = segs.find((s) => s.type === 'citation');
    expect(cite).toMatchObject({ page: 49, docName: 'Section 0 소개.pdf' });
  });

  it('[p. 5] (p 뒤 공백) 은 docName 으로 오인하지 않음', () => {
    const segs = parseCitations('본문 [p. 5] 끝');
    const cite = segs.find((s) => s.type === 'citation');
    expect(cite).toMatchObject({ page: 5 });
    expect(cite?.docName).toBeUndefined();
  });

  it('stripCitations 는 교차 문서 인용도 제거', () => {
    expect(stripCitations('본문 [Beta.pdf p.5] 끝')).toBe('본문  끝');
  });
});

// v0.18.22 C-L1: single source 통합. `use-qa.splitIntoSentences` 가 인라인 정규식 대신
// 본 헬퍼를 사용 — strip 동작이 CITATION_REGEX 정의와 1:1 매칭됨을 확인.
describe('stripCitations (C-L1)', () => {
  it('단일 [p.N] 인용 제거', () => {
    expect(stripCitations('본문 끝에 [p.5] 인용')).toBe('본문 끝에  인용');
  });

  it('연속 인용 클러스터 모두 제거 (R35 single-label 이후 패턴)', () => {
    expect(stripCitations('본문. [p.5] [p.6] [p.7]')).toBe('본문.   ');
  });

  it('파이프 quote 형태 [p.N|quote] 도 제거', () => {
    expect(stripCitations('A [p.3|some quote] B')).toBe('A  B');
  });

  it('대소문자 무시 — [P.5] 도 제거 (i flag 정합)', () => {
    expect(stripCitations('X [P.5] Y [p.6] Z')).toBe('X  Y  Z');
  });

  it('인용이 없는 텍스트는 그대로 반환', () => {
    expect(stripCitations('plain text no citations')).toBe('plain text no citations');
  });

  it('빈 문자열은 빈 문자열', () => {
    expect(stripCitations('')).toBe('');
  });

  it('인용만 있는 텍스트는 공백만 남는다 (호출자가 trim 처리)', () => {
    expect(stripCitations('[p.1][p.2][p.3]').replace(/\s+/g, '')).toBe('');
  });

  // C-L1 핵심: 매 호출마다 fresh RegExp 생성으로 lastIndex 누적 방지
  it('연속 호출 시 stateful lastIndex 누적 없이 안정적', () => {
    const input = '[p.1] middle [p.2]';
    expect(stripCitations(input)).toBe(' middle ');
    expect(stripCitations(input)).toBe(' middle '); // 두 번째 호출도 동일
    expect(stripCitations(input)).toBe(' middle '); // 세 번째도 동일
  });

  // CITATION_REGEX 가 인식하는 모든 매칭 패턴이 stripCitations 와 동일해야 함 (single source 보장)
  it('CITATION_REGEX 와 strip 동작 1:1 매칭 (single source invariant)', () => {
    const cases = [
      '[p.1]',
      '[p. 5]',     // 공백
      '[P.10]',    // 대문자
      '[p.100|q]', // quote
      '[p.1] middle [p.2]',
    ];
    for (const c of cases) {
      const re = new RegExp(CITATION_REGEX.source, CITATION_REGEX.flags);
      const expected = c.replace(re, '');
      expect(stripCitations(c), `case=${c}`).toBe(expected);
    }
  });
});

// R46 보안: 두 인용 정규식의 ReDoS 회귀 가드. 악성 입력(악성 PDF→LLM 답변)에서도
// 정규식 처리가 선형 시간에 끝나야 한다(과거 isStandaloneCitationLine 지수 / CITATION_REGEX 이차).
describe('ReDoS 회귀 가드 (R46)', () => {
  it('CITATION_REGEX: 닫히지 않은 [ + 다량 공백 입력도 즉시 처리(선형 — 카타스트로픽이면 수 초+)', () => {
    const evil = '[p.' + ' '.repeat(100000);
    const t0 = Date.now();
    stripCitations(evil); // 내부에서 CITATION_REGEX 사용
    parseCitations(evil);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('CITATION_REGEX: 문서명 접두 유사 + 다량 공백도 즉시 처리(선형 — 카타스트로픽이면 수 초+)', () => {
    const evil = '[Annex' + ' '.repeat(100000) + 'x';
    const t0 = Date.now();
    parseCitations(evil);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('normalizeCitationPlacement: 한 줄 다수 인용 클러스터 + 비매칭 꼬리도 즉시 처리(선형 — 카타스트로픽이면 수 초+)', () => {
    const evil = '[p.5] '.repeat(2000) + 'x'; // 과거 standalone 정규식의 지수 백트래킹 트리거
    const t0 = Date.now();
    normalizeCitationPlacement(evil);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
