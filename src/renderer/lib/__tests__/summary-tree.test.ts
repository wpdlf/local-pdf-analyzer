import { describe, it, expect } from 'vitest';
import { parseSummaryToTree } from '../summary-tree';

describe('parseSummaryToTree — 요약 마인드맵 파서', () => {
  it('heading 계층을 트리로 구성(레벨 기반 중첩)', () => {
    const md = '# 문서\n\n본문\n\n## 개요\n\n내용\n\n### 배경\n\n### 목표\n\n## 결론\n';
    const t = parseSummaryToTree(md);
    expect(t).toHaveLength(1);
    expect(t[0]?.title).toBe('문서');
    expect(t[0]?.children.map((c) => c.title)).toEqual(['개요', '결론']);
    expect(t[0]?.children[0]?.children.map((c) => c.title)).toEqual(['배경', '목표']);
  });

  it('heading 이 없으면 빈 배열(호출측이 빈 상태 렌더)', () => {
    expect(parseSummaryToTree('제목 없는 평문 요약입니다.\n\n두 번째 문단.')).toEqual([]);
    expect(parseSummaryToTree('')).toEqual([]);
  });

  it('섹션 내 첫 [p.N] 인용을 page 로 추출(heading 라인 + 본문)', () => {
    const md = '# 개요\n\n핵심 근거는 [p.3] 에 있다. 이후 [p.7] 도 참조.\n\n## 방법 [p.12]\n\n세부.';
    const t = parseSummaryToTree(md);
    expect(t[0]?.page).toBe(3);            // 섹션 첫 인용
    expect(t[0]?.children[0]?.page).toBe(12); // heading 라인 자체의 인용
  });

  it('인용 없는 섹션은 page=null', () => {
    const t = parseSummaryToTree('# 결론\n\n인용 없는 마무리.');
    expect(t[0]?.page).toBeNull();
  });

  it('제목에서 인용 토큰·짝 강조 마커를 제거', () => {
    const t = parseSummaryToTree('# **중요** 개요 [p.1]\n\n본문');
    expect(t[0]?.title).toBe('중요 개요');
  });

  it('QA15(A-LOW): 단일 _/~ 는 보존(snake_case·범위 훼손 방지), 짝만 제거', () => {
    expect(parseSummaryToTree('# my_doc.pdf 분석')[0]?.title).toBe('my_doc.pdf 분석');
    expect(parseSummaryToTree('# 기간 2020~2024 요약')[0]?.title).toBe('기간 2020~2024 요약');
    expect(parseSummaryToTree('# __굵게__ 와 ~~취소~~')[0]?.title).toBe('굵게 와 취소');
  });

  it('QA15: 교차 문서 인용의 docName 추출(단일 문서는 null)', () => {
    const t = parseSummaryToTree('# 요약\n\n근거 [Beta.pdf p.5] 참조.\n\n## 로컬\n\n[p.2] 만.');
    expect(t[0]?.docName).toBe('Beta.pdf');
    expect(t[0]?.page).toBe(5);
    expect(t[0]?.children[0]?.docName).toBeNull();
    expect(t[0]?.children[0]?.page).toBe(2);
  });

  it('QA15(A/B-MED): 미닫힌 코드펜스가 이후 heading 을 삼키지 않음(펜스 무시 재수집)', () => {
    const md = '# 앞\n\n```\ncode\n\n## 뒤1\n\n## 뒤2';  // 닫는 펜스 없음
    const t = parseSummaryToTree(md);
    expect(t).toHaveLength(1);
    expect(t[0]?.children.map((c) => c.title)).toEqual(['뒤1', '뒤2']); // 삼켜지지 않음
  });

  it('코드펜스 안의 # 은 heading 으로 오인하지 않음', () => {
    const md = '# 진짜제목\n\n```\n# 이건 주석\n## 코드 안 heading\n```\n\n## 진짜하위';
    const t = parseSummaryToTree(md);
    expect(t).toHaveLength(1);
    expect(t[0]?.children.map((c) => c.title)).toEqual(['진짜하위']);
  });

  it('레벨 점프(#→###)도 가장 가까운 상위에 부착', () => {
    const t = parseSummaryToTree('# A\n\n### C\n');
    expect(t).toHaveLength(1);
    expect(t[0]?.children[0]?.title).toBe('C');
    expect(t[0]?.children[0]?.level).toBe(3);
  });

  it('닫는 # 시퀀스(## 제목 ##)도 제목만 캡처', () => {
    const t = parseSummaryToTree('## 제목 ##\n');
    expect(t[0]?.title).toBe('제목');
    expect(t[0]?.level).toBe(2);
  });

  it('여러 최상위 heading 은 각각 root', () => {
    const t = parseSummaryToTree('# 첫째\n\n## a\n\n# 둘째\n\n## b');
    expect(t.map((n) => n.title)).toEqual(['첫째', '둘째']);
    expect(t[1]?.children.map((c) => c.title)).toEqual(['b']);
  });
  // QA18(A-LOW): CommonMark 은 선행 공백 3칸까지 heading 으로 인정한다. 불허하면 텍스트뷰엔
  // 제목으로 렌더되는 줄이 마인드맵에서만 노드로 누락되고, 그 본문이 앞 노드 섹션에 흡수돼
  // 페이지 배지까지 어긋난다(4칸 이상은 들여쓴 코드블록이므로 계속 제외).
  it('선행 공백 1~3칸 heading 도 노드로 인식(4칸 이상은 코드블록이라 제외)', () => {
    const t = parseSummaryToTree('# 문서\n\n ## 한칸\n\n   ### 세칸\n\n    #### 네칸\n');
    expect(t).toHaveLength(1);
    expect(t[0]?.children.map((c) => c.title)).toEqual(['한칸']);
    expect(t[0]?.children[0]?.children.map((c) => c.title)).toEqual(['세칸']);
    // 4칸 들여쓰기는 heading 이 아니다 → 어떤 노드로도 등장하지 않음
    expect(JSON.stringify(t)).not.toContain('네칸');
  });

  // QA18(A-LOW): `*` 제거에 flanking 규칙 미적용 시 `## 2 * 3 * 4 계산` 의 곱셈 기호가 통째로
  // 사라져(`2 3 4 계산`) 마인드맵 제목이 텍스트뷰와 달라졌다.
  it('공백으로 둘러싼 * 는 강조가 아니므로 보존(곱셈 기호)', () => {
    expect(parseSummaryToTree('## 2 * 3 * 4 계산\n')[0]?.title).toBe('2 * 3 * 4 계산');
  });

  it('정상 *강조* 는 계속 제거', () => {
    expect(parseSummaryToTree('## *핵심* 요약\n')[0]?.title).toBe('핵심 요약');
    expect(parseSummaryToTree('## **굵게** 와 *기울임*\n')[0]?.title).toBe('굵게 와 기울임');
  });
});
