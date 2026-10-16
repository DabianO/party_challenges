import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API, media and WebSocket traffic to the game server so both run
// on one origin from the browser's point of view (same as production, where the
// game server serves the built client itself).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/media': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
