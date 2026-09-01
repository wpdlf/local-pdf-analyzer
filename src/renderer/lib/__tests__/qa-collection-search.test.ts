import { describe, it, expect, vi, beforeEach } from 'vitest';

// multi-doc Phase 2 module-1 — collectionRagSearch L2 통합 테스트.
// 활성(메모리)+비활성(세션 index.bin 복원) 혼합 검색, 재임베딩 0, 모델 불일치 제외,
// 멤버 로드 실패 시 부분 성공, 컨텍스트 출처(문서명) 라벨을 검증.

const mockEmbed = vi.fn();
const mockAbort = vi.fn(() => Promise.resolve());
const mockSessionLoad = vi.fn();
vi.stubGlobal('window', {
  electronAPI: {
    ai: { embed: mockEmbed, abort: mockAbort },
    session: { load: mockSessionLoad },
  },
});
vi.stubGlobal('crypto', { randomUUID: () => 'test-uuid' });

import { collectionRagSearch } from '../use-qa';
import { useAppStore } from '../store';
import { VectorStore } from '../vector-store';
import { chunkTextWithOverlapByPage } from '../chunker';
import { RAG_MIN_SCORE } from '../../../shared/constants';
import type { ResolvedMember } from '../../types';

const MODEL = 'nomic-embed-text';

/** 활성 문서 메모리 인덱스를 store.ragIndex 에 세팅 (3차원 소형 벡터) */
function seedActiveIndex(): void {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  // 쿼리 [1,0,0] 에 대해 a-chunk0 이 최고 점수가 되도록 구성
  vs.addChunk('활성 문서 핵심 본문 alpha', [1, 0, 0], 0, { pageStart: 2, pageEnd: 2 });
  vs.addChunk('활성 문서 보조 내용', [0.6, 0.8, 0], 1, { pageStart: 5, pageEnd: 5 });
  useAppStore.getState().setRagIndex(vs);
}

/** 비활성 멤버 세션 응답 — VectorStore.serialize 로 실제 index.bin 블롭 생성 */
function memberSessionResponse(fileName: string, dim3 = true) {
  const vs = new VectorStore();
  vs.setModel(MODEL);
  if (dim3) {
    vs.addChunk('비활성 멤버 관련 본문 beta', [0.9, 0.1, 0], 0, { pageStart: 7, pageEnd: 7 });
  } else {
    // 차원 불일치(5d) — 동질성 게이트를 통과시키더라도 search 가 [] 반환하는 2차 방어 검증용
    vs.addChunk('차원 다른 멤버', [1, 0, 0, 0, 0], 0);
  }
  const s = vs.serialize();
  return {
    session: {
      schemaVersion: 1,
      docHash: 'x'.repeat(64),
      fileName,
      filePath: `/d/${fileName}`,
      pageCount: 10,
      extractedText: 'text',
      pageTexts: ['p'],
      chapters: [],
      summaries: {},
      summaryType: 'full',
      qaMessages: [],
      embedModel: s.model,
      embedDim: s.dimension,
      chunkMeta: s.chunkMeta,
    },
    blob: s.buffer,
  };
}

function member(docHash: string, fileName: string, source: 'memory' | 'session'): ResolvedMember {
  return { docHash, fileName, source, status: 'ready' };
}

/**
 * QA30(B-3): collectionRagSearch 는 컨텍스트 문자열만이 아니라 **예산에 밀려 근거를 하나도 싣지
 * 못한 문서 수**(droppedDocs)를 함께 반환한다. 기존 단언은 컨텍스트만 보므로 얇은 어댑터를 쓴다.
 */
const ctxOf = (out: { context: string } | null): string | null => (out ? out.context : null);

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbed.mockResolvedValue({ success: true, embeddings: [[1, 0, 0]], model: MODEL });
  useAppStore.getState().ragIndex.clear();
});

