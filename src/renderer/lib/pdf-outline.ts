// PDF 목차(아웃라인) 추출 — pdfjs `getOutline()` 의 북마크 트리를 페이지 번호가 해석된
// 평탄한 도메인 트리(OutlineNode)로 변환한다.
//
// 설계 노트:
// - 영속화하지 않는다. PdfViewer 가 이미 로드한 PDFDocumentProxy 에서 마운트 시 1회 추출하므로
//   PdfDocument 타입·세션 스키마·파싱 경로를 건드릴 필요가 없다 (목차는 뷰어가 열린 동안만 의미).
// - dest 는 named destination(문자열) 또는 explicit dest(배열) 둘 다 올 수 있어 양쪽을
//   getPageIndex 로 1-based 페이지로 해석한다. 해석 불가/외부 URL 항목은 page=null (비클릭).
// - 깊이/개수 상한으로 비정상적으로 큰 아웃라인의 폭주를 막는다.

export interface OutlineNode {
  /** 북마크 제목 (빈 제목은 '—' 로 대체) */
  title: string;
  /** 1-based 페이지 번호. 해석 불가(외부 링크·dest 없음)면 null */
  page: number | null;
  children: OutlineNode[];
}

const MAX_OUTLINE_DEPTH = 4;
const MAX_OUTLINE_ITEMS = 500;

// pdfjs OutlineItem 의 구조적 최소 형태 (정확한 내부 타입 결합을 피해 느슨하게 받는다).
interface RawOutlineItem {
  title?: string;
  dest?: string | unknown[] | null;
  url?: string | null;
  items?: RawOutlineItem[];
}

// getOutline / getDestination / getPageIndex 만 의존 — 테스트에서 가짜 doc 주입이 쉽도록 구조적 타입.
interface OutlineDoc {
  getOutline(): Promise<RawOutlineItem[] | null | undefined>;
  getDestination(id: string): Promise<unknown[] | null | undefined>;
  getPageIndex(ref: unknown): Promise<number>;
}

/**
 * 로드된 PDF 문서에서 목차 트리를 추출한다. 목차가 없거나 추출 실패 시 빈 배열.
 */
export async function extractOutline(doc: OutlineDoc): Promise<OutlineNode[]> {
  let raw: RawOutlineItem[] | null | undefined;
  try {
    raw = await doc.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(raw) || raw.length === 0) return [];

  let count = 0;

  const walk = async (items: RawOutlineItem[], depth: number): Promise<OutlineNode[]> => {
    if (depth > MAX_OUTLINE_DEPTH) return [];
    const out: OutlineNode[] = [];
    for (const item of items) {
      if (count >= MAX_OUTLINE_ITEMS) break;
      count++;
      const title = (item?.title ?? '').trim();
      const page = await resolvePage(doc, item?.dest);
      const children =
        Array.isArray(item?.items) && item.items.length > 0
          ? await walk(item.items, depth + 1)
          : [];
      // 제목·자식·페이지 모두 없는 항목은 노이즈 → 스킵. (페이지가 있으면 빈 제목이라도
      // 클릭 가능한 항목이므로 '—' 라벨로 유지)
      if (!title && children.length === 0 && page == null) continue;
      out.push({ title: title || '—', page, children });
    }
    return out;
  };

  return walk(raw, 0);
}

// dest(문자열 또는 배열)를 1-based 페이지 번호로 해석. 실패 시 null.
async function resolvePage(doc: OutlineDoc, dest: RawOutlineItem['dest']): Promise<number | null> {
  if (dest == null) return null;
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    // ref 는 {num, gen} 형태의 RefProxy. 원시값(null/숫자)면 해석 불가.
    if (ref == null || typeof ref !== 'object') return null;
    const idx = await doc.getPageIndex(ref);
    return typeof idx === 'number' && idx >= 0 ? idx + 1 : null;
  } catch {
    return null;
  }
}
