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
    build: buildOpts,
  },
});
