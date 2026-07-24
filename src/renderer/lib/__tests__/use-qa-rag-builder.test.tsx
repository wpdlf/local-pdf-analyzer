// @vitest-environment happy-dom

// R44 H-1 회귀 가드: R43 이 도입한 "복원 마커 1회용 소비"(setRestoredSession(null))가
// effect deps 구독과 결합하면, cleanup 이 방금 시작한 빌드를 abort 하고 재실행은 same-key
// 조기 return 으로 빌드가 영구 누락됐다 (chunkCount N→0 영속화가 디스크 index.bin 까지
// 삭제하는 2차 피해 동반). 수정: restoredSession 을 deps 에서 빼고 getState() 로 읽는다.
// 본 테스트는 훅 레벨에서 "소비 후에도 빌드가 완주한다"는 계약을 가드한다.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';

vi.stubGlobal('window', Object.assign(window, {
  electronAPI: {
    settings: { set: vi.fn(() => Promise.resolve()), get: vi.fn(() => Promise.resolve({})) },
    ai: {
      checkEmbedModel: vi.fn(() => Promise.resolve({ available: true, model: 'test-embed' })),
      embed: vi.fn((texts: string[]) =>
        Promise.resolve({ success: true, embeddings: texts.map(() => [0.1, 0.2]), model: 'test-embed' })),
      abort: vi.fn(() => Promise.resolve()),
    },
  },
}));

import { useRagBuilder } from '../use-qa';
import { useAppStore } from '../store';
import type { PdfDocument } from '../../types';

function makeDoc(id: string): PdfDocument {
  return {
    id,
    fileName: 't.pdf',
    filePath: '/t.pdf',
    pageCount: 1,
    extractedText: '본문 텍스트입니다.',
    pageTexts: ['본문 텍스트입니다.'],
    chapters: [],
    images: [],
    createdAt: new Date(),
  };
}

afterEach(() => {
  cleanup();
  useAppStore.getState().ragIndex.clear();
  useAppStore.setState((s) => ({
    document: null,
    restoredSession: null,
    sessionRestorePending: false,
    enrichedPageTexts: null,
    ragState: { isIndexing: false, isAvailable: false, chunkCount: 0, progress: null, model: null, error: null },
    settings: { ...s.settings, provider: 'ollama' as const },
  }));
});

describe('useRagBuilder × 복원 마커 (R44 H-1)', () => {
  it('마커 비채택(provider 불일치) → 소비 + 빌드가 완주한다 (자기-abort 회귀 가드)', async () => {
    useAppStore.setState((s) => ({
      document: makeDoc('doc-h1'),
      sessionRestorePending: false,
      // 마커 provider 와 현재 provider 가 달라 채택 분기를 통과하지 못함 → 정상 빌드 + 소비
      restoredSession: { docId: 'doc-h1', provider: 'ollama', embedModel: 'x' },
      settings: { ...s.settings, provider: 'gemini' as const },
    }));

    renderHook(() => useRagBuilder());

    // R44 H-1 버그 시: 소비 setState → cleanup 이 빌드 abort → 재실행 same-key 조기 return
    // → chunkCount 가 영원히 0. 수정 후엔 빌드가 생존해 인덱스가 채워진다.
    await waitFor(() => {
      expect(useAppStore.getState().ragState.chunkCount).toBeGreaterThan(0);
    });
    expect(useAppStore.getState().ragState.isAvailable).toBe(true);
    // 마커는 1회용으로 소비됨 (R43 H-1 의 원래 목적 유지)
    expect(useAppStore.getState().restoredSession).toBeNull();
  });

  it('마커 채택(문서+provider 일치) → 재빌드 skip + 마커 보존', async () => {
    useAppStore.setState((s) => ({
      document: makeDoc('doc-adopt'),
      sessionRestorePending: false,
      restoredSession: { docId: 'doc-adopt', provider: s.settings.provider, embedModel: 'x' },
    }));

    renderHook(() => useRagBuilder());

    // 채택 경로는 effect 본문에서 동기적으로 결정·return 한다(use-qa.ts L809-817). 빌드 경로였다면
    // 같은 동기 실행 중 restoredSession 이 null 로 소비되고(L827-829), buildRagIndex 의 첫 await
    // 표현식이 checkEmbedModel() 호출이라(L254) buildRagIndex(...) 호출 시점에 동기적으로 불린다.
    // 따라서 renderHook(effect flush) 직후 두 단언이 결정적으로 성립 — 기존의 임의 setTimeout(30ms)
    // 실시간 대기는 불필요했고, CI 부하 시 "빌드 미시작"을 "skip"으로 오판하는 위양성 위험이 있었다.
    expect(window.electronAPI.ai.checkEmbedModel).not.toHaveBeenCalled();
    expect(useAppStore.getState().restoredSession).not.toBeNull();
  });
});
