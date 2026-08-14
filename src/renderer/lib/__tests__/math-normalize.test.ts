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

  it('교차문서 인용 라벨(`파일 | p.3`)도 마찬가지', () => {
    const src = '근거 \\[a.pdf | p.3\\] 참고';
    expect(normalizeMathDelimiters(src)).toBe(src);
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
});
