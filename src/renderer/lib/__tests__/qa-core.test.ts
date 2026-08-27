import { describe, it, expect, vi } from 'vitest';

// sanitizePromptInput / extractKeywords / selectRelevantChunks 는
// window.electronAPI 의존성이 없지만, 같은 모듈의 다른 함수가 import 시 접근하므로 stub.
vi.stubGlobal('window', {
  electronAPI: {
    ai: { embed: vi.fn(), abort: vi.fn(() => Promise.resolve()) },
  },
});
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { sanitizePromptInput, extractKeywords, selectRelevantChunks, countKeywordOccurrences } from '../use-qa';

// ─── L1-C01: sanitizePromptInput ─────────────────────────────────────────
describe('sanitizePromptInput (L1-C01)', () => {
  it('C01-01: 평범한 텍스트는 변화 없음', () => {
    expect(sanitizePromptInput('hello world')).toBe('hello world');
  });

  it('C01-02: 단독 라인 "---" 은 이스케이프', () => {
    expect(sanitizePromptInput('---')).toBe('\\-\\-\\-');
  });

  it('C01-03: 멀티라인 중 "---" 라인 이스케이프, 주변 유지', () => {
    expect(sanitizePromptInput('prefix\n---\nsuffix')).toBe('prefix\n\\-\\-\\-\nsuffix');
  });

  it('C01-04: 앞 공백 "   ---" 도 이스케이프 (whitespace padding 우회 방어)', () => {
    expect(sanitizePromptInput('   ---')).toBe('\\-\\-\\-');
  });

  it('C01-04b: 뒤 공백 "--- " 도 이스케이프', () => {
    expect(sanitizePromptInput('---   ')).toBe('\\-\\-\\-');
  });

  it('C01-05: "[질문]" 라인 시작 이스케이프', () => {
    expect(sanitizePromptInput('[질문]\n본문')).toBe('\\[질문\\]\n본문');
  });

  it('C01-06: 라인 중간 "[질문]" 은 이스케이프 대상 아님', () => {
    expect(sanitizePromptInput('text [질문] here')).toBe('text [질문] here');
  });

  it('C01-07: 5 마커 혼합 멀티라인 모두 이스케이프', () => {
    const input = '[질문]\n[이전 대화]\n[요약 내용]\n[원문 관련 부분]\n---';
    const expected = '\\[질문\\]\n\\[이전 대화\\]\n\\[요약 내용\\]\n\\[원문 관련 부분\\]\n\\-\\-\\-';
    expect(sanitizePromptInput(input)).toBe(expected);
  });

  it('C01-08: 빈 문자열', () => {
    expect(sanitizePromptInput('')).toBe('');
  });

  it('C01-09: 연속 "---" 두 줄 모두 이스케이프', () => {
    expect(sanitizePromptInput('---\n---')).toBe('\\-\\-\\-\n\\-\\-\\-');
  });

  it('C01-10: 공백 padding 한 [질문] 도 이스케이프', () => {
    expect(sanitizePromptInput('  [질문] rest')).toBe('\\[질문\\] rest');
  });
});

// ─── L1-C02: extractKeywords ─────────────────────────────────────────────
describe('extractKeywords (L1-C02)', () => {
  it('C02-01: 영문 구두점 제거 + stopwords 제외', () => {
    expect(extractKeywords('What is the main idea?')).toEqual(['main', 'idea']);
  });

  it('C02-02: 빈 문자열은 []', () => {
    expect(extractKeywords('')).toEqual([]);
  });

  it('C02-03: 공백만 있는 입력은 []', () => {
    expect(extractKeywords('   ')).toEqual([]);
  });

  it('C02-04: 한국어 조사 포함 단어는 그대로 — 형태소 미분리 (의도된 제한)', () => {
    expect(extractKeywords('딥러닝 모델의 성능은?')).toEqual(['딥러닝', '모델의', '성능은']);
  });

  it('C02-05: 모두 stopwords 면 []', () => {
    expect(extractKeywords('the a an is')).toEqual([]);
  });

  it('C02-06: 길이 2 키워드는 통과', () => {
    expect(extractKeywords('AI')).toEqual(['ai']);
  });

  it('C02-07: 길이 1 키워드는 필터', () => {
    expect(extractKeywords('A B C')).toEqual([]);
  });

  it('C02-08: 대소문자 정규화 (lowercase)', () => {
    expect(extractKeywords('Deep Learning GPU')).toEqual(['deep', 'learning', 'gpu']);
  });

  it('C02-09: 이모지는 공백 제거 대상 아님 — 한 토큰', () => {
    expect(extractKeywords('hello😀world')).toEqual(['hello😀world']);
  });

  it('C02-10: CJK + 영문 혼합', () => {
    expect(extractKeywords('PDF의 RAG란 무엇?')).toEqual(['pdf의', 'rag란', '무엇']);
  });
});

