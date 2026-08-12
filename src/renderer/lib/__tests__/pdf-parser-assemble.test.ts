import { describe, it, expect } from 'vitest';
import { assemblePageText, shouldExtractMoreImages, MAX_EXAMINED_IMAGES, type TextItemLike } from '../pdf-parser';

/**
 * 페이지 텍스트 조립기(assemblePageText) 회귀 넷.
 *
 * 이 로직은 추출 품질의 뿌리 — 요약·인용·검색·RAG 가 전부 이 문자열을 본다 — 인데도 parsePdf 의
 * 배치 루프 안에 인라인이라 **테스트가 한 건도 없었다**. QA22 가 회전 텍스트 fontSize 결함을
 * "그 루프에 테스트 0건이라 위험" 으로 보류한 지점이라, 수정 전에 기존 동작부터 고정한다.
 *
 * 픽스처 규약: 텍스트 행렬 tx = [a, b, c, d, e, f] (e=x, f=y). 글자 크기 s, 회전 θ 이면
 * [s·cosθ, s·sinθ, -s·sinθ, s·cosθ].
 */

/** 회전 없는 아이템 — 크기 s, 위치 (x, y). */
const it0 = (str: string, s: number, x: number, y: number, width?: number): TextItemLike => ({
  str, transform: [s, 0, 0, s, x, y], ...(width !== undefined ? { width } : {}),
});
/** 90° 회전 아이템 — a=d=0, 크기는 b·c 에 들어간다(결함이 있던 형태). */
const it90 = (str: string, s: number, x: number, y: number, width?: number): TextItemLike => ({
  str, transform: [0, s, -s, 0, x, y], ...(width !== undefined ? { width } : {}),
});

