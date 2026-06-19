import { describe, it, expect } from 'vitest';
import { searchPersistedSession, rankSearchResults } from '../session-search';
import type { GlobalSearchResult } from '../../shared/session-types';

const META = { docHash: 'a'.repeat(64), fileName: 'lecture.pdf', filePath: '/x/lecture.pdf', pageCount: 3 };

describe('searchPersistedSession — 키워드 매칭', () => {
  it('페이지 텍스트 매칭 → 페이지 번호 + 스니펫 + 발생수 점수', () => {
    const session = { pageTexts: ['프로세스 개요', '프로세스는 실행 중인 프로그램. 프로세스 상태.', '메모리'] };
    const r = searchPersistedSession(META, session, '프로세스')!;
    expect(r).not.toBeNull();
    // p1: 1회, p2: 2회 → 본문 점수 3
    expect(r.score).toBe(3);
    expect(r.snippets.map((s) => s.page)).toEqual([1, 2]);
    expect(r.snippets[0]!.text).toContain('프로세스');
  });

  it('대소문자 무관', () => {
    const r = searchPersistedSession(META, { pageTexts: ['Operating System overview'] }, 'system');
    expect(r?.snippets[0]?.page).toBe(1);
  });

  it('파일명 매칭은 본문 없이도 +5 부스트', () => {
    const r = searchPersistedSession(META, { pageTexts: ['무관한 내용'] }, 'lecture')!;
    expect(r.score).toBe(5);
    expect(r.snippets).toHaveLength(0); // 본문 매칭은 없음
  });

  it('요약 본문 매칭 → inSummary + 부스트', () => {
    const session = { pageTexts: ['x'], summaries: { full: { content: '핵심은 동기화이다', model: 'm', provider: 'p' } } };
    const r = searchPersistedSession(META, session, '동기화')!;
    expect(r.inSummary).toBe(true);
    expect(r.score).toBe(2);
  });

  it('매칭 없음 → null', () => {
    expect(searchPersistedSession(META, { pageTexts: ['전혀 다른 내용'] }, '존재하지않는단어')).toBeNull();
  });

  it('2자 미만 쿼리 → null', () => {
    expect(searchPersistedSession(META, { pageTexts: ['a a a'] }, 'a')).toBeNull();
  });

  it('스니펫은 최대 3개 (매칭 페이지 많아도)', () => {
    const session = { pageTexts: Array.from({ length: 6 }, () => '키워드 포함') };
    const r = searchPersistedSession(META, session, '키워드')!;
    expect(r.snippets).toHaveLength(3);
    expect(r.score).toBe(6); // 점수는 전 페이지 발생수 합산
  });

  it('손상된 session(비배열 pageTexts/비문자열) → 방어, 크래시 없음', () => {
    expect(searchPersistedSession(META, { pageTexts: 'not-array' }, 'x')).toBeNull();
    expect(searchPersistedSession(META, null, 'lecture')!.score).toBe(5); // 파일명만 매칭
    const r = searchPersistedSession(META, { pageTexts: [123, null, '키워드'] }, '키워드');
    expect(r?.snippets[0]?.page).toBe(3);
  });

  it('긴 텍스트는 발췌 + 양끝 … 표시', () => {
    const long = 'X'.repeat(200) + '키워드' + 'Y'.repeat(200);
    const r = searchPersistedSession(META, { pageTexts: [long] }, '키워드')!;
    expect(r.snippets[0]!.text.startsWith('…')).toBe(true);
    expect(r.snippets[0]!.text.endsWith('…')).toBe(true);
    expect(r.snippets[0]!.text.length).toBeLessThan(150);
  });
});

describe('rankSearchResults', () => {
  const mk = (docHash: string, score: number): GlobalSearchResult => ({
    docHash, fileName: 'f', filePath: '/f', pageCount: 1, score, inSummary: false, snippets: [],
  });

  it('점수 내림차순 정렬 + 상한 적용', () => {
    const ranked = rankSearchResults([mk('a', 2), mk('b', 9), mk('c', 5)], 2);
    expect(ranked.map((r) => r.docHash)).toEqual(['b', 'c']);
  });
});
