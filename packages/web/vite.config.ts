import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API, media and WebSocket traffic to the game server so both run
// on one origin from the browser's point of view (same as production, where the
// game server serves the built client itself).
// `xfwd` is required: it tells the game server which device a request really came from,
// so only the host machine itself can list stored games (`/api/local/games`).
// API_PORT points the proxy at a game server on another port (default 3000).
const apiPort = Number(process.env.API_PORT ?? 3000);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true, xfwd: true },
      '/media': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
