import { describe, it, expect } from 'vitest';
import { labelParagraphsWithPages, labelChaptersWithPages, truncateChunkSummariesForIntegration } from '../use-summarize';
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

  // ─────────────────────────────────────────────────────────────────────────
  // QA23(C-MED): OCR 상한을 4000→12000 으로 올리면서 생긴 경로. 마크다운 표 위주의 OCR
  // 페이지는 빈 줄이 없어 **한 페이지 = 한 단락**이 되는데, 그러면 라벨이 페이지 앞에 하나만
  // 붙는다. 그 단락이 청킹 예산(한글 기준 ~6000자)을 넘으면 두 번째 조각부터는 **라벨이 없어**
  // 그 조각에서 생성된 요약 문장이 인용을 달 수 없거나 다른 페이지 라벨을 잘못 가져간다.
  // 상한이 4000 이던 시절엔 한 페이지가 6000자를 넘을 수 없어 구조적으로 불가능했다.
  // ─────────────────────────────────────────────────────────────────────────
  it('아주 긴 단일 단락 페이지도 조각마다 라벨을 유지한다', () => {
    const huge = '가'.repeat(12000); // 표 위주 OCR 페이지(빈 줄 없음)
    const out = labelParagraphsWithPages([huge]);
    const segments = out.split('\n\n');
    expect(segments.length, '한 덩어리로 남으면 청킹 후 라벨 없는 조각이 생긴다').toBeGreaterThan(1);
    expect(segments.every((s) => s.startsWith('[p.1] ')), '모든 조각이 라벨을 가져야 한다').toBe(true);
    // 본문은 한 글자도 잃지 않는다.
    expect(out.replace(/\[p\.1\] /g, '').replace(/\n\n/g, '')).toBe(huge);
  });

  it('긴 단락을 쪼갤 때 줄 경계를 우선 사용한다 (표 행이 중간에 잘리지 않게)', () => {
    const row = '| 항목 | 값 |';
    const page = Array.from({ length: 400 }, () => row).join('\n'); // 6400자 표
    const out = labelParagraphsWithPages([page]);
    for (const seg of out.split('\n\n')) {
      const body = seg.replace('[p.1] ', '');
      expect(body.startsWith('|'), '조각이 행 중간에서 시작하면 안 된다').toBe(true);
      expect(body.endsWith('|'), '조각이 행 중간에서 끝나면 안 된다').toBe(true);
    }
  });

  it('페이지 번호는 조각 전체에서 정확히 유지된다', () => {
    const out = labelParagraphsWithPages(['짧은 1쪽', '나'.repeat(9000)]);
    expect(out).toContain('[p.1] 짧은 1쪽');
    expect(out).not.toMatch(/\[p\.(?!1\]|2\])\d+\]/); // 1·2 외의 라벨이 생기지 않는다
    const segs = out.split('\n\n').slice(1);
    expect(segs.every((s) => s.startsWith('[p.2] '))).toBe(true);
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
    expect(matches.map((m) => m.groups?.page)).toEqual(['1', '1', '2']);

    // parseCitations 로도 클릭 가능한 citation 세그먼트로 복원되어야 한다
    const citations = parseCitations(out).filter((s) => s.type === 'citation');
    expect(citations).toHaveLength(3);
    expect(citations.map((c) => c.page)).toEqual([1, 1, 2]);
  });
});

/**
 * #10: 멀티청크 통합요약 truncation — 위치기반 절단(slice(0,max))이 후반 청크를 통째로
 * 버려 문서 뒷부분이 통합요약에서 누락되던 문제. 비례 절단으로 전 청크가 대표되는지 가드.
 */
