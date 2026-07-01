import { describe, it, expect } from 'vitest';
import { stripConversationalText } from '../use-summarize';

/**
 * R37 P6 (v0.18.23) — stripConversationalText 회귀 가드 (QA M4).
 *
 * 로컬 LLM 요약 출력 끝/사이에 끼는 대화형 멘트("도움이 되길 바랍니다" 등)를 줄 단위로
 * 제거하는 ~30개 다국어 정규식. 인라인 주석에 R28~R37 회귀원으로 명시됐으나 그동안
 * 자동 테스트가 0건이었다. 핵심 불변식:
 *  1) 대표 대화형 패턴(ko/en/ja/zh)이 포함된 줄은 제거된다.
 *  2) 정상 본문 줄은 보존된다 (과잉 제거 없음).
 *  3) 제거 후 빈 줄/3연속 개행을 단락 경계(\n\n)로 정규화하고 trim 한다.
 */
describe('stripConversationalText — 대화형 멘트 제거', () => {
  describe('한국어 패턴 제거', () => {
    const koCases = [
      '도움이 되길 바랍니다',
      '궁금한 점이 있으면 말씀해 주세요',
      '추가로 궁금한 내용이 있으면',
      '언제든지 물어보세요',
      '필요하시면 언제든 연락주세요',
      '요약해 드리겠습니다',
      '이상으로 요약을 마치겠습니다',
    ];
    for (const line of koCases) {
      it(`"${line}" 줄을 제거한다`, () => {
        const input = `핵심 본문 내용입니다.\n${line}`;
        const out = stripConversationalText(input);
        expect(out).toBe('핵심 본문 내용입니다.');
      });
    }
  });

  describe('영어 패턴 제거 (대소문자 무관)', () => {
    const enCases = [
      'I hope this helps!',
      'Feel free to ask anything',
      'Let me know if you need more',
      'If you have any questions, reach out',
      "Here's a summary of the document",
      'In conclusion, the system works',
      'To summarize: it is fast',
    ];
    for (const line of enCases) {
      it(`"${line}" 줄을 제거한다`, () => {
        const input = `Core body content here.\n${line}`;
        const out = stripConversationalText(input);
        expect(out).toBe('Core body content here.');
      });
    }
  });

  describe('일본어/중국어 패턴 제거', () => {
    const cjkCases = [
      'お役に立てれば幸いです',
      'ご質問があればどうぞ',
      '以上になります',
      '希望对你有帮助',
      '如有疑问请联系',
      '总结如下',
    ];
    for (const line of cjkCases) {
      it(`"${line}" 줄을 제거한다`, () => {
        const input = `本文の内容です。\n${line}`;
        const out = stripConversationalText(input);
        expect(out).toBe('本文の内容です。');
      });
    }
  });

  describe('정상 본문 보존 (과잉 제거 방지)', () => {
    it('대화형 패턴이 없는 다단락 본문은 그대로 유지한다', () => {
      const input = '운영체제는 프로세스를 관리한다.\n\nCPU 스케줄링 알고리즘에는 여러 종류가 있다.';
      expect(stripConversationalText(input)).toBe(input);
    });

    it('"질문" 같은 단어가 본문 맥락으로 쓰이면 제거하지 않는다', () => {
      // "질문에 답하는 시스템" 은 대화형 멘트가 아닌 본문 — 패턴이 매치되면 안 됨.
      const line = '이 연구는 사용자의 질문에 답하는 시스템을 다룬다.';
      expect(stripConversationalText(line)).toBe(line);
    });

    it('"help" 가 본문 단어로 등장해도 hope-this-helps 패턴이 아니면 보존', () => {
      const line = 'The helper function processes input.';
      expect(stripConversationalText(line)).toBe(line);
    });

    // QA post-v0.31.15: 비앵커드 패턴이 실질 문장을 통째로 지우던 결함(요약 내용+인용 소실).
    it('"…다루고 있습니다." 로 끝나는 실문장은 보존한다(콜론 인트로만 제거)', () => {
      const line = '본 절은 어텐션 메커니즘을 다루고 있습니다.';
      expect(stripConversationalText(line)).toBe(line);
    });

    it('인용 [p.N] 을 담은 라인은 대화체 패턴과 무관하게 항상 보존한다', () => {
      const line = '본 절은 어텐션 메커니즘을 다루고 있습니다[p.5].';
      expect(stripConversationalText(line)).toBe(line); // 인용+내용 소실 방지
    });

    it('콜론 인트로 "…다루고 있습니다:" 는 여전히 제거한다', () => {
      const input = '핵심 본문입니다.\n다음 주제를 다루고 있습니다:';
      expect(stripConversationalText(input)).toBe('핵심 본문입니다.');
    });

    it('본문 중간의 "总结如下" 는 보존, 라인 끝 리드인만 제거', () => {
      const body = '本文总结如下的方法很有效。'; // 중간 등장 → 보존
      expect(stripConversationalText(body)).toBe(body);
    });
  });

  describe('개행/공백 정규화', () => {
    it('제거된 줄 자리의 3연속 이상 개행을 \\n\\n 으로 접고 trim 한다', () => {
      const input = '본문 A\n\n\n도움이 되길 바랍니다\n\n\n본문 B';
      const out = stripConversationalText(input);
      // 대화형 줄 제거 후 양쪽 본문만 단락 경계로 연결
      expect(out).toBe('본문 A\n\n본문 B');
    });

    it('앞뒤 공백/개행은 trim 된다', () => {
      expect(stripConversationalText('\n\n  핵심  \n\n')).toBe('핵심');
    });

    it('빈 문자열은 빈 문자열', () => {
      expect(stripConversationalText('')).toBe('');
    });

    it('대화형 멘트만 있으면 빈 문자열로 수렴한다', () => {
      expect(stripConversationalText('도움이 되길 바랍니다\nfeel free to ask')).toBe('');
    });
  });
});
