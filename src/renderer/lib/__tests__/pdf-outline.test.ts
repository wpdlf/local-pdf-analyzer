import { describe, it, expect, vi } from 'vitest';
import { extractOutline } from '../pdf-outline';

// 가짜 PDFDocumentProxy — getOutline/getDestination/getPageIndex 만 구현.
// ref 객체는 {num} 형태, pageMap 으로 0-based 페이지 인덱스 해석.
function makeDoc(opts: {
  outline: unknown[] | null | undefined | (() => never);
  named?: Record<string, unknown[] | null>;
  pageByRef?: Map<unknown, number>;
}) {
  return {
    getOutline: vi.fn(async () => {
      if (typeof opts.outline === 'function') return opts.outline();
      return opts.outline as never;
    }),
    getDestination: vi.fn(async (id: string) => opts.named?.[id] ?? null),
    getPageIndex: vi.fn(async (ref: unknown) => {
      const idx = opts.pageByRef?.get(ref);
      if (idx == null) throw new Error('unknown ref');
      return idx;
    }),
  };
}

describe('extractOutline', () => {
  it('목차 없음(null) → 빈 배열', async () => {
    expect(await extractOutline(makeDoc({ outline: null }) as never)).toEqual([]);
    expect(await extractOutline(makeDoc({ outline: [] }) as never)).toEqual([]);
  });

  it('getOutline 예외 → 빈 배열(throw 안 함)', async () => {
    const doc = makeDoc({ outline: () => { throw new Error('boom'); } });
    expect(await extractOutline(doc as never)).toEqual([]);
  });

  it('explicit dest(배열) 를 1-based 페이지로 해석', async () => {
    const ref = { num: 10, gen: 0 };
    const doc = makeDoc({
      outline: [{ title: '서론', dest: [ref, { name: 'XYZ' }, 0, 0, 0] }],
      pageByRef: new Map([[ref, 0]]), // 0-based 0 → page 1
    });
    const out = await extractOutline(doc as never);
    expect(out).toEqual([{ title: '서론', page: 1, children: [] }]);
  });

  it('named dest(문자열) 를 getDestination 으로 해석', async () => {
    const ref = { num: 20, gen: 0 };
    const doc = makeDoc({
      outline: [{ title: '2장', dest: 'chapter2' }],
      named: { chapter2: [ref, { name: 'Fit' }] },
      pageByRef: new Map([[ref, 4]]), // → page 5
    });
    const out = await extractOutline(doc as never);
    expect(out[0]).toEqual({ title: '2장', page: 5, children: [] });
  });

  it('중첩 children 재귀 해석', async () => {
    const r1 = { num: 1 };
    const r2 = { num: 2 };
    const doc = makeDoc({
      outline: [
        { title: '1부', dest: [r1], items: [{ title: '1.1절', dest: [r2] }] },
      ],
      pageByRef: new Map([[r1, 0], [r2, 2]]),
    });
    const out = await extractOutline(doc as never);
    expect(out).toEqual([
      { title: '1부', page: 1, children: [{ title: '1.1절', page: 3, children: [] }] },
    ]);
  });

  it('dest 없음/외부 URL 항목 → page null (비클릭)', async () => {
    const doc = makeDoc({
      outline: [
        { title: '외부 링크', url: 'https://example.com' },
        { title: 'dest 없음' },
      ],
    });
    const out = await extractOutline(doc as never);
    expect(out).toEqual([
      { title: '외부 링크', page: null, children: [] },
      { title: 'dest 없음', page: null, children: [] },
    ]);
  });

  it('해석 실패(getPageIndex throw) → page null, throw 안 함', async () => {
    const ref = { num: 99 };
    const doc = makeDoc({
      outline: [{ title: '깨진 dest', dest: [ref] }],
      pageByRef: new Map(), // ref 미등록 → getPageIndex throw
    });
    const out = await extractOutline(doc as never);
    expect(out[0]).toEqual({ title: '깨진 dest', page: null, children: [] });
  });

  it('중첩 깊이 캡(MAX_OUTLINE_DEPTH=4) — 정확히 4 레벨, 5번째는 잘림', async () => {
    const refs = [{ num: 1 }, { num: 2 }, { num: 3 }, { num: 4 }, { num: 5 }];
    const l5 = { title: 'L5', dest: [refs[4]] };
    const l4 = { title: 'L4', dest: [refs[3]], items: [l5] };
    const l3 = { title: 'L3', dest: [refs[2]], items: [l4] };
    const l2 = { title: 'L2', dest: [refs[1]], items: [l3] };
    const l1 = { title: 'L1', dest: [refs[0]], items: [l2] };
    const doc = makeDoc({ outline: [l1], pageByRef: new Map(refs.map((r, i) => [r, i])) });
    const out = await extractOutline(doc as never);
    expect(out[0]?.title).toBe('L1'); // depth 0
    expect(out[0]?.children[0]?.title).toBe('L2'); // depth 1
    expect(out[0]?.children[0]?.children[0]?.title).toBe('L3'); // depth 2
    const l4node = out[0]?.children[0]?.children[0]?.children[0];
    expect(l4node?.title).toBe('L4'); // depth 3
    expect(l4node?.children).toEqual([]); // depth 4 (L5) 는 잘림
  });

  it('제목·자식 모두 없는 항목은 스킵, 빈 제목은 — 로 대체', async () => {
    const ref = { num: 5 };
    const doc = makeDoc({
      outline: [
        { title: '', dest: undefined }, // 스킵 (제목·자식 없음)
        { title: '   ', dest: [ref], items: [] }, // 빈 제목이나 page 있음 → '—'
      ],
      pageByRef: new Map([[ref, 0]]),
    });
    const out = await extractOutline(doc as never);
    expect(out).toEqual([{ title: '—', page: 1, children: [] }]);
  });
});