describe('truncateChunkSummariesForIntegration — 통합요약 비례 절단', () => {
  const LABEL = '[...생략]';

  it('예산 내면 원본 그대로 join (절단 라벨 없음)', () => {
    const out = truncateChunkSummariesForIntegration(['A', 'B', 'C'], 1000, LABEL);
    expect(out).toBe('A\n\nB\n\nC');
    expect(out).not.toContain(LABEL);
  });

  it('예산 초과 시 후반 청크가 통째로 누락되지 않고 모든 청크가 대표된다', () => {
    // 각 청크를 식별 가능한 마커로 시작시켜, 절단 후에도 전 청크의 머리글자가 남는지 확인.
    const chunks = Array.from({ length: 6 }, (_, i) => `C${i}:` + 'x'.repeat(100));
    const out = truncateChunkSummariesForIntegration(chunks, 120, LABEL);
    // 위치 절단이었다면 C0~C1 만 남고 C4/C5 는 사라졌을 것 — 비례 절단은 전 청크 머리를 보존
    for (let i = 0; i < 6; i++) expect(out).toContain(`C${i}:`);
    expect(out).toContain(LABEL);
    // 예산 근처로 수렴(라벨/말줄임표 오버헤드 소량 허용)
    expect(out.length).toBeLessThan(120 + LABEL.length + 6 * 3 + 20);
  });

  it('자기 몫보다 짧은 청크는 온전히 보존, 긴 청크만 …로 잘린다', () => {
    const out = truncateChunkSummariesForIntegration(['짧음', 'L'.repeat(500)], 60, LABEL);
    expect(out).toContain('짧음'); // 짧은 청크는 무손실
    expect(out).toContain('…');    // 긴 청크는 말줄임
  });

  it('QA27(B-MED): 절단면이 인용 토큰 한가운데여도 반쪽 토큰을 남기지 않는다', () => {
    // 이 결과물은 **통합 모델의 입력**이다. `[p.123]` 이 `[p.12` 로 남으면 모델이 그것을
    // 완성해 범위 안의 오답 페이지를 확신 있게 인용한다.
    // 절단 지점이 인용 중간에 오도록 본문 길이를 맞춘다.
    const long = 'A'.repeat(60) + '[p.123]' + 'B'.repeat(200);
    for (let budget = 55; budget <= 70; budget++) {
      const out = truncateChunkSummariesForIntegration([long], budget, LABEL);
      expect(out, `budget=${budget} 에서 반쪽 인용이 남았다`).not.toMatch(/\[[^\]\n]*…/);
      // 살아남은 인용은 전부 온전한 토큰으로 재파싱된다.
      for (const seg of parseCitations(out)) {
        if (seg.type === 'citation') expect(seg.page).toBe(123);
      }
    }
  });
});

/**
 * QA27(B-Important): 챕터 경로의 페이지 라벨링.
 *
 * `summarizeByChapter` 안에 라벨링이 **인라인으로 다시 구현**돼 있어서 QA23 의 긴 단락 처리를
 * 받지 못했다 — 순수 함수 테스트(위 describe)가 전부 그린인데 챕터 뷰만 라벨을 잃는 구조였다.
 * 배선을 순수 함수로 뽑았으므로 여기서 그 배선 자체를 가드한다.
 */
describe('labelChaptersWithPages — 챕터 경로 라벨링 배선', () => {
  const chapter = (title: string, startPage: number, endPage: number) =>
    ({ title, text: '', startPage, endPage });

  it('챕터 시작 페이지 오프셋이 절대 페이지 번호로 반영된다', () => {
    const pageTexts = ['1쪽', '2쪽', '3쪽', '4쪽', '5쪽'];
    const out = labelChaptersWithPages([chapter('2장', 3, 5)], pageTexts);
    expect(out[0]!.text).toContain('[p.3] 3쪽');
    expect(out[0]!.text).toContain('[p.5] 5쪽');
    // 챕터 안에서 1부터 다시 세면(오프셋 누락) 인용이 통째로 어긋난다.
    expect(out[0]!.text).not.toContain('[p.1]');
  });

  it('빈 줄 없는 거대 페이지도 챕터 경로에서 조각마다 라벨을 유지한다(QA23 형제 적용)', () => {
    // 인라인 구현으로 되돌아가면(splitLongParagraph 미적용) 이 단언이 깨진다.
    const huge = '가'.repeat(9000); // 표 위주 OCR 페이지
    const out = labelChaptersWithPages([chapter('1장', 4, 4)], ['a', 'b', 'c', huge]);
    const segments = out[0]!.text.split('\n\n');
    expect(segments.length, '한 덩어리로 남으면 청킹 후 라벨 없는 조각이 생긴다').toBeGreaterThan(1);
    expect(segments.every((s) => s.startsWith('[p.4] ')), '모든 조각이 라벨을 가져야 한다').toBe(true);
  });

  it('pageTexts 가 없는 레거시 문서는 챕터 본문을 그대로 통과시킨다', () => {
    const legacy = { ...chapter('1장', 1, 2), text: '원본 본문' };
    expect(labelChaptersWithPages([legacy], undefined)[0]!.text).toBe('원본 본문');
    expect(labelChaptersWithPages([legacy], [])[0]!.text).toBe('원본 본문');
  });

  it('라벨링 결과가 비면(빈 페이지들) 원본 본문으로 폴백한다', () => {
    const ch = { ...chapter('1장', 1, 2), text: '원본 본문' };
    expect(labelChaptersWithPages([ch], ['   ', '\n\n'])[0]!.text).toBe('원본 본문');
  });
});
