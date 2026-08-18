// normalizeMathDelimiters — `\(…\)` / `\[…\]` → `$$…$$` 정규화.
//
// 이 변환이 필요한 이유는 ai-service 의 CITATION_RULES 가 LLM 에게 수식을 `\(E=mc^2\)` 로 내라고
// 가르치는데 remark-math 는 `$`/`$$` 만 알기 때문이다. 아래 테스트는 "바꿔야 할 것을 바꾸는가"
// 만큼이나 **"바꾸면 안 되는 것을 그대로 두는가"** 를 본다 — 후자가 실제 회귀 위험이다.
import { describe, it, expect } from 'vitest';
import { normalizeMathDelimiters } from '../math-normalize';

describe('normalizeMathDelimiters — 변환', () => {
  it('인라인 `\\(…\\)` 를 `$$…$$` 로 바꾼다', () => {
    expect(normalizeMathDelimiters('수식 \\(E=mc^2\\)은 등가성이다.'))
      .toBe('수식 $$E=mc^2$$은 등가성이다.');
  });

  it('display `\\[…\\]` 도 바꾼다', () => {
    expect(normalizeMathDelimiters('\\[\\int_0^1 x\\,dx\\]'))
      .toBe('$$\\int_0^1 x\\,dx$$');
  });

  it('display 는 여러 줄을 허용한다', () => {
    expect(normalizeMathDelimiters('\\[a\n+ b\\]')).toBe('$$a\n+ b$$');
  });

  it('구분자가 각각 다른 줄에 있는 표준형을 잡는다', () => {
    // LLM 이 display 수식을 내는 가장 흔한 형태. 줄 단위로 처리하면 한 건도 못 잡는다.
    expect(normalizeMathDelimiters('앞\n\n\\[\nE = mc^2\n\\]\n\n뒤'))
      .toBe('앞\n\n$$\nE = mc^2\n$$\n\n뒤');
  });

  it('한 문장에 여러 수식이 있어도 모두 바꾼다', () => {
    expect(normalizeMathDelimiters('\\(a\\) 와 \\(b\\) 는 다르다'))
      .toBe('$$a$$ 와 $$b$$ 는 다르다');
  });

  it('인용 라벨과 붙어 있어도 인용을 훼손하지 않는다', () => {
    // CitationButton 은 렌더 단계에서 [p.8] 을 잡는다 — 여기서는 문자열이 보존되기만 하면 된다.
    expect(normalizeMathDelimiters('수식 \\(E=mc^2\\)은 등가성이다[p.8].'))
      .toBe('수식 $$E=mc^2$$은 등가성이다[p.8].');
  });

  it('줄 구조를 보존한다 — display 가 자기 줄이면 자기 줄로 남는다', () => {
    // `$$` 는 자기 줄이면 block, 문장 안이면 inline 으로 렌더된다. 원문 줄바꿈을 건드리지
    // 않는 것이 그 구분을 그대로 물려받는 유일한 방법이다.
    expect(normalizeMathDelimiters('앞 문단\n\n\\[x^2\\]\n\n뒤 문단'))
      .toBe('앞 문단\n\n$$x^2$$\n\n뒤 문단');
  });
});

