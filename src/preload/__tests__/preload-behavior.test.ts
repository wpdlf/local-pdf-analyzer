import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ElectronAPI } from '../index';

// preload contextBridge 행위 테스트 (preload-shape.test.ts 의 정적 가드와 상보).
//
// 기존 preload-shape 는 소스를 텍스트로 읽어 채널 이름/surface drift 만 가드한다(코드 미실행).
// 이 파일은 electron(contextBridge/ipcRenderer/webUtils)을 모킹해 모듈을 실제 import → exposeInMainWorld
// 로 노출된 객체를 캡처하고, 각 래퍼를 호출해 다음을 검증한다:
//   - invoke 래퍼: 올바른 채널 + 인자 전달, 반환값 passthrough
//   - openExternal: non-https 차단(invoke 미호출), https invoke 위임
//   - getPathForFile: webUtils 경로 / 빈 문자열 / throw→'' fallback
//   - on* 리스너: ipcRenderer.on 등록 + event 인자 제거 후 콜백 포워딩 + 구독 해제(removeListener)

const H = vi.hoisted(() => ({
  exposed: null as Record<string, unknown> | null,
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, unknown>) => {
      H.exposed = api;
    },
  },
  ipcRenderer: {
    invoke: (...a: unknown[]) => H.invoke(...a),
    on: (...a: unknown[]) => H.on(...a),
    removeListener: (...a: unknown[]) => H.removeListener(...a),
  },
  webUtils: {
    getPathForFile: (...a: unknown[]) => H.getPathForFile(...a),
  },
}));

// 모듈 side-effect(exposeInMainWorld) 실행 → H.exposed 채워짐
import '../index';
import { stripJsComments } from '../../shared/__tests__/helpers/source-scan';

function getApi(): ElectronAPI {
  if (!H.exposed) throw new Error('preload 가 electronAPI 를 노출하지 않음');
  return H.exposed as unknown as ElectronAPI;
}

/** 특정 채널로 등록된 on 핸들러 추출 */
function handlerFor(channel: string): (...args: unknown[]) => void {
  const call = H.on.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`on(${channel}) 미등록`);
  return call[1] as (...args: unknown[]) => void;
}

const FAKE_EVENT = {} as Electron.IpcRendererEvent;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('preload exposeInMainWorld', () => {
  it('electronAPI 로 노출되며 top-level surface 를 갖는다', () => {
    const a = getApi();
    expect(a).toBeTruthy();
    for (const key of ['ollama', 'ai', 'file', 'settings', 'apiKey', 'session', 'collections'] as const) {
      expect(a[key]).toBeTypeOf('object');
    }
    expect(a.openExternal).toBeTypeOf('function');
    expect(a.getPathForFile).toBeTypeOf('function');
    expect(a.onSetupProgress).toBeTypeOf('function');
    expect(a.onFileDropped).toBeTypeOf('function');
  });
});