describe('collectionRagSearch', () => {
  it('ready 멤버 0개면 null (단일 문서 강등은 호출자가 처리)', async () => {
    const out = await collectionRagSearch('질문', [
      { docHash: 'b', fileName: 'B.pdf', source: 'session', status: 'model-mismatch' },
    ], 'a');
    expect(out).toBeNull();
    expect(mockEmbed).not.toHaveBeenCalled();
  });

  it('활성(메모리)+비활성(세션) 혼합 검색 → 두 문서 출처가 컨텍스트에 포함', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(memberSessionResponse('Beta.pdf'));

    const out = ctxOf(await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a'));

    expect(out).not.toBeNull();
    expect(out).toContain('[Alpha.pdf p.2]'); // 활성 문서 출처 + 페이지
    expect(out).toContain('[Beta.pdf p.7]');  // 비활성 멤버 출처 + 페이지
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('질문 임베딩은 1회만 — 멤버 인덱스 재임베딩 0 (재사용)', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(memberSessionResponse('Beta.pdf'));
    await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a');
    expect(mockEmbed).toHaveBeenCalledTimes(1); // 멤버가 2개여도 질문 임베딩 1회
  });

  it('비활성 멤버 로드 실패 → 해당 멤버 skip, 활성으로 부분 성공', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(null); // 세션 부재
    const out = ctxOf(await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a'));
    expect(out).toContain('[Alpha.pdf p.2]');
    expect(out).not.toContain('Beta.pdf');
  });

  it('차원 불일치 멤버는 search 가 빈 결과 → 자연 제외(2차 방어)', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(memberSessionResponse('Beta.pdf', false)); // 5차원 인덱스
    const out = ctxOf(await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a'));
    expect(out).toContain('Alpha.pdf');
    expect(out).not.toContain('Beta.pdf'); // 차원 불일치로 검색 결과 없음
  });

  it('임베딩 실패 시 null', async () => {
    seedActiveIndex();
    mockEmbed.mockResolvedValue({ success: false, error: 'fail' });
    const out = await collectionRagSearch('질문', [member('a', 'Alpha.pdf', 'memory')], 'a');
    expect(out).toBeNull();
  });

  it('활성 멤버는 session.load 를 호출하지 않음 (메모리 인덱스 직접 사용)', async () => {
    seedActiveIndex();
    await collectionRagSearch('질문', [member('a', 'Alpha.pdf', 'memory')], 'a');
    expect(mockSessionLoad).not.toHaveBeenCalled();
  });

  // QA14(A-MED): 예산(8000) 초과 시 컨텍스트 packing 이 점수 순으로 선택돼야 최고점 교차문서 청크가
  // 축출되지 않는다. 이전엔 (docHash,index) 정렬 후 hard-break 라, docHash 사전순 뒤에 있는 최고점
  // 청크가 앞 문서의 큰 저점 청크에 예산이 소진돼 프롬프트에서 누락됐다(조용한 오답).
  it('예산 초과 시 최고점 교차문서 청크를 유지(score-first packing)', async () => {
    // 활성 'a'(docHash 앞): 큰 저점 청크 2개(각 ~5KB) — 예산을 먼저 소진시키던 원인
    const active = new VectorStore();
    active.setModel(MODEL);
    active.addChunk('AAA ' + 'a'.repeat(5000), [0.9, 0.4359, 0], 0, { pageStart: 2, pageEnd: 2 });   // score≈0.90
    active.addChunk('BBB ' + 'b'.repeat(5000), [0.85, 0.5268, 0], 1, { pageStart: 3, pageEnd: 3 });  // score≈0.85
    useAppStore.getState().setRagIndex(active);
    // 멤버 'z'(docHash 뒤): 최고점(1.0) 소형 청크 — 예산에서 밀려나면 안 됨
    const zeta = new VectorStore();
    zeta.setModel(MODEL);
    zeta.addChunk('TOPEVIDENCE ' + 'z'.repeat(2000), [1, 0, 0], 0, { pageStart: 7, pageEnd: 7 });      // score=1.0
    const zs = zeta.serialize();
    mockSessionLoad.mockResolvedValue({
      session: {
        schemaVersion: 1, docHash: 'z'.repeat(64), fileName: 'Zeta.pdf', filePath: '/d/Zeta.pdf',
        pageCount: 10, extractedText: 't', pageTexts: ['p'], chapters: [], summaries: {},
        summaryType: 'full', qaMessages: [], embedModel: zs.model, embedDim: zs.dimension, chunkMeta: zs.chunkMeta,
      },
      blob: zs.buffer,
    });

    const out = ctxOf(await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('z', 'Zeta.pdf', 'session'),
    ], 'a'));

    expect(out).not.toBeNull();
    expect(out).toContain('TOPEVIDENCE');       // 최고점 청크 유지(이전 code 는 docHash 정렬+break 로 축출)
    expect(out).toContain('[Zeta.pdf p.7]');     // 그 출처 라벨도 함께
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA30(B-3): `COLLECTION_TOP_K = 8` 은 라틴 문자 문서에서 **도달 불가능한 숫자**였다.
//
// 주석은 "단일 문서(5)보다 약간 넉넉하게" 라고 선언했지만, 컨텍스트 예산(8,000자)에 실제로
// 들어가는 청크 수는 문자 체계가 정한다 — 영문은 cpt 4.00 이라 청크가 ~1,900자여서 3~4개,
// 국문은 cpt 가 낮아 청크가 작으므로 더 많이 들어간다. 그 상태에서 병합 단계의 고정 컷은
// 순수한 손실이었다: 9위의 작은 청크가 예산에 들어갈 자리가 남았는데도 이미 잘려나갔다.
//
// 이 스펙의 입력은 **실제 `chunkTextWithOverlapByPage` 출력**이다 — 손으로 만든 짧은 청크로는
// 예산 루프에 진입조차 못 해 가드가 공허해진다(QA29 의 최대 발견이 정확히 그 이유로 누락됐다).
// ─────────────────────────────────────────────────────────────────────────────
describe('컬렉션 컨텍스트 예산 — 실제 청커 출력 기준 (QA30 B-3)', () => {
  const BUDGET = 8000; // MAX_QA_CONTEXT_CHARS

  /** 라틴(cpt 4.00) 30쪽 — 페이지마다 고유 토큰 */
  const enPages = Array.from({ length: 30 }, (_, p) =>
    Array.from({ length: 60 }, (_, j) => `p${p + 1}word${String(j).padStart(3, '0')}`).join(' '));
  /** 국문 30쪽 — 같은 RAG_CHUNK_SIZE 인데 cpt 가 낮아 청크가 작아진다 */
  const koPages = Array.from({ length: 30 }, (_, p) =>
    Array.from({ length: 40 }, (_, j) =>
      `${p + 1}쪽 ${j}번 항목은 검토 대상 문서의 주요 내용을 요약한 문장입니다.`).join(' '));

  const RAG_CHUNK_SIZE = 500;
  const enChunks = chunkTextWithOverlapByPage(enPages, RAG_CHUNK_SIZE);
  const koChunks = chunkTextWithOverlapByPage(koPages, RAG_CHUNK_SIZE);
  const avg = (cs: { text: string }[]) => cs.reduce((n, c) => n + c.text.length, 0) / cs.length;

  /** 점수를 내림차순으로 통제한 인덱스 — 쿼리 [1,0,0] 에 대해 cosine 이 곧 scores[i] */
  function storeOf(texts: string[], scores: number[], page = 1): VectorStore {
    const vs = new VectorStore();
    vs.setModel(MODEL);
    texts.forEach((t, i) => {
      const c = scores[i]!;
      vs.addChunk(t, [c, Math.sqrt(1 - c * c), 0], i, { pageStart: page + i, pageEnd: page + i });
    });
    return vs;
  }
  function blobOf(vs: VectorStore, fileName: string) {
    const s = vs.serialize();
    return {
      session: {
        schemaVersion: 1, docHash: 'z'.repeat(64), fileName, filePath: `/d/${fileName}`,
        pageCount: 30, extractedText: 't', pageTexts: ['p'], chapters: [], summaries: {},
        summaryType: 'full', qaMessages: [], embedModel: s.model, embedDim: s.dimension, chunkMeta: s.chunkMeta,
      },
      blob: s.buffer,
    };
  }
  /** 컨텍스트에 실제로 실린 세그먼트(= 출처 라벨) 수. 정규식 대신 리터럴 카운트 — 본문에
   *  섞인 대괄호/개행에 오탐하지 않는다. */
  const segmentCount = (ctx: string) =>
    ctx.split('[Alpha.pdf p.').length - 1 + ctx.split('[Zeta.pdf p.').length - 1;

  it('픽스처 자기검증: 영문 청크는 예산의 1/8 보다 크다 — 8개는 애초에 못 들어간다', () => {
    expect(enChunks.length).toBeGreaterThan(8);
    expect(avg(enChunks), '영문 청크 평균이 1,000자 이하면 이 스펙의 전제가 성립하지 않는다')
      .toBeGreaterThan(BUDGET / 8);
    expect(avg(enChunks)).toBeLessThan(BUDGET / 3); // 그래도 3~4개는 들어간다
    // 같은 설정에서 국문은 청크가 확연히 작다 = 실효 K 가 문자 체계에 따라 달라진다.
    expect(avg(koChunks)).toBeLessThan(avg(enChunks) * 0.8);
  });

  it('영문 2멤버: 채택 청크 수가 고정 상수 8 에 한참 못 미친다(예산이 실제 컷)', async () => {
    const a = storeOf(enChunks.slice(0, 5).map((c) => c.text), [0.99, 0.98, 0.97, 0.96, 0.95]);
    useAppStore.getState().setRagIndex(a);
    mockSessionLoad.mockResolvedValue(blobOf(
      storeOf(enChunks.slice(5, 10).map((c) => c.text), [0.94, 0.93, 0.92, 0.91, 0.90]), 'Zeta.pdf'));

    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('z', 'Zeta.pdf', 'session'),
    ], 'a');
    const ctx = ctxOf(out)!;
    expect(ctx.length).toBeLessThanOrEqual(BUDGET);
    expect(segmentCount(ctx), '영문에서 8개가 들어갔다면 픽스처가 실제 청크 크기를 잃었다')
      .toBeLessThan(8);
    expect(segmentCount(ctx)).toBeGreaterThanOrEqual(3);
  });

  it('국문 2멤버: 같은 예산·같은 설정인데 채택 수가 더 많다 — 고정 K 에 근거가 없다', async () => {
    const a = storeOf(koChunks.slice(0, 5).map((c) => c.text), [0.99, 0.98, 0.97, 0.96, 0.95]);
    useAppStore.getState().setRagIndex(a);
    mockSessionLoad.mockResolvedValue(blobOf(
      storeOf(koChunks.slice(5, 10).map((c) => c.text), [0.94, 0.93, 0.92, 0.91, 0.90]), 'Zeta.pdf'));

    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('z', 'Zeta.pdf', 'session'),
    ], 'a');
    const ko = segmentCount(ctxOf(out)!);
    expect(ko).toBeGreaterThan(4);
  });

  it('순위 8 밖의 작은 청크도 예산에 자리가 남으면 들어간다 (병합 고정 컷 제거)', async () => {
    // 전역 순위: A1..A5(0.99~0.95) → B1..B4(0.94~0.91) → TINY(0.90, 10위).
    // 종전 `mergeSearchResults(perMember, 8)` 은 TINY 를 예산 확인 **전에** 잘라버렸다.
    const a = storeOf(enChunks.slice(0, 5).map((c) => c.text), [0.99, 0.98, 0.97, 0.96, 0.95]);
    useAppStore.getState().setRagIndex(a);
    const tiny = 'TINYEVIDENCE 짧은 결정적 근거';
    mockSessionLoad.mockResolvedValue(blobOf(
      storeOf([...enChunks.slice(5, 9).map((c) => c.text), tiny], [0.94, 0.93, 0.92, 0.91, 0.90]), 'Zeta.pdf'));

    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('z', 'Zeta.pdf', 'session'),
    ], 'a');
    const ctx = ctxOf(out)!;
    // 픽스처 자기검증: 큰 청크만으로 예산이 거의 찼고(=TINY 앞의 후보 일부는 실제로 탈락했다),
    // 그런데도 남은 자리에 10위 소형 청크가 들어갔다.
    expect(segmentCount(ctx), '후보 10개가 다 들어갔다면 예산이 컷을 하지 않은 것이다').toBeLessThan(10);
    expect(ctx.length + avg(enChunks), '큰 청크가 더 들어갈 자리가 남았다 — 순위 컷과 예산 컷이 구분되지 않는다')
      .toBeGreaterThan(BUDGET);
    expect(ctx, '10위 소형 청크가 병합 단계에서 잘렸다').toContain('TINYEVIDENCE');
  });

  it('예산에 밀려 한 글자도 기여 못한 문서를 droppedDocs 로 보고한다', async () => {
    // 활성 문서의 큰 청크들이 예산을 채우고, 멤버의 청크는 전부 순위 뒤 + 큰 크기라 탈락한다.
    useAppStore.getState().setRagIndex(
      storeOf(enChunks.slice(0, 5).map((c) => c.text), [0.99, 0.98, 0.97, 0.96, 0.95]));
    mockSessionLoad.mockResolvedValue(blobOf(
      storeOf(enChunks.slice(5, 10).map((c) => c.text), [0.6, 0.59, 0.58, 0.57, 0.56]), 'Zeta.pdf'));

    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('z', 'Zeta.pdf', 'session'),
    ], 'a');
    expect(ctxOf(out)).not.toContain('Zeta.pdf');
    expect(out!.droppedDocs, '검색에 참여했는데 근거를 못 실은 문서가 고지되지 않는다').toBe(1);
  });

  it('모든 문서가 기여하면 droppedDocs 는 0 — 오탐하지 않는다', async () => {
    seedActiveIndex();
    mockSessionLoad.mockResolvedValue(memberSessionResponse('Beta.pdf'));
    const out = await collectionRagSearch('질문', [
      member('a', 'Alpha.pdf', 'memory'),
      member('b', 'Beta.pdf', 'session'),
    ], 'a');
    expect(out!.droppedDocs).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// QA30(B-7): 최소 유사도 임계가 main(`semantic-search.ts`)과 renderer(`use-qa.ts`)에 각각
// 리터럴 0.3 으로 있었고 둘을 잇는 것은 주석뿐이었다. shared 로 승격했으니, **렌더러 검색이
// 정말 그 상수를 쓰는지**를 값으로 못박는다(상수 값 자체를 다시 단언하면 동어반복이다).
// ─────────────────────────────────────────────────────────────────────────────
describe('RAG 최소 유사도는 shared 단일 출처를 쓴다 (QA30 B-7)', () => {
  /** 쿼리 [1,0,0] 에 대해 cosine 이 정확히 target 이 되는 벡터 */
  const vecFor = (target: number): number[] => [target, Math.sqrt(1 - target * target), 0];

  it('임계 바로 위 청크는 채택되고, 바로 아래 청크는 버려진다', async () => {
    const vs = new VectorStore();
    vs.setModel(MODEL);
    vs.addChunk('ABOVE 임계 위 근거', vecFor(RAG_MIN_SCORE + 0.02), 0, { pageStart: 2, pageEnd: 2 });
    vs.addChunk('BELOW 임계 아래 잡음', vecFor(RAG_MIN_SCORE - 0.02), 1, { pageStart: 3, pageEnd: 3 });
    useAppStore.getState().setRagIndex(vs);

    const ctx = ctxOf(await collectionRagSearch('질문', [member('a', 'Alpha.pdf', 'memory')], 'a'));
    expect(ctx).toContain('ABOVE');
    expect(ctx, '임계가 shared 값과 어긋나면 잡음 청크가 근거로 들어간다').not.toContain('BELOW');
  });
});
