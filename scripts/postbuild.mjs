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

cpSync(src, dest, { recursive: true });
console.log(`[postbuild] copied cmaps: ${src} -> ${dest}`);