// ─── countKeywordOccurrences: TF 카운트 (워드바운더리 vs substring) ──────────
describe('countKeywordOccurrences', () => {
  it('ASCII 키워드는 워드바운더리로 매칭 — 부분문자열 오탐 제거', () => {
    // 이전 substring 카운트: 'ai' 가 'said'/'rain' 안에서 매칭되어 TF 부풀림
    expect(countKeywordOccurrences('he said it would rain again', 'ai')).toBe(0);
  });

  it('ASCII 키워드 — 독립 단어만 카운트', () => {
    expect(countKeywordOccurrences('ai models and ai agents use ai', 'ai')).toBe(3);
  });

  it('ASCII 키워드 — 부분문자열은 제외하고 단어만 카운트', () => {
    // 'art' 는 'start'/'partly' 안에 있지만 독립 'art' 1회만
    expect(countKeywordOccurrences('art is in start and partly art again', 'art')).toBe(2);
  });

  it('CJK/Hangul 키워드는 substring 카운트 유지 (공백 경계 없음)', () => {
    expect(countKeywordOccurrences('인공지능은 인공지능이다 인공지능', '인공지능')).toBe(3);
  });

  it('매칭 없으면 0', () => {
    expect(countKeywordOccurrences('completely different text', 'zeta')).toBe(0);
  });
});

