import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// 자가유지 cross-side IPC 채널 계약 가드 (post-v0.24.4 QA).
//
// 기존 preload-shape.test / ipc-contract.test 는 각자 한쪽(preload | main)을 **손유지 채널
// 리스트**와 대조했다. 그래서 한쪽만 rename 하면(예: main 의 handler 를 session:clear→session:reset
// 으로 바꾸고 preload 는 그대로) 양 테스트가 green 인데 런타임에 "No handler registered for
// 'session:clear'" 로 앱이 깨졌다. 게다가 손유지 리스트가 stale 해져 ~12채널(file:open-path,
// session:list/delete/clear/stats, collections:*)이 빠져 있었다.
//
// 본 테스트는 손유지 리스트 없이 **소스에서 채널을 추출**해 두 측을 서로 대조한다:
//   request 채널:  preload ipcRenderer.invoke  ==  main ipcMain.handle
//   event   채널:  preload ipcRenderer.on      ==  main webContents.send / safeSend
// 어느 한쪽만 추가·삭제·rename 하면 즉시 실패한다. 정적 텍스트지만 손유지 항목이 없어
// 드리프트에 자가 적응한다 (preload-shape 의 surface-key/시그니처 가드, ipc-contract 의 ai:*
// 위임 가드와 상보 — 그쪽은 "이 채널이 무엇을 하는가", 본 테스트는 "양측이 일치하는가").

const MAIN_DIR = resolve(import.meta.dirname, '..'); // src/main
const PRELOAD_DIR = resolve(import.meta.dirname, '../../preload'); // src/preload

/** 디렉터리의 top-level .ts 소스를 연결 (서브디렉터리 __tests__ 는 readdir top-level 이라 자동 제외) */
function readSourceDir(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => readFileSync(resolve(dir, f), 'utf-8'))
    .join('\n');
}

const MAIN_SRC = readSourceDir(MAIN_DIR);
const PRELOAD_SRC = readSourceDir(PRELOAD_DIR);

function extract(src: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(re)) out.add(m[1]!);
  return out;
}

const invokeChannels = extract(PRELOAD_SRC, /ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g);
const handleChannels = extract(MAIN_SRC, /ipcMain\.handle\(\s*['"]([^'"]+)['"]/g);
const onChannels = extract(PRELOAD_SRC, /ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g);
// safeSend(ai-service) 는 webContents.send 래퍼라 양쪽 패턴 모두 수집. 변수 인자
// (`webContents.send(channel, …)`)는 리터럴이 아니라 매칭되지 않음 — 의도된 동작.
const sendChannels = extract(MAIN_SRC, /(?:webContents\.send|safeSend)\(\s*['"]([^'"]+)['"]/g);

// QA17(D-LOW): renderer→main 단방향 채널(ipcRenderer.send ↔ ipcMain.on). 위 invoke/handle·
// on/send 두 방향은 잡았으나 이 카테고리(현재 'app:flush-done' 종료 flush ack)는 가드 밖이었다.
// 편측 rename 시 두 테스트 모두 green 인데 런타임에 ack 가 영영 안 와 매 창닫기·종료마다
// FLUSH_BEFORE_QUIT_TIMEOUT_MS(2s) 하드 타임아웃까지 대기하는 조용한 UX 회귀가 났다.
const rendererSendChannels = extract(PRELOAD_SRC, /ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g);
const mainOnChannels = extract(MAIN_SRC, /ipcMain\.on\(\s*['"]([^'"]+)['"]/g);

// 의도적 비대칭이 생기면 여기에 명시(현재 없음). 예: 외부/테스트가 직접 호출하는 핸들러,
// 아직 renderer 가 구독하지 않는 신규 emit 등. 비워두면 완전 set-equality 를 강제한다.
const HANDLER_WITHOUT_INVOKE = new Set<string>();
const SEND_WITHOUT_LISTENER = new Set<string>();

const diff = (a: Set<string>, b: Set<string>): string[] => [...a].filter((x) => !b.has(x)).sort();

describe('IPC 채널 cross-side 계약 (자가유지)', () => {
  it('채널 추출이 비어있지 않다 — 정규식/경로 회귀 가드', () => {
    // 추출이 0건이면(파일 경로 변경·정규식 깨짐) 아래 ⊆ 단언이 공허하게 통과하므로 선행 가드.
    expect(invokeChannels.size).toBeGreaterThan(20);
    expect(handleChannels.size).toBeGreaterThan(20);
    expect(onChannels.size).toBeGreaterThanOrEqual(4);
    expect(sendChannels.size).toBeGreaterThanOrEqual(4);
    expect(rendererSendChannels.size).toBeGreaterThanOrEqual(1);
    expect(mainOnChannels.size).toBeGreaterThanOrEqual(1);
  });

  it('preload invoke ⊆ main handle — 모든 renderer 호출에 핸들러 존재', () => {
    const orphans = diff(invokeChannels, handleChannels);
    expect(orphans, `핸들러 없는 invoke 채널 (런타임 "No handler registered" 위험): ${orphans.join(', ')}`).toEqual([]);
  });

  it('main handle ⊆ preload invoke — 죽은(미사용) 핸들러 없음', () => {
    const dead = diff(handleChannels, invokeChannels).filter((c) => !HANDLER_WITHOUT_INVOKE.has(c));
    expect(dead, `preload 가 호출하지 않는 핸들러: ${dead.join(', ')}`).toEqual([]);
  });

  it('preload on ⊆ main send/safeSend — 모든 리스너에 emitter 존재', () => {
    const orphans = diff(onChannels, sendChannels);
    expect(orphans, `emitter 없는 리스너 채널: ${orphans.join(', ')}`).toEqual([]);
  });

  it('main send/safeSend ⊆ preload on — 죽은 emit 없음', () => {
    const dead = diff(sendChannels, onChannels).filter((c) => !SEND_WITHOUT_LISTENER.has(c));
    expect(dead, `리스너 없는 emit 채널: ${dead.join(', ')}`).toEqual([]);
  });

  it('preload ipcRenderer.send ⊆ main ipcMain.on — 모든 renderer→main emit 에 핸들러 존재', () => {
    const orphans = diff(rendererSendChannels, mainOnChannels);
    expect(orphans, `ipcMain.on 없는 ipcRenderer.send 채널(런타임 ack 유실 → 종료 flush 2s 행): ${orphans.join(', ')}`).toEqual([]);
  });

  it('main ipcMain.on ⊆ preload ipcRenderer.send — 죽은 리스너 없음', () => {
    const dead = diff(mainOnChannels, rendererSendChannels);
    expect(dead, `ipcRenderer.send 없는 ipcMain.on 채널: ${dead.join(', ')}`).toEqual([]);
  });
});
