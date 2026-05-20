import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// v0.18.8 R27-M2: 빌드 옵션 명시. Vite/electron-vite major bump 시 sourcemap 이 asar 에
// 누설되어 sanitizeErrorPath 로 막은 경로가 다시 새는 회귀를 방지. minify 도 명시 고정.
const buildOpts = {
  sourcemap: false,
  minify: 'esbuild' as const,
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: buildOpts,
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: buildOpts,
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      ...buildOpts,
      // R29 (v0.18.15) 코드-스플리팅: 800KB+ 단일 chunk 였던 renderer 번들을
      // 영역별 vendor chunk 로 분리.
      //  - react / react-dom 분리: 앱 코드 변경 시에도 vendor cache 유지
      //  - pdfjs-dist 분리: 가장 무거운 의존성, 첫 PDF 업로드 직전까지는 main chunk
      //    에서 빠져 있어 cold start JS parse 시간 단축
      //  - markdown 관련 분리: 요약/Q&A 첫 응답 직전까지 main chunk 부담 제거
      // Electron file:// 환경이므로 네트워크 병렬 효과는 작지만, 캐시 무효화/JS parse
      // 병렬화/HMR 부분 무효화 효과가 있어 cold start 와 reload 모두 체감 개선.
      rollupOptions: {
        output: {
          // v0.18.19 patch R32 P3: pdf.worker.min.mjs 는 `pdfjs-dist/build/pdf.worker.min.mjs?url`
          // import 로 별도 정적 자산으로 emit 되어(`assets/pdf.worker.min-*.mjs`, ~1.3MB)
          // 본 manualChunks 와 무관하게 lazy-loaded. 'pdfjs' 청크는 메인 thread 측 pdfjs API
          // 만 담는다. 이 비대칭은 의도된 것 — worker 파일은 Worker constructor 가 URL 로 받음.
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'pdfjs': ['pdfjs-dist'],
            'markdown': ['react-markdown', 'remark-gfm'],
          },
        },
      },
    },
  },
});
