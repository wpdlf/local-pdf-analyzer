import { describe, it, expect } from 'vitest';
import { buildPrompt } from '../prompts';

describe('buildPrompt', () => {
  const sampleText = '프로세스는 실행 중인 프로그램의 인스턴스이다.';

  it('full 타입일 때 전체 요약 프롬프트를 생성한다', () => {
    const prompt = buildPrompt(sampleText, 'full');
    expect(prompt).toContain('대학교 강의자료 요약 전문가');
    expect(prompt).toContain('핵심 개념');
    expect(prompt).toContain('시험 포인트');
    expect(prompt).toContain(sampleText);
  });

  it('chapter 타입일 때 챕터별 요약 프롬프트를 생성한다', () => {
    const prompt = buildPrompt(sampleText, 'chapter');
    expect(prompt).toContain('이 섹션을 요약');
    expect(prompt).toContain('핵심 포인트');
    expect(prompt).toContain(sampleText);
  });

  it('keywords 타입일 때 키워드 추출 프롬프트를 생성한다', () => {
    const prompt = buildPrompt(sampleText, 'keywords');
    expect(prompt).toContain('핵심 키워드를 추출');
    expect(prompt).toContain('| 키워드 | 설명 | 중요도 |');
    expect(prompt).toContain(sampleText);
  });

  it('프롬프트에 입력 텍스트가 포함된다', () => {
    const text = '특별한 텍스트 내용 12345';
    const prompt = buildPrompt(text, 'full');
    expect(prompt).toContain(text);
  });
});