// ─── L1-C03: selectRelevantChunks ────────────────────────────────────────
describe('selectRelevantChunks (L1-C03)', () => {
  // MAX_QA_CONTEXT_CHARS = 8000 (use-qa.ts:9)
  const LIMIT = 8000;

  it('C03-01: fullText <= 8000자 이면 원문 반환', () => {
    const text = 'A'.repeat(5000);
    expect(selectRelevantChunks('question', text, 1000)).toBe(text);
  });

  it('C03-02: 경계값 8000자 정확 — 원문 반환', () => {
    const text = 'A'.repeat(LIMIT);
    expect(selectRelevantChunks('question', text, 1000)).toBe(text);
  });

  it('C03-03: 청크 1개로 쪼개지는 경우 — slice(0, 8000) 반환', () => {
    // chunkText 로 1개 청크만 나오는 크기 — maxChunkSize 크게 하면 긴 텍스트도 1개 청크
    const text = 'A'.repeat(10000);
    const result = selectRelevantChunks('question', text, 50000);
    expect(result.length).toBeLessThanOrEqual(LIMIT);
  });

  it('C03-04: 키워드 stopwords 만 — 첫+끝 청크 fallback', () => {
    // 구분 가능한 고유 prefix 로 청크를 만들고 키워드가 stopwords 만 포함되도록
    const chunk = (prefix: string) => `${prefix} ${'x'.repeat(2000)}`;
    const text = [chunk('FIRST'), chunk('MIDDLE'), chunk('LAST')].join('\n\n');
    const result = selectRelevantChunks('the a an is', text, 2100);
    expect(result).toContain('FIRST');
    expect(result).toContain('LAST');
    expect(result.length).toBeLessThanOrEqual(LIMIT);
  });

  it('C03-05: 키워드 매칭 청크가 있으면 TF 스코어 상위 청크 반환', () => {
    const chunk = (prefix: string, body: string) => `${prefix} ${body} ${'filler '.repeat(200)}`;
    const text = [
      chunk('FIRST', 'apple apple apple'),
      chunk('MIDDLE', 'orange'),
      chunk('LAST', 'banana'),
    ].join('\n\n');
    const result = selectRelevantChunks('apple', text, 2000);
    expect(result).toContain('FIRST');
    expect(result).toContain('apple');
  });

  it('C03-06: 모든 청크 score=0 이면 첫+끝 fallback', () => {
    const chunk = (prefix: string) => `${prefix} ${'x'.repeat(2000)}`;
    const text = [chunk('FIRST'), chunk('MIDDLE'), chunk('LAST')].join('\n\n');
    // 매칭되지 않을 단어
    const result = selectRelevantChunks('zeta', text, 2100);
    expect(result).toContain('FIRST');
    expect(result).toContain('LAST');
  });

  // QA28(★ A-Important): 입력은 `[p.N]` 라벨이 박힌 텍스트이고 결과는 모델 입력이다. 8000자
  // 절단이 `[p.123]` 한가운데 떨어지면 `[p.` 가 남고, 모델이 `[p.123]` 으로 완성하면 범위 안의
  // 정상 버튼처럼 보이는 오답 인용이 된다. 세 폴백 slice 전부(단일 청크 / 키워드 없음 / 무득점).
  describe('QA28(★): 절단이 [p.N] 한가운데 떨어져도 반쪽 인용 토큰이 남지 않는다', () => {
    const DANGLING = /\[[^\]\n]*$/;

    it('단일 청크 폴백', () => {
      const text = 'A'.repeat(LIMIT - 3) + '[p.123]' + 'B'.repeat(200);
      const result = selectRelevantChunks('question', text, 50000);
      expect(result.length).toBeLessThanOrEqual(LIMIT);
      expect(result).not.toMatch(DANGLING);
      expect(result).not.toContain('[p.');
    });

    // 첫+끝 청크 join 의 8000자 위치에 라벨이 걸치도록 끝 청크를 구성한다.
    const first = `FIRST ${'x'.repeat(4000)}`;                       // 4006자
    const middle = `MIDDLE ${'y'.repeat(4000)}`;
    const lastPrefix = `LAST ${'z'.repeat(LIMIT - 3 - (first.length + 2) - 5)}`; // join 후 [ 가 7997 에 오도록
    const last = `${lastPrefix}[p.123]${'z'.repeat(300)}`;
    const text = [first, middle, last].join('\n\n');

    it('픽스처 자체 검증: join 의 8000자 절단이 `[p.` 뒤에서 잘린다', () => {
      const joined = [first, last].join('\n\n');
      expect(joined.slice(0, LIMIT)).toMatch(/\[p\.$/);
    });

    it('키워드 없음(stopwords 만) 폴백', () => {
      const result = selectRelevantChunks('the a an is', text, 1200);
      expect(result).toContain('FIRST');
      expect(result).toContain('LAST');
      expect(result).not.toMatch(DANGLING);
      expect(result).not.toContain('[p.');
    });

    it('전 청크 무득점 폴백', () => {
      const result = selectRelevantChunks('zeta', text, 1200);
      expect(result).toContain('FIRST');
      expect(result).toContain('LAST');
      expect(result).not.toMatch(DANGLING);
      expect(result).not.toContain('[p.');
    });
  });

  it('C03-07: 빈 fullText — 8000자 이하로 간주되어 원문 반환', () => {
    expect(selectRelevantChunks('question', '', 1000)).toBe('');
  });

  it('C03-08: 결과 길이가 MAX_QA_CONTEXT_CHARS 근처 (join 구분자 오버헤드 허용)', () => {
    // totalLen 체크는 chunk.length 만 합산하므로 join('\n\n') 의 2*(n-1) 바이트는 초과 가능.
    // 실질 LLM 컨텍스트 영향 무시할 수준이나 불변식 경계를 문서화.
    const longText = 'apple '.repeat(5000);
    const result = selectRelevantChunks('apple', longText, 1000);
    expect(result.length).toBeLessThanOrEqual(LIMIT + 100);
  });

  it('C03-09: 유니코드/이모지 혼합 long text — 정상 처리', () => {
    const chunk = (prefix: string) => `${prefix} 🚀 유니코드 ${'x'.repeat(2000)}`;
    const text = [chunk('FIRST'), chunk('MIDDLE'), chunk('LAST')].join('\n\n');
    const result = selectRelevantChunks('유니코드', text, 2100);
    expect(result.length).toBeLessThanOrEqual(LIMIT);
    expect(result).toMatch(/FIRST|MIDDLE|LAST/);
  });

  it('C03-10: 원본 인덱스 순서 보존 (최종 청크 정렬 a.idx - b.idx)', () => {
    const chunk = (prefix: string, body: string) => `${prefix} ${body} ${'filler '.repeat(100)}`;
    const text = [
      chunk('FIRST', 'apple'),       // score=1
      chunk('MIDDLE', 'apple apple'), // score=2
      chunk('LAST', 'apple'),         // score=1
    ].join('\n\n');
    const result = selectRelevantChunks('apple', text, 1000);
    // 점수 순서로 뽑혀도 최종 출력은 원본 인덱스 오름차순
    const firstIdx = result.indexOf('FIRST');
    const middleIdx = result.indexOf('MIDDLE');
    const lastIdx = result.indexOf('LAST');
    const present = [firstIdx, middleIdx, lastIdx].filter((i) => i >= 0);
    const sorted = [...present].sort((a, b) => a - b);
    expect(present).toEqual(sorted);
  });
});

// QA22(A-LOW): 키워드 폴백 TF 스코어링이 `[p.N]` 라벨에 오염되던 결함.
// QA21 이 폴백 컨텍스트에 페이지 라벨을 붙이면서(인용 날조 방지) 생긴 부작용 —
// countKeywordOccurrences 의 ASCII 분기가 `\b12\b` 로 매칭하는데 `[p.12]` 는 앞 `.` 과 뒤 `]` 가
// 모두 워드바운더리라 라벨이 그대로 키워드 히트로 잡혔다. 한 페이지가 10문단이면 그 청크에
// `[p.20]` 이 10회 → 본문 키워드의 1~5회를 압도하고, 예산이 사실상 2청크뿐이라 컨텍스트의
// 절반이 무관한 페이지로 채워질 수 있다.
describe('selectRelevantChunks — 인용 라벨이 스코어링을 오염시키지 않는다 (QA22)', () => {
  // 취약 경로는 **ASCII 키워드 분기**다. countKeywordOccurrences 는 `^[a-z0-9]+$` 인 키워드만
  // `<kw>` 정규식으로 매칭하는데, `[p.15]` 는 앞 `.` 과 뒤 `]` 가 모두 워드바운더리라
  // 숫자 키워드 `15` 가 라벨에 그대로 히트한다(한글 키워드는 substring 경로라 무관).
  it('숫자 키워드가 [p.N] 라벨에만 일치하는 청크를 선택하지 않는다', () => {
    // labelParagraphsWithPages 의 실제 출력 형태 — **단락마다** 라벨이 붙는다(그게 증폭의 원인).
    // A: 라벨 [p.15] 가 200번 반복되지만 본문은 질문과 무관 → 구 코드에선 키워드 '15' 가 200회 히트.
    const SEP = '\n\n';
    // 실제 증폭 구조: 무관한 페이지 A 는 **단락마다** [p.15] 라벨을 달아 키워드 '15' 가 청크당
    // 수십 회 히트하는 반면, 근거가 있는 페이지 B 는 본문에 'figure 15' 가 몇 번만 나온다.
    // 구 코드(라벨 포함 스코어링)에서는 A 가 압도해 예산을 전부 먹고 B 가 아예 선택되지 않았다.
    const pageA = Array.from({ length: 300 }, () => '[p.15] unrelated filler about weather today.').join(SEP);
    const pageB = Array.from({ length: 60 }, (_, i) =>
      (i % 12 === 0 ? '[p.2] figure 15 shows the revenue curve.' : '[p.2] generic body sentence with no match.'),
    ).join(SEP);
    const full = pageA + SEP + pageB;

    const picked = selectRelevantChunks('figure 15 explanation', full, 2000);

    expect(picked, '본문에 근거가 있는 쪽이 선택돼야 한다').toContain('figure 15 shows');
  });

  it('반환값에는 라벨이 그대로 남는다 (인용 생성에 필요)', () => {
    const page = '[p.7] ' + 'core content repeats here. '.repeat(400);
    const picked = selectRelevantChunks('core content', `${page}\n\n${page}`, 4000);
    expect(picked).toContain('[p.7]');
  });
});
