import { describe, it, expect } from 'vitest';
import type { PdfDocument } from '../../types';
import { enrichDocumentWithImages } from '../enrich-doc';

// v0.18.19 patch R34 P2: use-summarize.ts 의 pure 부분(enrichDocumentWithImages) 회귀 가드.
//
// 본 함수는 Vision-partial-failure 시나리오와 챕터 슬라이싱 정확성에 직결되는 핵심 로직.
// 이전엔 use-summarize.ts 자체 의존성이 무거워 vitest 가 직접 import 불가했고, R32 의
// "Vision partial failure 시 enrichedPageTexts null 정책" 도 이 함수의 반환 형태에 의존.
// R33 Surface 4 가 use-summarize 0 tests 갭을 지적 — pure helper 분리로 ROI 확보.

function makeDoc(pageTexts: string[], extractedTextOverride?: string): PdfDocument {
  return {
    id: 'doc-test',
    fileName: 'test.pdf',
    filePath: '/test.pdf',
    pageCount: pageTexts.length,
    extractedText: extractedTextOverride ?? pageTexts.join('\n\n'),
    pageTexts,
    chapters: [],
    images: [],
    createdAt: new Date(),
  };
}

describe('enrichDocumentWithImages — empty descriptions (R34 P2)', () => {
  it('빈 description Map 이면 enrichedPages=null + extractedText 원본 반환', () => {
    const doc = makeDoc(['page1', 'page2'], 'ORIGINAL_EXTRACTED');
    const result = enrichDocumentWithImages(doc, new Map());
    expect(result.enrichedPages).toBeNull();
    expect(result.textForSummary).toBe('ORIGINAL_EXTRACTED');
  });
});

describe('enrichDocumentWithImages — 정상 enrichment', () => {
  it('단일 페이지에 description 한 줄 부착', () => {
    const doc = makeDoc(['Hello world.']);
    const descriptions = new Map<number, string[]>([[0, ['차트는 매출 증가를 보임']]]);
    const { enrichedPages, textForSummary } = enrichDocumentWithImages(doc, descriptions);
    expect(enrichedPages).not.toBeNull();
    expect(enrichedPages![0]).toBe('Hello world.\n[이미지 분석: 차트는 매출 증가를 보임]');
    expect(textForSummary).toContain('[이미지 분석: 차트는 매출 증가를 보임]');
  });

  it('한 페이지에 여러 description 이 \\n 으로 join 되어 부착', () => {
    const doc = makeDoc(['Page A']);
    const descriptions = new Map<number, string[]>([[0, ['차트1', '차트2', '차트3']]]);
    const { enrichedPages } = enrichDocumentWithImages(doc, descriptions);
    expect(enrichedPages![0]).toBe('Page A\n[이미지 분석: 차트1]\n[이미지 분석: 차트2]\n[이미지 분석: 차트3]');
  });

  it('여러 페이지에 각각 description 부착 — 순서 보존', () => {
    const doc = makeDoc(['P0', 'P1', 'P2']);
    const descriptions = new Map<number, string[]>([
      [0, ['d0']],
      [2, ['d2']],
    ]);
    const { enrichedPages } = enrichDocumentWithImages(doc, descriptions);
    expect(enrichedPages!.length).toBe(3);
    expect(enrichedPages![0]).toContain('d0');
    expect(enrichedPages![1]).toBe('P1'); // 미적용 페이지는 원본
    expect(enrichedPages![2]).toContain('d2');
  });

  it('textForSummary 는 enrichedPages 를 \\n\\n 으로 join', () => {
    const doc = makeDoc(['A', 'B']);
    const descriptions = new Map<number, string[]>([[0, ['x']]]);
    const { textForSummary } = enrichDocumentWithImages(doc, descriptions);
    expect(textForSummary).toBe('A\n[이미지 분석: x]\n\nB');
  });
});

describe('enrichDocumentWithImages — out-of-range 페이지 처리', () => {
  it('pageIdx >= pageTexts.length 는 silently skip — 불변식 유지', () => {
    const doc = makeDoc(['only page']);
    const descriptions = new Map<number, string[]>([
      [0, ['d0']],
      [5, ['ignored — 페이지 없음']],
      [-1, ['ignored — 음수']], // -1 < 1 은 true 라 silently merge 됨. 음수 case 는 호출자 책임
    ]);
    // -1 인덱스는 자바스크립트에서 객체 키로 처리되어 array slot 에 영향 없음
    const { enrichedPages } = enrichDocumentWithImages(doc, descriptions);
    expect(enrichedPages!.length).toBe(1);
    expect(enrichedPages![0]).toContain('d0');
  });
});

describe('enrichDocumentWithImages — 불변식 (defense-in-depth)', () => {
  it('pageTexts 가 비어있어도 빈 enrichedPages 반환 (size=0 분기 안 탐)', () => {
    // pageTexts=[] 이지만 description 이 있는 비현실적 케이스 — out-of-range 만 있으므로
    // 모든 description 이 skip 되고 빈 enrichedPages 반환
    const doc = makeDoc([]);
    const descriptions = new Map<number, string[]>([[0, ['d']]]);
    const { enrichedPages, textForSummary } = enrichDocumentWithImages(doc, descriptions);
    expect(enrichedPages).toEqual([]);
    expect(textForSummary).toBe('');
  });

  it('원본 doc.pageTexts 는 mutate 되지 않는다 (shallow copy 보존)', () => {
    const originalPages = ['unchanged'];
    const doc = makeDoc(originalPages);
    const descriptions = new Map<number, string[]>([[0, ['enrichment']]]);
    enrichDocumentWithImages(doc, descriptions);
    expect(originalPages[0]).toBe('unchanged');
    expect(doc.pageTexts[0]).toBe('unchanged');
  });
});

describe('enrichDocumentWithImages — Vision partial-failure (R34 P2 의 핵심)', () => {
  // R32 P3 / R34 P1 의 시나리오: 이미지 분석이 켜졌으나 모든 이미지가 fail 한 경우.
  // 호출자 (use-summarize) 는 enrichedPages 의 nullity 만으로 "raw pageTexts 재사용" 신호
  // 를 판단하므로 이 출력 계약이 깨지면 stale enrichment 가 RAG 인덱스에 누출됨.
  it('imageDescriptions.size === 0 일 때 enrichedPages 반드시 null', () => {
    const doc = makeDoc(['Page A', 'Page B']);
    const result = enrichDocumentWithImages(doc, new Map());
    expect(result.enrichedPages).toBeNull();
  });

  it('imageDescriptions.size > 0 일 때 enrichedPages 절대 null 아님', () => {
    const doc = makeDoc(['Page A']);
    const descriptions = new Map<number, string[]>([[0, ['d']]]);
    const result = enrichDocumentWithImages(doc, descriptions);
    expect(result.enrichedPages).not.toBeNull();
  });
});
