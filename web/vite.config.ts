import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig(({ mode }) => {
  // KPH_API_PORT (web/.env.local) points the dev proxy at an API that runs on another port, for example next to a second checkout.
  const apiPort = loadEnv(mode, __dirname, 'KPH_').KPH_API_PORT || '4000';
  return {
  plugins: [react()],
  resolve: { alias: { '@shared': path.resolve(__dirname, '../shared') } },
  server: { port: 5173, proxy: { '/api': `http://localhost:${apiPort}` } },
  // Never inline assets as data: URIs, so the strict CSP for fonts and scripts stays simple.
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
  };
});
