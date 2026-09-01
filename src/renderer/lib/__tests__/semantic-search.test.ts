import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GlobalSearchResult } from '../../../shared/session-types';

// 의미 검색 렌더러 오케스트레이션 — checkEmbedModel/embed 게이트 + main(session:searchSemantic) 위임.
// 코사인 매칭 자체의 검증은 main 으로 이전(src/main/__tests__/semantic-search.test.ts).

const API = vi.hoisted(() => ({
  checkEmbedModel: vi.fn(),
  embed: vi.fn(),
  searchSemantic: vi.fn(),
}));
vi.stubGlobal('window', {
  electronAPI: {
    ai: { checkEmbedModel: API.checkEmbedModel, embed: API.embed },
    session: { searchSemantic: API.searchSemantic },
  },
});

import { searchSessionsSemantic } from '../semantic-search';

const result = (over: Partial<GlobalSearchResult> = {}): GlobalSearchResult => ({
  docHash: 'a'.repeat(64), fileName: 'f.pdf', filePath: '/f.pdf', pageCount: 1,
  score: 1, inSummary: false, snippets: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  API.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic' });
  API.embed.mockResolvedValue({ success: true, embeddings: [[1, 0]], model: 'nomic' });
  API.searchSemantic.mockResolvedValue({ results: [], excludedCount: 0 });
});

describe('searchSessionsSemantic (렌더러 오케스트레이션)', () => {
  it('2자 미만 → 빈 결과(임베딩·검색 미호출)', async () => {
    const out = await searchSessionsSemantic('a');
    expect(out.results).toEqual([]);
    expect(API.embed).not.toHaveBeenCalled();
    expect(API.searchSemantic).not.toHaveBeenCalled();
  });

  it('임베딩 모델 없음 → no-embed-model (검색 미호출)', async () => {
    API.checkEmbedModel.mockResolvedValue({ available: false });
    const out = await searchSessionsSemantic('질의어');
    expect(out.status).toBe('no-embed-model');
    expect(API.searchSemantic).not.toHaveBeenCalled();
  });

  it('질의 임베딩 실패 → embed-failed (검색 미호출)', async () => {
    API.embed.mockResolvedValue({ success: false });
    const out = await searchSessionsSemantic('질의어');
    expect(out.status).toBe('embed-failed');
    expect(API.searchSemantic).not.toHaveBeenCalled();
  });

  it('정상 → searchSemantic(queryEmbedding, check.model, dim) 위임 + outcome 매핑', async () => {
    API.searchSemantic.mockResolvedValue({ results: [result({ score: 0.9 })], excludedCount: 2 });
    const out = await searchSessionsSemantic('질의어');
    expect(API.searchSemantic).toHaveBeenCalledWith([1, 0], 'nomic', 2);
    expect(out.status).toBe('ok');
    expect(out.results).toHaveLength(1);
    expect(out.excludedCount).toBe(2);
  });

  // QA30(C-1b): 인덱스 손상·부재 문서는 종전에 excludedCount 에도 안 들어가고 결과에도 없어
  // **완전 무음**이었다(실측: 손상 4종이 results=2/excluded=2 뒤에 통째로 숨음). 모델 불일치와
  // 원인·해결책이 다르므로 별도 카운트로 올라와야 한다.
  it('손상 인덱스 수가 corruptedCount 로 전파된다', async () => {
    API.searchSemantic.mockResolvedValue({ results: [result({ score: 0.9 })], excludedCount: 1, corruptedCount: 3 });
    const out = await searchSessionsSemantic('질의어');
    expect(out.excludedCount).toBe(1);
    expect(out.corruptedCount).toBe(3);
  });

  // 옛 main(필드 없음)과 섞여도 UI 가 undefined 를 렌더하지 않도록 0 으로 수렴.
  it('main 이 corruptedCount 를 안 주면 0 으로 수렴한다', async () => {
    API.searchSemantic.mockResolvedValue({ results: [], excludedCount: 0 });
    const out = await searchSessionsSemantic('질의어');
    expect(out.corruptedCount).toBe(0);
  });

  it('embed 반환 model 태그가 달라도 check.model 로 위임 — 정상 문서 오제외 방지(E2E 회귀)', async () => {
    // 인덱스 embedModel 은 빌드 시 checkEmbedModel.model 로 기록됨. embed IPC 가 :latest 태그를 붙여
    // 반환해도 그걸로 비교하면 전부 제외되던 버그 → 렌더러가 check.model 을 main 에 전달해야 한다.
    API.checkEmbedModel.mockResolvedValue({ available: true, model: 'nomic-embed-text' });
    API.embed.mockResolvedValue({ success: true, embeddings: [[1, 0]], model: 'nomic-embed-text:latest' });
    await searchSessionsSemantic('질의어');
    expect(API.searchSemantic).toHaveBeenCalledWith([1, 0], 'nomic-embed-text', 2);
  });
});
