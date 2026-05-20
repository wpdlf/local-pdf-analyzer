// R29 #1 (v0.18.11): postbuild 스크립트 분리.
// 이전에는 package.json 의 build 스크립트에 `node -e "require('fs').cpSync(...)"` 형태로
// 인라인 작성되어 있어서 Windows PowerShell heredoc 인용 처리가 fragile 했다.
// `node scripts/postbuild.mjs` 단일 호출로 분리해 셸 인용 표면을 제거한다.
//
// pdfjs-dist 의 cmaps 디렉터리를 renderer 빌드 산출물에 복사해야 한국어/중국어/일본어
// 등 CJK PDF 글리프가 정상적으로 표시된다. pdfjs 메이저 업그레이드 (4 → 5) 시 cmaps
// 경로가 바뀔 수 있으므로 변경 시 본 스크립트 확인 필요.

import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const src = resolve(root, 'node_modules/pdfjs-dist/cmaps');
const dest = resolve(root, 'out/renderer/cmaps');

if (!existsSync(src)) {
  console.error(`[postbuild] pdfjs-dist cmaps not found at ${src}`);
  console.error('[postbuild] pdfjs-dist 의 cmaps 경로가 바뀌었거나 의존성이 설치되지 않았습니다.');
  process.exit(1);
}

// R31 P2 (v0.18.19): cpSync 실패 시 친절한 메시지로 종료.
// 이전엔 ENOENT/EACCES/EEXIST 등이 raw stack trace 로 노출돼 빌드 실패 원인 파악이 어려웠다.
try {
  cpSync(src, dest, { recursive: true });
} catch (err) {
  console.error(`[postbuild] cmaps copy failed: ${src} -> ${dest}`);
  console.error(`[postbuild] reason: ${err instanceof Error ? err.message : String(err)}`);
  console.error('[postbuild] dest 디렉터리에 read-only 파일이 남아 있거나 권한 문제일 수 있습니다. out/ 을 비우고 재시도하세요.');
  process.exit(1);
}

// v0.18.19 patch R32 P3: cpSync 가 ENOSPC / 중간 실패로 부분 복사된 채 빠져나오면 NSIS 가
// 깨진 cmap 세트로 패키징되어 사용자가 설치 후에야 CJK 글리프 깨짐을 발견하는 silent
// 결함이 가능. 대표 cmap 파일 존재 확인을 smoke test 로 둠 (Surface 4 P5).
// R34 P2: Adobe-CNS1-UCS2.bcmap (번체 중국어 — 대만/홍콩 PDF) 추가.
// 부분 복사가 정확히 CNS1 만 빠뜨리는 ENOSPC edge 에서도 smoke 가 catch 하도록.
const SMOKE_FILES = ['Adobe-Japan1-UCS2.bcmap', 'Adobe-Korea1-UCS2.bcmap', 'Adobe-GB1-UCS2.bcmap', 'Adobe-CNS1-UCS2.bcmap'];
for (const name of SMOKE_FILES) {
  const probe = resolve(dest, name);
  if (!existsSync(probe)) {
    console.error(`[postbuild] cmaps smoke check FAILED: missing ${probe}`);
    console.error('[postbuild] cmaps 복사가 부분적으로 실패했을 가능성. out/ 을 비우고 재시도하세요.');
    process.exit(1);
  }
}
console.log(`[postbuild] copied cmaps: ${src} -> ${dest} (smoke check ok)`);
