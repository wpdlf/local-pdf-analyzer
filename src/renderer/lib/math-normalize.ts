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

import { CITATION_REGEX } from './citation';

/**
 * 펜스 코드블록 경계.
 *
 * QA25(A-LOW): 이전엔 `^ {0,3}` 이라 **리스트 항목 안의 펜스를 놓쳤다**. 마크다운은 리스트
 * 안의 펜스를 항목 들여쓰기(보통 2~4칸 이상)와 함께 쓰는데, 그 펜스가 인식되지 않으면 코드
 * 예제에 든 `\(` 가 수식으로 둔갑해 사용자가 보는 것이 원문과 달라진다. 들여쓰기 제한을 풀어
 * 리스트 안의 펜스도 경계로 인식한다.
 */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * 인라인 코드 스팬 — 같은 길이의 백틱 런으로 감싸인 구간.
 *
 * QA25(A-LOW): 이전엔 `[\s\S]*?` 라 **빈 줄(단락 경계)을 넘었다**. 마크다운의 코드 스팬은 빈
 * 줄을 넘지 못하는데, 짝이 안 맞는 백틱 하나가 훨씬 뒤의 백틱과 "코드 스팬"으로 묶여 그 사이
 * 전 구간의 수식 변환이 통째로 스킵됐다. 부수 효과로 성능도 개선된다 — 짝 없는 백틱마다
 * 문서 끝까지 백트래킹하던 것이 단락 안으로 묶인다.
 */
