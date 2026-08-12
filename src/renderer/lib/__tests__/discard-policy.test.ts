import { describe, it, expect } from 'vitest';
import { hasUnsavedWork } from '../discard-policy';

/**
 * QA24(A-L1): 종전 tabs.test 의 확인 대화상자 테스트는 summary 와 summaryStream 을 **항상
 * 동시에** 세팅했다. 그래서 `|| qaMessages.length > 0` 를 지워도, `|| summaryStream...` 을
 * 지워도 전부 그린이었다 — 3항 중 2항이 뮤테이션 생존. 정작 가장 흔한 조합(요약은 없고
 * Q&A 대화만 있는 상태)은 한 번도 검증되지 않았다. 각 축을 단독으로 고정한다.
 */
describe('hasUnsavedWork — 세 축을 각각 단독으로 고정', () => {
  const empty = { summary: null, summaryStream: '', qaMessages: [] as unknown[] };

  it('셋 다 비어 있으면 false (묻지 않는다)', () => {
    expect(hasUnsavedWork(empty)).toBe(false);
  });

  it('summary 단독 — 확정된 요약만 있어도 true', () => {
    expect(hasUnsavedWork({ ...empty, summary: { content: '요약본' } })).toBe(true);
  });

  it('summaryStream 단독 — 생성 중인 요약만 있어도 true', () => {
    expect(hasUnsavedWork({ ...empty, summaryStream: '생성 중인 텍스트' })).toBe(true);
  });

  it('qaMessages 단독 — 대화만 있어도 true (가장 흔한 조합인데 무검증이었다)', () => {
    expect(hasUnsavedWork({ ...empty, qaMessages: [{ role: 'user', content: '질문' }] })).toBe(true);
  });

  it('공백만 있는 summaryStream 은 잃을 작업이 아니다 (과잉 확인 방지)', () => {
    expect(hasUnsavedWork({ ...empty, summaryStream: '   \n\t ' })).toBe(false);
  });
});
