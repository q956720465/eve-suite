import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 端口与后续 src-tauri/tauri.conf.json 的 devUrl 对齐（Tauri 2 开发模式约定）
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});