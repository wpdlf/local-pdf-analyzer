/**
 * LaTeX 구분자 정규화 — `\(…\)` / `\[…\]` 를 remark-math 가 이해하는 `$$…$$` 로 바꾼다.
 *
 * **왜 필요한가.** ai-service 의 CITATION_RULES 출력 예시가 LLM 에게 수식을 `\(E=mc^2\)` 로
 * 내라고 **명시적으로 가르치고** 있고(ko/en/ja 3개 로캘 전부), 요약 프롬프트 6곳이 "중요한
 * 수식/공식은 원문 그대로 포함" 을 지시한다. 그런데 렌더러에는 math 플러그인이 없어서 그 지시대로
 * 나온 출력이 `\(E=mc^2\)` 리터럴로 화면에 찍혔다 — 앱이 스스로 요구한 형식을 스스로 렌더하지
 * 못하는 상태였다. remark-math 는 `$`/`$$` 만 알고 `\(…\)` 는 모르므로 파싱 전에 갈아끼운다.
 *
 * **왜 `$` 가 아니라 `$$` 인가.** 인라인 수식을 `$…$` 로 바꾸면 `singleDollarTextMath` 를 켜야
 * 하는데, 그 순간 본문의 `$` 가 전부 수식 후보가 된다 — "가격은 $100 에서 $200 로" 가 "100 에서 "
 * 를 담은 수식으로 렌더된다(내부 문서·재무 자료에서 충분히 흔하다). `$$` 로 통일하면
 * `singleDollarTextMath: false` 를 유지할 수 있어 **홑 `$` 는 영원히 수식이 되지 않는다**.
 * 부수 효과로 LLM 이 자발적으로 낸 `$$…$$` 도 그대로 지원된다(홑 `$…$` 는 의도적으로 미지원 —
 * 통화와 구분이 불가능한 유일한 케이스이고, 넓히는 것은 나중에도 안전하지만 좁히는 것은 아니다).
 *
 * `$$` 는 자기 줄에 있으면 display, 문장 안에 있으면 inline 으로 렌더된다. 따라서 원문의
 * 줄 구조를 건드리지 않고 그대로 치환하면 `\(…\)` 는 인라인, 자기 줄의 `\[…\]` 는 블록이 된다.
 */

/** 펜스 코드블록 경계 — 앞 공백 3칸까지 허용(마크다운 규칙). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** 인라인 코드 스팬 — 같은 길이의 백틱 런으로 감싸인 구간. */
const INLINE_CODE_RE = /(`+)[\s\S]*?\1/g;

/**
 * 인용 라벨 모양(`p.3`, `p. 12`)은 수식으로 바꾸지 않는다.
 * LLM 이 대괄호를 이스케이프해 `\[p.3\]` 로 내면 citation.ts 가 그걸 인용으로 복구하는데,
 * 여기서 먼저 `$$p.3$$` 로 만들어 버리면 인용 버튼이 수식으로 둔갑한다.
 */
const CITATION_SHAPED = /^\s*(?:[\w.-]+\s*\|\s*)?p\.\s*\d+\s*$/i;

/** 열림 구분자 → 닫힘 구분자. */
const PAIRS: { open: string; close: string; display: boolean }[] = [
  { open: '\\(', close: '\\)', display: false },
  { open: '\\[', close: '\\]', display: true },
];

/**
 * 치환해도 되는 내용인가.
 * - 빈 내용: `\(\)` 같은 잔해는 그대로 둔다(수식이 아니다).
 * - 이미 `$` 를 품은 내용: 중첩 구분자가 되어 파서를 깨뜨린다.
 * - 인라인(`\(…\)`)이 줄바꿈을 넘으면 수식이 아니라 우연히 맞은 괄호 쌍일 확률이 높다.
 * - display(`\[…\]`)는 여러 줄을 허용하되 빈 줄(단락 경계)은 넘지 않는다.
 */
function isConvertible(content: string, display: boolean): boolean {
  if (!content.trim()) return false;
  if (content.includes('$')) return false;
  if (CITATION_SHAPED.test(content)) return false;
  if (!display && content.includes('\n')) return false;
  if (display && /\n[ \t]*\n/.test(content)) return false;
  return true;
}

/** 코드가 아닌 평문 조각 하나를 치환한다. */
function convertPlain(text: string): string {
  let out = '';
  let i = 0;
  outer: while (i < text.length) {
    if (text[i] === '\\') {
      for (const { open, close, display } of PAIRS) {
        if (text.startsWith(open, i)) {
          const end = text.indexOf(close, i + open.length);
          if (end !== -1) {
            const content = text.slice(i + open.length, end);
            if (isConvertible(content, display)) {
              out += `$$${content}$$`;
              i = end + close.length;
              continue outer;
            }
          }
          // 짝이 없거나 치환 부적합 — 여는 구분자를 원문 그대로 흘리고 다음 문자로.
          break;
        }
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/**
 * 인라인 코드 스팬을 보존하면서 그 사이 평문만 치환한다.
 *
 * 줄 단위가 아니라 **펜스 밖 구간 전체**를 한 번에 받는다. LLM 이 display 수식을 내는 가장
 * 흔한 형태가 여는 구분자·본문·닫는 구분자를 각각 다른 줄에 두는 것이라(`\[` ⏎ `E=mc^2` ⏎ `\]`),
 * 줄 단위로 쪼개면 그 표준형을 한 건도 잡지 못한다. 인라인 수식이 줄을 넘는 것은 isConvertible
 * 이 따로 막는다.
 */
function convertSegment(segment: string): string {
  let out = '';
  let last = 0;
  INLINE_CODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_CODE_RE.exec(segment)) !== null) {
    out += convertPlain(segment.slice(last, m.index));
    out += m[0]; // 코드 스팬은 원문 그대로
    last = m.index + m[0].length;
  }
  return out + convertPlain(segment.slice(last));
}

/**
 * 마크다운 본문의 LaTeX 구분자를 `$$` 로 정규화한다.
 *
 * 코드블록·인라인 코드 안은 건드리지 않는다 — 코드 예제에 든 `\(` 가 수식으로 둔갑하면
 * 사용자가 보는 것이 원문과 달라진다. 그 외에는 원문의 줄 구조를 그대로 보존한다.
 */
export function normalizeMathDelimiters(markdown: string): string {
  // 빠른 경로: 후보 구분자가 아예 없으면 원본 참조를 그대로 돌려준다(스트리밍 중 매 틱 호출됨).
  if (!markdown.includes('\\(') && !markdown.includes('\\[')) return markdown;

  // 펜스 코드블록을 경계로 잘라, 코드 밖 구간만 통째로 치환한다. 치환은 문자 수만 바꿀 뿐
  // 줄바꿈을 더하거나 지우지 않으므로 줄 구조는 그대로 복원된다.
  const lines = markdown.split('\n');
  const out: string[] = [];
  let pending: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (pending.length === 0) return;
    out.push(...convertSegment(pending.join('\n')).split('\n'));
    pending = [];
  };

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      // 펜스 안 — 닫는 펜스인지만 본다(같은 문자·같은 길이 이상).
      if (fenceMatch && fenceMatch[1]!.startsWith(fence[0]!) && fenceMatch[1]!.length >= fence.length) {
        fence = null;
      }
      out.push(line);
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1]!;
      out.push(line);
      continue;
    }
    pending.push(line);
  }
  flush();
  return out.join('\n');
}