describe('invoke 래퍼 — 채널 + 인자 전달', () => {
  it('ollama.* → 올바른 채널', () => {
    const a = getApi();
    a.ollama.getStatus();
    a.ollama.install();
    a.ollama.start();
    a.ollama.stop();
    a.ollama.pullModel('llama3.5:4b');
    a.ollama.cancelPull();
    a.ollama.listModels();
    expect(H.invoke).toHaveBeenCalledWith('ollama:status');
    expect(H.invoke).toHaveBeenCalledWith('ollama:install');
    expect(H.invoke).toHaveBeenCalledWith('ollama:start');
    expect(H.invoke).toHaveBeenCalledWith('ollama:stop');
    expect(H.invoke).toHaveBeenCalledWith('ollama:pull-model', 'llama3.5:4b');
    expect(H.invoke).toHaveBeenCalledWith('ollama:cancel-pull');
    expect(H.invoke).toHaveBeenCalledWith('ollama:list-models');
  });

  it('ai.* → 올바른 채널 + 인자', () => {
    const a = getApi();
    const req = { text: 't', type: 'full', provider: 'ollama', model: 'm', ollamaBaseUrl: 'http://x' } as const;
    a.ai.generate('req1', req);
    a.ai.abort('req1');
    a.ai.checkAvailable('claude', 'http://x');
    a.ai.analyzeImage('b64', 'req2');
    a.ai.ocrPage('b64', 'req3');
    a.ai.embed(['x', 'y'], 'req4');
    a.ai.checkEmbedModel();
    expect(H.invoke).toHaveBeenCalledWith('ai:generate', 'req1', req);
    expect(H.invoke).toHaveBeenCalledWith('ai:abort', 'req1');
    expect(H.invoke).toHaveBeenCalledWith('ai:check-available', 'claude', 'http://x');
    expect(H.invoke).toHaveBeenCalledWith('ai:analyze-image', 'b64', 'req2');
    expect(H.invoke).toHaveBeenCalledWith('ai:ocr-page', 'b64', 'req3');
    expect(H.invoke).toHaveBeenCalledWith('ai:embed', ['x', 'y'], 'req4');
    expect(H.invoke).toHaveBeenCalledWith('ai:check-embed-model');
  });

  it('file / settings / apiKey → 올바른 채널 + 인자', () => {
    const a = getApi();
    a.file.save('content', 'out.md');
    a.file.openPdf();
    a.file.openPath('/abs/x.pdf');
    a.settings.get();
    a.settings.set({ theme: 'dark' });
    a.apiKey.save('openai', 'sk-xxx');
    a.apiKey.has('openai');
    a.apiKey.delete('openai');
    expect(H.invoke).toHaveBeenCalledWith('file:save', 'content', 'out.md');
    expect(H.invoke).toHaveBeenCalledWith('file:open-pdf');
    expect(H.invoke).toHaveBeenCalledWith('file:open-path', '/abs/x.pdf');
    expect(H.invoke).toHaveBeenCalledWith('settings:get');
    expect(H.invoke).toHaveBeenCalledWith('settings:set', { theme: 'dark' });
    expect(H.invoke).toHaveBeenCalledWith('apikey:save', 'openai', 'sk-xxx');
    expect(H.invoke).toHaveBeenCalledWith('apikey:has', 'openai');
    expect(H.invoke).toHaveBeenCalledWith('apikey:delete', 'openai');
  });

  it('session / collections → 올바른 채널 + 인자', () => {
    const a = getApi();
    const payload = { meta: { } as never, session: {}, blob: null };
    a.session.load('hash1');
    a.session.save(payload);
    a.session.saveSummary({ docHash: 'h', type: 'full', summary: { content: 'c', model: 'm', provider: 'ollama' } });
    a.session.list();
    a.session.delete('hash1');
    a.session.clear();
    a.session.stats();
    a.collections.list();
    a.collections.save({ name: 'C', docHashes: ['h1'] });
    a.collections.delete('cid');
    a.collections.touch('cid');
    expect(H.invoke).toHaveBeenCalledWith('session:load', 'hash1');
    expect(H.invoke).toHaveBeenCalledWith('session:save', payload);
    expect(H.invoke).toHaveBeenCalledWith('session:saveSummary', expect.objectContaining({ docHash: 'h', type: 'full' }));
    expect(H.invoke).toHaveBeenCalledWith('session:list');
    expect(H.invoke).toHaveBeenCalledWith('session:delete', 'hash1');
    expect(H.invoke).toHaveBeenCalledWith('session:clear');
    expect(H.invoke).toHaveBeenCalledWith('session:stats');
    expect(H.invoke).toHaveBeenCalledWith('collections:list');
    expect(H.invoke).toHaveBeenCalledWith('collections:save', { name: 'C', docHashes: ['h1'] });
    expect(H.invoke).toHaveBeenCalledWith('collections:delete', 'cid');
    expect(H.invoke).toHaveBeenCalledWith('collections:touch', 'cid');
  });

  it('invoke 반환값을 그대로 passthrough', () => {
    const a = getApi();
    const sentinel = Promise.resolve({ installed: true });
    H.invoke.mockReturnValueOnce(sentinel);
    expect(a.ollama.getStatus()).toBe(sentinel);
  });
});