const INLINE_CODE_RE = /(`+)(?:(?!\n[ \t]*\n)[\s\S])*?\1/g;

/**
 * 인용 라벨 모양은 수식으로 바꾸지 않는다.
 * LLM 이 대괄호를 이스케이프해 `\[p.3\]` 로 내면 citation.ts 가 그걸 인용으로 복구하는데,
 * 여기서 먼저 `$$p.3$$` 로 만들어 버리면 인용 버튼이 수식으로 둔갑한다.
 *
 * QA25(A-IMP): 이전엔 이 모양을 **손으로 추정해** 적었고(`문서명 | p.N` — 파이프 구분),
 * 그 추정이 틀렸다. 이 앱이 실제로 만드는 교차문서 라벨은 use-qa 의 `[${docName} p.N]`
 * (**공백** 구분)이고, sanitizeDocLabelName 이 파일명의 `|` 를 공백으로 지우므로 파이프
 * 형태는 구조적으로 발생조차 하지 않는다. 즉 가드가 존재하지 않는 문법을 막으면서 실제
 * 라벨은 통과시키고 있었다 — `\[Beta.pdf p.5\]` 가 수식이 되어 인용 버튼이 조용히 사라졌다.
 * 게다가 유닛 테스트가 그 추정 문법을 그대로 단언해 **가드가 있는 것처럼 보였다**.
 *
 * 그래서 모양을 다시 추정하지 않고 **citation.ts 의 CITATION_REGEX 를 단일 출처로 파생**한다.
 * doc 접두·quote 꼬리·대소문자 변형이 자동으로 따라오고, 인용 문법이 바뀌면 여기도 같이 바뀐다.
 */
const CITATION_ONLY_RE = new RegExp(`^${CITATION_REGEX.source}$`, 'i');

function isCitationShaped(content: string): boolean {
  // 내용물은 `\[`…`\]` 사이의 알맹이이므로, 대괄호를 다시 씌워 인용 정규식에 그대로 물린다.
  return CITATION_ONLY_RE.test(`[${content}]`);
}

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
  if (isCitationShaped(content)) return false;
  if (!display && content.includes('\n')) return false;
  if (display && /\n[ \t]*\n/.test(content)) return false;
  return true;
}

/** 코드가 아닌 평문 조각 하나를 치환한다. */
function convertPlain(text: string): string {
  let out = '';
  let i = 0;
  // QA25(C-MED): 짝 없는 여는 구분자에서 O(n²) 였다. 닫는 구분자가 없으면 여는 구분자마다
  // 문서 끝까지 재스캔하고 한 글자만 전진했다 — `'\\('.repeat(50000)`(100KB)에서 렌더러가
  // 3.5초 동결(선형이면 ~89ms). Q&A 라이브 스트림은 50ms flush 마다 누적 텍스트 전체를
  // 재정규화하므로 비용이 틱마다 누적되고, Ollama 는 출력 길이 상한이 없어서 소형 모델이
  // 반복 루프에 빠지면 적대적 입력 없이도 도달한다(QA14 의 CITATION_REGEX ReDoS 와 같은 계열).
  //
  // indexOf 의 탐색 시작점은 단조 증가하므로, 어떤 위치에서 한 번 -1 이 나오면 그 뒤 어떤
  // 위치에서도 -1 이다. 그 사실을 기억해 두면 재스캔이 통째로 사라진다.
  const exhausted = PAIRS.map(() => false);
  outer: while (i < text.length) {
    if (text[i] === '\\') {
      // QA25(A-LOW): 이스케이프된 백슬래시(`\\(x\\)`)는 한 토큰으로 소비한다. 이전엔 두 번째
      // 백슬래시부터 `\(` 로 매칭돼 `\$$x\$$` 같은 깨진 출력이 나왔다(사용자가 구분자를
      // 리터럴로 보이려고 이스케이프한 의도가 파괴됨). LaTeX 정렬 관용구 `\\[6pt]` 도 같이 산다.
      if (text[i + 1] === '\\') {
        out += '\\\\';
        i += 2;
        continue;
      }
      for (let p = 0; p < PAIRS.length; p += 1) {
        const { open, close, display } = PAIRS[p]!;
        if (text.startsWith(open, i)) {
          if (exhausted[p]) break;
          const end = text.indexOf(close, i + open.length);
          if (end === -1) {
            exhausted[p] = true;
            break;
          }
          const content = text.slice(i + open.length, end);
          // QA25(A-LOW): 경계 바깥에 리터럴 `$` 가 붙어 있으면 치환이 오히려 상황을 악화시킨다
          // (`비용 $\(x\)` → `비용 $$$x$$` — 여는 런 3·닫는 런 2 라 수식으로 파싱되지도 않고
          // 사용자는 깨진 리터럴을 본다). 그런 경계에서는 원문을 유지한다.
          const touchesDollar = text[i - 1] === '$' || text[end + close.length] === '$';
          if (!touchesDollar && isConvertible(content, display)) {
            out += `$$${content}$$`;
            i = end + close.length;
            continue outer;
          }
          // 치환 부적합 — 여는 구분자를 원문 그대로 흘리고 다음 문자로.
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
 * 수식 구분자만 벗겨 낸다 — 조판할 수 없는 자리에서 쓰는 표시용 폴백.
 *
 * QA25(A-LOW): 마인드맵은 heading 제목을 평문 `<span>` 으로 그리므로, 제목에 수식이 든 요약을
 * 마인드맵으로 보면 `\(σ^2\)` 같은 LaTeX 원본이 그대로 보인다 — 텍스트 뷰와 토글할 때마다
 * 표기가 달라진다. 트리 노드마다 마크다운 렌더러를 붙이면 마인드맵이 무거워지므로(수백 노드),
 * 구분자만 제거해 `σ^2` 로 보이게 한다. 조판은 아니지만 원본 노출보다는 낫고 비용이 0 이다.
 */
export function stripMathDelimiters(text: string): string {
  if (!text) return text;
  // QA26(B-Low): 인용 가드를 함께 상속한다. 없으면 인용 라벨로 끝나는 heading 이 마인드맵에서
  // 대괄호만 벗겨져 **텍스트 뷰와 표기가 어긋난다** — 이 함수의 존재 이유가 두 뷰의 표기 통일인데
  // 반대로 작용한다.
  const keep = (whole: string, content: string): string => (isCitationShaped(content) ? whole : content);
  return text
    .replace(/\\\((.*?)\\\)/g, keep)
    .replace(/\\\[(.*?)\\\]/g, keep)
    .replace(/\$\$(.+?)\$\$/g, keep);
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
