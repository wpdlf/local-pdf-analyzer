/**
 * 인스톨러 파일 **관측** — 판정은 update-policy.isInstallerUsable 이 한다.
 *
 * QA28 실기기 검증(2026-08-27): `existsSync` 만으로는 **0바이트 인스톨러**가 가드를 통과해
 * 앱이 조용히 꺼졌다. 해시 재계산(105MB)은 사전 검사로 과하므로 크기·선두 매직만 본다.
 * 어떤 이유로든 읽지 못하면 `exists:false` — 판정을 거부 쪽으로 착지시킨다.
 *
 * QA29(D-1): 이 함수는 v1.2.3 핫픽스의 **절반**인데 index.ts 안에 있어 export 조차 되지 않았고,
 * 유일한 참조는 window-lifecycle.test 의 소스 스캔(`statSync(` · `readSync(` · `size: st.size`
 * 토큰 존재 확인)이었다. 그 가드는 공허하다 — `readSync(...) === 2` 를 `readSync(...) >= 0` 으로
 * 바꾸고 매직을 `'MZ'` 로 상수화해도 토큰이 전부 남아 스위트가 그대로 초록이었다. 그 돌연변이는
 * "백신이 인스톨러를 텍스트 스텁으로 갈아치운" 경우를 다시 열어준다.
 * → 관측을 순수 결정(update-policy)과 같은 방식으로 **주입 가능하게** 분리해 행위 테스트를 건다.
 * index.ts 는 배선만 유지하고, 그 배선은 window-lifecycle 의 소스 스캔이 계속 고정한다.
 */

import { statSync as nodeStatSync, openSync as nodeOpenSync, readSync as nodeReadSync, closeSync as nodeCloseSync } from 'fs';
import type { InstallerProbe } from './update-policy';

/**
 * probeInstaller 가 실제로 쓰는 fs 표면(테스트 주입용). node:fs 의 시그니처 부분집합이다.
 * 디렉터리·권한 오류 등 관측 실패는 전부 throw 로 도달하고, 그 처리는 probeInstaller 가 한다.
 */
export interface ProbeFsLike {
  statSync(filePath: string): { isFile(): boolean; size: number };
  openSync(filePath: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}

const nodeProbeFs: ProbeFsLike = {
  statSync: nodeStatSync,
  openSync: nodeOpenSync,
  readSync: nodeReadSync,
  closeSync: nodeCloseSync,
};

/** 선두에서 읽는 바이트 수(PE 매직 `MZ`). */
const MAGIC_BYTES = 2;

export function probeInstaller(filePath: string, io: ProbeFsLike = nodeProbeFs): InstallerProbe {
  try {
    const st = io.statSync(filePath);
    // 디렉터리를 인스톨러 자리에 만들어 둔 경우(설치 도구·백신의 흔한 잔해) size 는 0 이 아니므로
    // 크기 하한만으로는 걸러지지 않는다. 파일이 아니면 여기서 거부한다.
    if (!st.isFile()) return { exists: false, size: 0, magic: '' };
    let magic = '';
    const fd = io.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(MAGIC_BYTES);
      // **정확히** 2바이트를 읽었을 때만 매직으로 인정한다. `>= 0` 같은 완화는 0/1바이트 파일에
      // 대해 잔여 0 바이트를 매직으로 착각하게 만든다(QA29 D-1 의 돌연변이).
      magic = io.readSync(fd, buf, 0, MAGIC_BYTES, 0) === MAGIC_BYTES ? buf.toString('latin1') : '';
    } finally {
      io.closeSync(fd);
    }
    return { exists: true, size: st.size, magic };
  } catch {
    return { exists: false, size: 0, magic: '' };
  }
}