describe('openExternal — https 가드', () => {
  it('https:// URL → shell:open-external invoke 위임', () => {
    const a = getApi();
    const ret = Promise.resolve();
    H.invoke.mockReturnValueOnce(ret);
    const result = a.openExternal('https://ollama.com');
    expect(H.invoke).toHaveBeenCalledWith('shell:open-external', 'https://ollama.com');
    expect(result).toBe(ret);
  });

  it('http:// URL → invoke 미호출 + resolve', async () => {
    const a = getApi();
    await expect(a.openExternal('http://evil.com')).resolves.toBeUndefined();
    expect(H.invoke).not.toHaveBeenCalled();
  });

  it('javascript: 스킴 → 차단', async () => {
    const a = getApi();
    await expect(a.openExternal('javascript:alert(1)')).resolves.toBeUndefined();
    expect(H.invoke).not.toHaveBeenCalled();
  });

  it('비-문자열 → 차단 (타입 가드)', async () => {
    const a = getApi();
    await expect(a.openExternal(null as unknown as string)).resolves.toBeUndefined();
    expect(H.invoke).not.toHaveBeenCalled();
  });
});

describe('getPathForFile — webUtils + fallback', () => {
  it('webUtils 경로 반환', () => {
    const a = getApi();
    H.getPathForFile.mockReturnValueOnce('/abs/path/x.pdf');
    expect(a.getPathForFile(new File([], 'x.pdf'))).toBe('/abs/path/x.pdf');
  });

  it('webUtils 가 빈 값 → 빈 문자열', () => {
    const a = getApi();
    H.getPathForFile.mockReturnValueOnce(undefined);
    expect(a.getPathForFile(new File([], 'x.pdf'))).toBe('');
  });

  it('webUtils throw → catch 로 빈 문자열', () => {
    const a = getApi();
    H.getPathForFile.mockImplementationOnce(() => { throw new Error('not a real file'); });
    expect(a.getPathForFile(new File([], 'x.pdf'))).toBe('');
  });
});

describe('on* 리스너 — 등록 / 포워딩 / 구독 해제', () => {
  it('ai.onToken: 등록 + event 제거 후 (requestId, token) 포워딩 + unsubscribe', () => {
    const a = getApi();
    const cb = vi.fn();
    const unsub = a.ai.onToken(cb);
    expect(H.on).toHaveBeenCalledWith('ai:token', expect.any(Function));
    const handler = handlerFor('ai:token');
    handler(FAKE_EVENT, 'req1', 'tok');
    expect(cb).toHaveBeenCalledWith('req1', 'tok');
    unsub();
    expect(H.removeListener).toHaveBeenCalledWith('ai:token', handler);
  });

  it('ai.onDone: (requestId) 포워딩 + unsubscribe', () => {
    const a = getApi();
    const cb = vi.fn();
    const unsub = a.ai.onDone(cb);
    const handler = handlerFor('ai:done');
    handler(FAKE_EVENT, 'req9');
    // meta 없이 온 완료(정상 완주)는 두 번째 인자가 undefined 다.
    expect(cb).toHaveBeenCalledWith('req9', undefined);
    unsub();
    expect(H.removeListener).toHaveBeenCalledWith('ai:done', handler);
  });

  /**
   * QA30(추가2): main 은 `ai:done` 에 완료 메타(StreamDoneMeta — 출력 상한 잘림 표식)를 **두 번째
   * 인자로** 실어 보내는데, 이 브리지가 그것을 버리고 requestId 만 넘겼다. 페이로드는 IPC 를
   * 건넜지만 렌더러에는 도달할 경로가 아예 없었다(A축이 붙인 신호가 여기서 끊겼다).
   */
  it('ai.onDone: 완료 메타(truncated)를 렌더러로 포워딩한다', () => {
    const a = getApi();
    const cb = vi.fn();
    a.ai.onDone(cb);
    const handler = handlerFor('ai:done');
    handler(FAKE_EVENT, 'req10', { truncated: true });
    expect(cb).toHaveBeenCalledWith('req10', { truncated: true });
  });

  it('onSetupProgress: progressEvent 객체 포워딩 + unsubscribe', () => {
    const a = getApi();
    const cb = vi.fn();
    const unsub = a.onSetupProgress(cb);
    const handler = handlerFor('setup:progress');
    const evt = { key: 'downloadingInstaller', source: 'install' as const };
    handler(FAKE_EVENT, evt);
    expect(cb).toHaveBeenCalledWith(evt);
    unsub();
    expect(H.removeListener).toHaveBeenCalledWith('setup:progress', handler);
  });

  it('onFileDropped: file 객체 포워딩 + unsubscribe', () => {
    const a = getApi();
    const cb = vi.fn();
    const unsub = a.onFileDropped(cb);
    const handler = handlerFor('file:dropped');
    const file = { path: '/a/b.pdf', name: 'b.pdf', data: new ArrayBuffer(4) };
    handler(FAKE_EVENT, file);
    expect(cb).toHaveBeenCalledWith(file);
    unsub();
    expect(H.removeListener).toHaveBeenCalledWith('file:dropped', handler);
  });
});

