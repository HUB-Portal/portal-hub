import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
  // Never inline assets as data: URIs, so the strict CSP for fonts and scripts stays simple.
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
});
