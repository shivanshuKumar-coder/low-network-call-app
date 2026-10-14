import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { RoomManager } from './rooms/roomManager.js';
import { registerSignaling } from './socket/signaling.js';
import { buildIceServers } from './iceServers.js';

const PORT = Number(process.env.PORT) || 4000;
const origins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (origins.includes('*') && process.env.NODE_ENV === 'production') {
  console.warn('[warn] CLIENT_ORIGIN=* is not safe in production.');
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: origins }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/api/ice-servers', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers: buildIceServers() });
});

// Optional: serve the built client from the same server (single-origin deployment).
if (process.env.SERVE_CLIENT === 'true') {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  } else {
    console.warn('[warn] SERVE_CLIENT=true but client/dist does not exist. Run "npm run build" first.');
  }
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: origins },
  maxHttpBufferSize: 200_000, // SDP is small; reject anything large
});

const rooms = new RoomManager();
registerSignaling(io, rooms);

server.listen(PORT, () => {
  console.log(`Signaling server listening on :${PORT}`);
  console.log(`Allowed origins: ${origins.join(', ')}`);
});

const shutdown = () => {
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