/**
 * QA30(C-11): preload 의 **타입 선언**이 main 의 반환 계약과 어긋나던 것.
 *
 * `collections.save` 는 main 이 `evicted`(LRU 로 축출된 컬렉션 이름)를 반환하고 CollectionBar 가
 * 소비하는데 선언에서 빠져 있었다 — collections-client.ts 가 반환 타입을 **다시 적어** 컴파일만
 * 통과시키고 있었다(형제 session.save 는 evicted/indexMissing 을 제대로 선언한다). 런타임으로는
 * 타입을 관측할 수 없으므로 선언 텍스트를 본다. 주석은 제거하고 본다 — QA29(D축)에서 소스 스캔
 * 가드가 **주석에 매칭돼 통과**한 전례가 있다.
 */
describe('QA30(C-11): preload 계약 선언에 evicted 가 포함된다', () => {
  it('collections.save / session.save 둘 다 evicted 를 선언한다', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    // 주석은 제거하고 본다 — QA29(D축)에서 소스 스캔 가드가 주석에 매칭돼 통과한 전례가 있다.
    // 즉시 감싼다 — 원본 변수를 남기면 파생 가드의 read-site 규칙이 잡는다(의도된 계약).
    const code = stripJsComments(
      await fs.readFile(path.join(here, '..', 'index.ts'), 'utf-8'),
    );
    // 같은 토큰이 구현(contextBridge 래퍼)과 타입 선언 양쪽에 나온다 — 계약을 보려면
    // `Promise<` 를 포함한 **선언 줄**을 골라야 한다(구현 줄을 보면 가드가 공허해진다).
    const lines = code.split(String.fromCharCode(10));
    const declOf = (head: string): string =>
      lines.find((l) => l.includes(head) && l.includes('Promise<')) ?? '';
    const collectionsSave = declOf('save: (input:');
    expect(collectionsSave, 'collections.save 선언을 찾지 못했다 — 가드가 공허해졌다').toContain('docHashes');
    expect(collectionsSave, 'main 이 반환하고 CollectionBar 가 쓰는 evicted 가 계약에 없다').toContain('evicted');
    // 형제 대조: session.save 는 evicted/indexMissing 을 이미 선언한다.
    const sessionSave = declOf('save: (payload: { meta: SessionSaveMeta');
    expect(sessionSave, 'session.save 선언을 찾지 못했다 — 가드가 공허해졌다').toContain('openDocHashes');
    expect(sessionSave).toContain('evicted');
    expect(sessionSave).toContain('indexMissing');
  });
});