describe('normalizeMathDelimiters — 건드리면 안 되는 것', () => {
  it('통화 표기($)는 그대로 둔다', () => {
    // 이 케이스가 `singleDollarTextMath: false` + `$$` 통일을 택한 이유다.
    const src = '가격은 $100 에서 $200 로 올랐다';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('펜스 코드블록 안의 `\\(` 는 그대로 둔다', () => {
    const src = '설명\n\n```js\nconst re = /\\(a\\)/;\n```\n\n끝';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('물결 펜스(~~~)도 코드블록으로 인식한다', () => {
    const src = '~~~\n\\(not math\\)\n~~~';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('인라인 코드 스팬 안의 `\\(` 는 그대로 두고 바깥은 바꾼다', () => {
    expect(normalizeMathDelimiters('`\\(literal\\)` 이지만 \\(x\\) 는 수식'))
      .toBe('`\\(literal\\)` 이지만 $$x$$ 는 수식');
  });

  it('짝이 없는 여는 구분자는 원문 그대로 흘린다', () => {
    const src = '괄호만 \\( 열려 있다';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('빈 내용은 수식으로 보지 않는다', () => {
    expect(normalizeMathDelimiters('잔해 \\(\\) 남음')).toBe('잔해 \\(\\) 남음');
  });

  it('이스케이프된 인용 라벨 `\\[p.3\\]` 을 수식으로 만들지 않는다', () => {
    // LLM 이 대괄호를 이스케이프해 내는 경우. `$$p.3$$` 이 되면 인용 버튼이 수식으로 둔갑한다.
    const src = '근거 \\[p.3\\] 참고';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  // QA25(A-IMP): 이 자리에 있던 테스트는 `\[a.pdf | p.3\]`(파이프 구분)을 단언했는데,
  // **이 앱은 그런 라벨을 만들지 않는다**. use-qa 가 만드는 것은 `[문서명 p.N]`(공백 구분)이고
  // sanitizeDocLabelName 이 파일명의 `|` 를 공백으로 지우므로 파이프 형태는 발생조차 못 한다.
  // 즉 옛 테스트는 존재하지 않는 문법에 대한 그린이었고, 실제 라벨은 커버리지 밖에서
  // 수식으로 둔갑해 인용 버튼이 사라지고 있었다. 실제 생산되는 형태로 교체한다.
  describe('실제로 생산되는 인용 라벨을 보존한다 (QA25 회귀)', () => {
    it.each([
      ['단일 문서', '\\[p.3\\]'],
      ['교차 문서(공백 구분 — use-qa 가 만드는 형태)', '\\[Beta.pdf p.5\\]'],
      ['공백이 든 파일명', '\\[Report 2024.pdf p.12\\]'],
      ['quote 꼬리', '\\[p.5|인용문\\]'],
      ['페이지 앞 공백', '\\[p. 12\\]'],
    ])('%s', (_label, token) => {
      const src = `근거 ${token} 참고`;
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('인용 모양이 아니면 정상적으로 수식이 된다 (가드가 과잉 차단하지 않는다)', () => {
      expect(normalizeMathDelimiters('식 \\[E=mc^2\\] 참고')).toContain('$$E=mc^2$$');
      // p.N 을 품고 있어도 인용 라벨 전체 형태가 아니면 수식이다.
      expect(normalizeMathDelimiters('\\[x = p.3 + 1\\]')).toContain('$$');
    });
  });

  it('인라인 구분자가 줄바꿈을 넘으면 우연히 맞은 괄호로 보고 두드리지 않는다', () => {
    const src = '문장 \\(여기서\n줄이 바뀐다\\) 끝';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('display 도 빈 줄(단락 경계)은 넘지 않는다', () => {
    const src = '\\(a\\]\n\n\\[b\\)'; // 짝이 어긋난 경우 포함
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('이미 `$` 를 품은 내용은 중첩 구분자가 되므로 바꾸지 않는다', () => {
    const src = '\\(a $ b\\)';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  it('후보 구분자가 없으면 원본을 그대로 돌려준다(빠른 경로)', () => {
    const src = '# 제목\n\n평범한 **본문** 입니다[p.1].';
    expect(normalizeMathDelimiters(src)).toBe(src);
  });

  // QA25(C-MED): 짝 없는 여는 구분자에서 O(n²) 였다 — 100KB 입력이 렌더러를 3.5초 동결시켰다.
  // Ollama 는 출력 길이 상한이 없어 소형 모델이 반복 루프에 빠지면 적대적 입력 없이도 도달하고,
  // Q&A 라이브 스트림은 50ms flush 마다 누적 텍스트 전체를 재정규화해 비용이 누적된다.
  // 판정은 **절대 상한**으로 한다.
  //
  // 처음에는 성장률(입력 5배 → 시간이 5배인가 25배인가)로 썼는데 **CI 에서 플레이크였다**
  // (ratio 13.3 > 상한 12 로 실패). 원인을 실측해 보니 이 함수는 수정 후 너무 빨라서 한 번
  // 측정한 시간이 타이머 해상도 근처이고, 그 작은 분모가 비율을 요동시킨다 — 단일 측정
  // ratio 가 **1.50~14.74** 로 흩어졌다(반복 측정하면 3.1~4.7 로 안정되지만, 그러려고
  // 테스트를 무겁게 만들 이유가 없다).
  //
  // 실제로 지켜야 할 성질은 "렌더러가 얼지 않는다" 이고, 그건 절대 시간으로 표현하는 것이
  // 맞다. 실측(2026-08-18): 195KB 병리 입력 **약 5ms**. 수정 전에는 98KB 가 **3547ms** 였다.
  // 상한 500ms 는 정상 동작 대비 100배 여유이고, 깨진 구현이면 같은 입력에서 초 단위가 되어
  // 수십 배 초과한다 — 러너가 느려도 두 상태는 섞이지 않는다.
  describe('병리 입력에서 선형으로 동작한다 (QA25 회귀)', () => {
    const PATHOLOGICAL_BUDGET_MS = 500;

    it.each([
      ['\\(', '\\('],
      ['\\[', '\\['],
    ])('짝 없는 %s 반복(195KB)이 예산 안에 끝난다', (_label, open) => {
      const input = open.repeat(100_000);
      // 빠른 경로(구분자 부재 시 원본 반환)로 빠지면 측정이 무의미해진다 — 전제를 고정한다.
      expect(input.includes('\\(') || input.includes('\\[')).toBe(true);

      const t = performance.now();
      const out = normalizeMathDelimiters(input);
      const elapsed = performance.now() - t;

      expect(elapsed).toBeLessThan(PATHOLOGICAL_BUDGET_MS);
      expect(out).toBe(input); // 짝이 없으므로 원문 그대로여야 한다
    });

    it('병리 입력이어도 내용은 원문 그대로 보존된다', () => {
      const src = '\\('.repeat(500);
      expect(normalizeMathDelimiters(src)).toBe(src);
    });
  });

  describe('구분자 경계 처리 (QA25 회귀)', () => {
    it('이스케이프된 백슬래시는 한 토큰으로 소비한다', () => {
      // 사용자가 `\(x\)` 를 리터럴로 보이려고 이스케이프한 경우. 이전엔 두 번째 백슬래시부터
      // 매칭돼 `\$$x\$$` 같은 깨진 출력이 나왔다.
      const src = '\\\\(x\\\\)';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('LaTeX 정렬 관용구 `\\\\[6pt]` 를 깨뜨리지 않는다', () => {
      const src = '\\\\[6pt]';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('경계에 리터럴 `$` 가 붙어 있으면 치환하지 않는다', () => {
      // `비용 $\(x\)` → `비용 $$$x$$` 는 여는 런 3·닫는 런 2 라 수식으로 파싱되지도 않고
      // 사용자는 깨진 리터럴을 본다 — 변환 전보다 나쁘다.
      const src = '비용 $\\(x\\)';
      expect(normalizeMathDelimiters(src)).toBe(src);
      expect(normalizeMathDelimiters('\\(x\\)$')).toBe('\\(x\\)$');
    });
  });

  describe('코드 보호 경계 (QA25 회귀)', () => {
    // ⚠️ 이 두 테스트는 **틸드 펜스**와 **뒤쪽 백틱 짝**을 일부러 쓴다. 처음에 백틱 펜스로
    // 썼더니 뮤테이션(펜스 들여쓰기 제한 복원)이 잡히지 않았다 — 펜스 인식이 실패해도 백틱
    // 3개가 인라인 코드 스팬으로 매칭돼 우연히 보호됐기 때문이다. 마찬가지로 짝 없는 백틱
    // 하나만 두면 옛 정규식도 매칭 자체를 못 해 차이가 드러나지 않았다.
    it('리스트 항목 안의 펜스도 코드로 인식한다', () => {
      // 이전엔 펜스 인식이 앞 공백 3칸까지라 리스트 안의 펜스를 놓쳤고, 코드 예제의 `\(` 가
      // 수식으로 둔갑해 사용자가 보는 것이 원문과 달라졌다.
      const src = '- 항목:\n\n    ~~~js\n    const re = /\\(a\\)/;\n    ~~~\n';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('짝 없는 백틱이 단락을 넘어 뒤쪽 수식을 삼키지 않는다', () => {
      // 마크다운의 코드 스팬은 빈 줄을 넘지 못한다. 이전엔 `[\s\S]*?` 라 넘었고, 짝이 안 맞는
      // 백틱 하나가 훨씬 뒤의 백틱과 "코드 스팬"으로 묶여 그 사이 구간의 변환이 통째로 스킵됐다.
      const src = '셸에서 `ls 를 입력한다.\n\n값은 \\(f(x)\\) 이다.\n\n가격은 `100달러` 이다.';
      expect(normalizeMathDelimiters(src)).toContain('$$f(x)$$');
      // 뒤쪽의 정상 코드 스팬은 여전히 코드로 남는다.
      expect(normalizeMathDelimiters(src)).toContain('`100달러`');
    });

    it('정상적인 인라인 코드는 여전히 보호된다', () => {
      const src = '코드 `\\(a\\)` 는 그대로';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });
  });
});