describe('assemblePageText — 기존 동작 고정(회귀 넷)', () => {
  it('같은 줄에서 간격이 좁으면 공백 없이 붙인다 (한글 글자 단위 분할 복원)', () => {
    // pdfjs 가 '안','녕' 을 개별 아이템으로 주는 전형적 한글 케이스 — 폭만큼만 전진.
    const items = [it0('안', 10, 0, 700, 10), it0('녕', 10, 10, 700, 10)];
    expect(assemblePageText(items)).toBe('안녕');
  });

  it('같은 줄에서 간격이 크면 공백을 넣는다', () => {
    // 두 번째 아이템 x=30 > lastEndX(10) + 0.3×10=3 → 공백
    const items = [it0('A', 10, 0, 700, 10), it0('B', 10, 30, 700, 10)];
    expect(assemblePageText(items)).toBe('A B');
  });

  it('y 가 글자 크기의 절반을 넘게 바뀌면 줄바꿈', () => {
    const items = [it0('첫줄', 10, 0, 700, 20), it0('둘째줄', 10, 0, 680, 30)];
    expect(assemblePageText(items)).toBe('첫줄\n둘째줄');
  });

  it('y 변화가 임계 이하면 같은 줄로 본다 (베이스라인 미세 흔들림 흡수)', () => {
    const items = [it0('가', 10, 0, 700, 10), it0('나', 10, 10, 697, 10)];
    expect(assemblePageText(items)).toBe('가나');
  });

  it('transform 이 없는 아이템은 공백으로 이어 붙인다', () => {
    const items: TextItemLike[] = [{ str: 'A' }, { str: 'B' }];
    expect(assemblePageText(items)).toBe('A B');
  });

  it('첫 아이템이 transform 없으면 선행 공백을 만들지 않는다', () => {
    expect(assemblePageText([{ str: 'A' }])).toBe('A');
  });

  it('빈 문자열·str 없는 항목(TextMarkedContent 등)은 건너뛴다', () => {
    const items: unknown[] = [{ type: 'beginMarkedContent' }, it0('A', 10, 0, 700, 10), { str: '' }];
    expect(assemblePageText(items)).toBe('A');
  });

  it('width 가 없으면 글자 수 × 크기의 절반으로 폭을 추정한다', () => {
    // 'AB' 폭 추정 = 2 × 10 × 0.5 = 10 → lastEndX=10. 다음 x=12 는 10+3=13 이하라 공백 없음.
    expect(assemblePageText([it0('AB', 10, 0, 700), it0('C', 10, 12, 700)])).toBe('ABC');
    // x=20 이면 13 초과 → 공백
    expect(assemblePageText([it0('AB', 10, 0, 700), it0('C', 10, 20, 700)])).toBe('AB C');
  });

  it('빈 items 는 빈 문자열', () => {
    expect(assemblePageText([])).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA23(C-MED ×3): 조립기가 pdfjs 가 이미 계산해 준 정보를 버리고 y 좌표로 재추정하던 문제.
// pdfjs worker 는 **회전각을 역보정하고 textRise 를 보정한 뒤** 줄바꿈 여부를 `hasEOL` 로
// 알려주는데(TextItem 계약), 이 앱은 그 필드를 전 소스에서 한 번도 읽지 않았다. 그 결과:
//   - 각주 번호·수식 첨자가 문장 중간에 줄바꿈을 만든다(임계가 **작은 첨자 글꼴** 기준이라)
//   - 90° 회전 텍스트는 글자 진행이 곧 y 이동이라 **글자마다 줄바꿈**된다
// 두 증상의 근인이 같으므로 함께 닫는다.
// ─────────────────────────────────────────────────────────────────────────────
// QA23(C-MED): 이미지 추출 예산이 **채택 수**만 봐서, 채택되지 않는 이미지(고해상 스캔 거절·
// 중복 로고)만 반복되는 문서에서는 예산이 영원히 차지 않아 500페이지 전부에 최고비용 호출이 돌았다.
describe('shouldExtractMoreImages — 추출 예산 (QA23)', () => {
  it('채택 수가 남아 있고 검사 수도 여유가 있으면 계속한다', () => {
    expect(shouldExtractMoreImages(0, 0)).toBe(true);
    expect(shouldExtractMoreImages(49, MAX_EXAMINED_IMAGES - 1)).toBe(true);
  });

  it('채택 수가 상한이면 멈춘다 (종전 동작)', () => {
    expect(shouldExtractMoreImages(50, 0)).toBe(false);
  });

  it('채택이 0이어도 검사 수가 상한이면 멈춘다 — 이번 수정의 핵심', () => {
    expect(shouldExtractMoreImages(0, MAX_EXAMINED_IMAGES)).toBe(false);
  });
});

describe('assemblePageText — pdfjs hasEOL 채택 (QA23)', () => {
  // 이 케이스가 hasEOL 채택의 존재 이유다. 첨자 오판을 막으려고 임계를 **두 아이템 중 큰 글꼴**
  // 기준으로 올렸는데, 그러면 "12pt 본문 줄 다음에 7pt 주석 줄이 5pt 아래에서 시작" 같은 **진짜
  // 줄바꿈**을 기하 판정이 놓친다(perp 5 < 0.5×12=6). pdfjs 가 이미 판정해 둔 값이 그걸 복구한다.
  it('기하 판정이 놓치는 진짜 줄바꿈을 hasEOL 이 잡는다', () => {
    const items: TextItemLike[] = [
      { str: '본문 줄', transform: [12, 0, 0, 12, 0, 700], width: 60, hasEOL: true },
      { str: '주석 줄', transform: [7, 0, 0, 7, 0, 695], width: 40 },
    ];
    expect(assemblePageText(items)).toBe('본문 줄\n주석 줄');
  });

  it('hasEOL 이 참이면 같은 위치여도 줄을 바꾼다 (좌표만으로는 알 수 없는 경우)', () => {
    const items: TextItemLike[] = [
      { str: 'A', transform: [10, 0, 0, 10, 0, 700], width: 10, hasEOL: true },
      { str: 'B', transform: [10, 0, 0, 10, 10, 700], width: 10 },
    ];
    expect(assemblePageText(items)).toBe('A\nB');
  });

  it('hasEOL 이 거짓이면 같은 줄로 이어 붙인다 (y 가 조금 흔들려도)', () => {
    const items: TextItemLike[] = [
      { str: 'A', transform: [10, 0, 0, 10, 0, 700], width: 10, hasEOL: false },
      { str: 'B', transform: [10, 0, 0, 10, 10, 698], width: 10, hasEOL: false },
    ];
    expect(assemblePageText(items)).toBe('AB');
  });

  // ─── QA24(A-M1): 단락 경계(빈 줄) ───
  // pdfjs 는 누적 텍스트가 없는 상태의 EOL 을 `{str:'', hasEOL:true}` **단독 아이템**으로 낸다
  // (pdf.worker.mjs appendEOL 의 else 분기). 종전 필터 `!item.str` 이 그것만 정확히 버려서
  // 페이지 안에 `'\n\n'` 이 한 번도 생기지 않았고, `split(/\n\n+/)` 를 쓰는 요약 단락 라벨링과
  // 청킹이 "한 페이지 = 항상 한 단락" 을 봤다. 픽스처가 전부 str 이 채워진 합성 아이템이라
  // 이 형태가 입력에 한 번도 등장하지 않았던 것이 미검출의 이유다.
  it('빈 줄(단독 EOL 마커)이 단락 경계가 된다', () => {
    const items: TextItemLike[] = [
      { str: '첫 단락 문장', transform: [12, 0, 0, 12, 0, 700], width: 100, hasEOL: true },
      // 연속 줄바꿈 → pdfjs 가 내는 단독 빈 아이템
      { str: '', transform: [12, 0, 0, 12, 0, 686], width: 0, hasEOL: true },
      { str: '둘째 단락 문장', transform: [12, 0, 0, 12, 0, 672], width: 100 },
    ];
    expect(assemblePageText(items)).toBe('첫 단락 문장\n\n둘째 단락 문장');
  });

  it('빈 줄이 여러 개여도 두 줄로 정규화한다 (여백 많은 문서의 개행 폭증 방지)', () => {
    const items: TextItemLike[] = [
      { str: 'A', transform: [12, 0, 0, 12, 0, 700], width: 10, hasEOL: true },
      { str: '', transform: [12, 0, 0, 12, 0, 686], width: 0, hasEOL: true },
      { str: '', transform: [12, 0, 0, 12, 0, 672], width: 0, hasEOL: true },
      { str: '', transform: [12, 0, 0, 12, 0, 658], width: 0, hasEOL: true },
      { str: 'B', transform: [12, 0, 0, 12, 0, 644], width: 10 },
    ];
    expect(assemblePageText(items)).toBe('A\n\nB');
  });

  it('빈 줄 없는 연속 줄바꿈은 종전대로 한 줄 개행 — 같은 단락이다', () => {
    const items: TextItemLike[] = [
      { str: '한 문장이', transform: [12, 0, 0, 12, 0, 700], width: 60, hasEOL: true },
      { str: '두 줄에 걸쳐 있다', transform: [12, 0, 0, 12, 0, 686], width: 100 },
    ];
    expect(assemblePageText(items)).toBe('한 문장이\n두 줄에 걸쳐 있다');
  });

  it('페이지 선두의 빈 줄은 앞에 붙일 것이 없으므로 무시한다', () => {
    const items: TextItemLike[] = [
      { str: '', transform: [12, 0, 0, 12, 0, 700], width: 0, hasEOL: true },
      { str: '본문', transform: [12, 0, 0, 12, 0, 686], width: 30 },
    ];
    expect(assemblePageText(items)).toBe('본문');
  });

  it('hasEOL 없는 빈 문자열 아이템은 종전대로 무시한다 (단락 경계가 아니다)', () => {
    const items: TextItemLike[] = [
      { str: 'A', transform: [12, 0, 0, 12, 0, 700], width: 10, hasEOL: true },
      { str: '', transform: [12, 0, 0, 12, 0, 686], width: 0 },
      { str: 'B', transform: [12, 0, 0, 12, 0, 672], width: 10 },
    ];
    expect(assemblePageText(items)).toBe('A\nB');
  });

  it('각주 번호(작은 첨자)가 문장 중간에 줄바꿈을 만들지 않는다', () => {

    // 본문 12pt → 각주 번호 7pt(위로 4pt) → 본문 복귀. 임계를 첨자 글꼴(7)로 잡으면 3.5 가 되어
    // 4pt 이동이 줄바꿈으로 오판된다. 줄의 본문 글꼴(12)을 기준으로 봐야 한다.
    const items: TextItemLike[] = [
      { str: '프로세스는 실행 중인 프로그램이다', transform: [12, 0, 0, 12, 0, 700], width: 200 },
      { str: '1)', transform: [7, 0, 0, 7, 200, 704], width: 8 },
      { str: ' 따라서 메모리를 점유한다', transform: [12, 0, 0, 12, 208, 700], width: 150 },
    ];
    expect(assemblePageText(items)).not.toContain('\n');
  });

  it('아래첨자(수식)도 마찬가지', () => {
    const items: TextItemLike[] = [
      { str: 'x', transform: [12, 0, 0, 12, 0, 700], width: 8 },
      { str: 'i', transform: [7, 0, 0, 7, 8, 696], width: 4 },
      { str: '의 값', transform: [12, 0, 0, 12, 12, 700], width: 30 },
    ];
    expect(assemblePageText(items)).not.toContain('\n');
  });

  it('90° 회전 텍스트가 글자마다 줄바꿈되지 않는다 (진행 방향 = y)', () => {
    // 세로 축 라벨: 글자가 +y 로 전진한다. 이전 구현은 y 차이를 줄바꿈으로 봐 "정\n확\n도" 가 됐다.
    const items: TextItemLike[] = [
      { str: '정', transform: [0, 10, -10, 0, 100, 700], width: 10 },
      { str: '확', transform: [0, 10, -10, 0, 100, 710], width: 10 },
      { str: '도', transform: [0, 10, -10, 0, 100, 720], width: 10 },
    ];
    expect(assemblePageText(items)).toBe('정확도');
  });

  it('회전 텍스트에서 줄이 바뀌면(진행 방향의 수직으로 이동) 줄바꿈한다', () => {
    // 90° 회전에서 다음 줄은 x 로 이동한다.
    const items: TextItemLike[] = [
      { str: '첫줄', transform: [0, 10, -10, 0, 100, 700], width: 20 },
      { str: '둘째줄', transform: [0, 10, -10, 0, 130, 700], width: 30 },
    ];
    expect(assemblePageText(items)).toBe('첫줄\n둘째줄');
  });

  it('회전 텍스트의 같은 줄 내 간격은 공백으로 (진행 방향 기준)', () => {
    const items: TextItemLike[] = [
      { str: '국어', transform: [0, 10, -10, 0, 100, 700], width: 20 },
      { str: '영어', transform: [0, 10, -10, 0, 100, 760], width: 20 }, // 진행방향으로 크게 떨어짐
    ];
    expect(assemblePageText(items)).toBe('국어 영어');
  });
});

describe('assemblePageText — 회전 텍스트 크기 판정 (QA22 백로그)', () => {
  // 이전 구현은 `|a| || |d| || 12` 라 90° 회전(a=d=0)에서 **항상 12** 로 폴백했다.
  // 세로 축 라벨·측면 표·워터마크가 흔한 논문/도면 PDF 에서 임계가 실제 크기와 어긋난다.

  it('큰 글자(30)의 90° 회전: 12 폴백이면 생기던 과다 줄바꿈이 없다', () => {
    // y 간격 14 — 실제 크기 30 기준 임계 15 이하라 같은 줄, 옛 폴백 12 기준 임계 6 이면 줄바꿈.
    const items = [it90('세', 30, 100, 700, 30), it90('로', 30, 100, 686, 30)];
    expect(assemblePageText(items)).toBe('세로');
  });

  // ⚠️ 이 케이스의 픽스처·기대값은 QA23 에서 교정됐다. v0.31.39 가 세운 원래 형태는
  // "회전 텍스트에서 **y 차이 = 줄바꿈**" 이라는 옛 모델을 전제로 `A\nB` 를 기대했는데, 90° 회전에서
  // y 이동은 **문자 진행 방향**이므로 줄바꿈이 아니다(그 모델이 "정확도"를 "정\n확\n도"로 만들던
  // 근인이다). 검증 의도(작은 회전 글자의 크기를 12 로 폴백하지 않는가)는 줄 간격 판정으로 유지한다.
  it('작은 글자(6)의 90° 회전: 줄 간격 판정이 실제 크기(6) 기준이다', () => {
    // 진행 방향의 **수직**(=x)으로 4 이동: 실제 크기 6 기준 임계 3 초과 → 줄바꿈.
    // 옛 폴백 12 였다면 임계 6 이라 같은 줄로 붙었다.
    const items = [it90('A', 6, 100, 700, 6), it90('B', 6, 104, 700, 6)];
    expect(assemblePageText(items)).toBe('A\nB');
  });

  it('270° 회전(부호 반대)도 동일하게 실제 크기를 얻는다', () => {
    const items: TextItemLike[] = [
      { str: '세', transform: [0, -30, 30, 0, 100, 700], width: 30 },
      { str: '로', transform: [0, -30, 30, 0, 100, 686], width: 30 },
    ];
    expect(assemblePageText(items)).toBe('세로');
  });

  it('임의 각도(45°)도 회전 전 크기를 복원하고 진행 방향을 따른다', () => {
    // s=20, θ=45° → a=b=14.142. hypot(a,b)=20 이라야 임계가 맞는다(옛 구현은 a 만 봐 과소평가).
    // 다음 글자는 **45° 방향으로 폭(20)만큼** 전진한다 — 이전 픽스처는 y 만 움직여(진행 방향의
    // 수직 성분이 큰 배치) 옛 y-차 모델에서만 같은 줄로 보이던 형태였다.
    const s = 20, k = s * Math.SQRT1_2;
    const step = 20 * Math.SQRT1_2; // 진행 방향 성분
    const items: TextItemLike[] = [
      { str: '기', transform: [k, k, -k, k, 0, 700], width: 20 },
      { str: '울', transform: [k, k, -k, k, step, 700 + step], width: 20 },
    ];
    expect(assemblePageText(items)).toBe('기울');
  });

  it('회전 없는 일반 텍스트의 크기 판정은 종전과 동일하다 (동작 보존)', () => {
    // hypot(s,0) === |s| — 이 등가성이 깨지면 전 문서의 줄바꿈/공백이 흔들린다.
    const items = [it0('첫줄', 10, 0, 700, 20), it0('둘째줄', 10, 0, 694, 30)]; // 간격 6 > 5 → 줄바꿈
    expect(assemblePageText(items)).toBe('첫줄\n둘째줄');
  });

  it('a·b 가 모두 0 인 퇴화 행렬은 d 로, 그것도 0 이면 12 로 폴백', () => {
    // d=8 사용 → 임계 4, y 간격 5 → 줄바꿈
    const byD: TextItemLike[] = [
      { str: 'A', transform: [0, 0, 0, 8, 0, 700], width: 8 },
      { str: 'B', transform: [0, 0, 0, 8, 0, 695], width: 8 },
    ];
    expect(assemblePageText(byD)).toBe('A\nB');
    // 전부 0 → 12 폴백 → 임계 6, y 간격 5 → 같은 줄
    const allZero: TextItemLike[] = [
      { str: 'A', transform: [0, 0, 0, 0, 0, 700], width: 0 },
      { str: 'B', transform: [0, 0, 0, 0, 0, 695], width: 0 },
    ];
    expect(assemblePageText(allZero)).toBe('AB');
  });
});
