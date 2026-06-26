import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// v0.18.8 R27-M2: 빌드 옵션 명시. Vite/electron-vite major bump 시 sourcemap 이 asar 에
// 누설되어 sanitizeErrorPath 로 막은 경로가 다시 새는 회귀를 방지. minify 도 명시 고정.
const buildOpts = {
  sourcemap: false,
  minify: 'esbuild' as const,
};

// R37 P4-4 (v0.18.23): envPrefix 빈 화이트리스트 핀.
// 본 앱은 `VITE_*` prefix 변수를 번들에 노출하는 사용처 0건. (i18n.ts 가 dev 전용 경고용으로
// Vite 빌트인 `import.meta.env.DEV` 를 캐스트 우회 접근하나, 이는 envPrefix 와 무관한 빌트인이라
// prod 빌드에서 정적 치환·트리셰이킹으로 제거됨 — VITE_* 사용자 변수 인라인과 다른 표면.)
// Vite 기본 envPrefix 가 `'VITE_'` 라 향후 누군가가 빌드 머신/dev 환경의 VITE_* 변수를 정의해도
// renderer 번들에 inline 되지 않도록 빈 배열로 명시 차단. 보안적으로는 sourcemap 비노출
// (buildOpts.sourcemap=false) 과 함께 "renderer 가 ambient env 를 의도치 않게 흡수하는 표면" 을 0 으로 만든다.
// 향후 의도적으로 env 가 필요해지면 명시 prefix(예: `LPA_PUBLIC_`)를 추가하고 README 에 노출 정책 기록.
const envPrefix: string[] = [];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: buildOpts,
    envPrefix,
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: buildOpts,
    envPrefix,
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    envPrefix,
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
            // react/jsx-runtime·scheduler 를 명시하지 않으면 첫 importer(react-markdown)로
            // React 코어가 호이스팅돼 markdown 청크에 갇히고 react-vendor 분리가 무력화된다.
            // 명시 지정으로 React 를 vendor 로 고정(앱 코드 변경 시 vendor 캐시 유지).
            'react-vendor': ['react', 'react-dom', 'react/jsx-runtime', 'scheduler'],
            'pdfjs': ['pdfjs-dist'],
            'markdown': ['react-markdown', 'remark-gfm'],
          },
        },
      },
    },
  },
});
