import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.SERVER_PROXY_TARGET || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // reachable from other devices on your LAN
    port: 5173,
    allowedHosts: true, // lets HTTPS tunnels (cloudflared, ngrok) reach the dev server
    proxy: {
      '/socket.io': { target, ws: true },
      '/api': { target },
    },
  },
});
