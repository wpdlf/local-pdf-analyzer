import type { SummaryType } from '../types';

export function buildPrompt(text: string, type: SummaryType): string {
  switch (type) {
    case 'full':
      return buildFullSummaryPrompt(text);
    case 'chapter':
      return buildChapterSummaryPrompt(text);
    case 'keywords':
      return buildKeywordsPrompt(text);
  }
}

function buildFullSummaryPrompt(text: string): string {
  return `당신은 대학교 강의자료 요약 전문가입니다.

다음 강의자료를 분석하여 구조적으로 요약해주세요.

## 요약 규칙
1. **핵심 개념**: 주요 개념과 정의를 목록으로 정리
2. **주요 내용**: 각 섹션의 핵심 내용을 간결하게 요약
3. **수식/공식**: 중요한 수식이 있으면 원문 그대로 포함
4. **예제**: 핵심 예제가 있으면 간략히 포함
5. **시험 포인트**: 시험에 출제될 가능성이 높은 내용 별도 표시

## 출력 형식
마크다운 형식으로 출력하세요.

---

${text}`;
}

function buildChapterSummaryPrompt(text: string): string {
  return `당신은 대학교 강의자료 요약 전문가입니다.

다음 강의자료의 이 섹션을 요약해주세요.

## 요약 규칙
1. 해당 섹션의 **핵심 개념**과 **정의**를 정리
2. 중요한 **수식/공식**은 원문 그대로 포함
3. **예제**가 있으면 핵심만 간략히 포함
4. 3~5개의 **핵심 포인트**로 정리

## 출력 형식
마크다운 형식으로 출력하세요.

---

${text}`;
}

function buildKeywordsPrompt(text: string): string {
  return `다음 강의자료에서 핵심 키워드를 추출하고 각각 간단히 설명해주세요.

## 출력 형식
아래 마크다운 테이블 형식으로 출력하세요:

| 키워드 | 설명 | 중요도 |
|--------|------|--------|
| 키워드명 | 한 줄 설명 | 상/중/하 |

키워드는 최소 10개, 최대 30개 추출해주세요.

---

${text}`;
}
