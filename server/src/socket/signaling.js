import { validateJoin, validateSignalData, validatePeerEvent, validateTarget } from './validate.js';

// Simple per-socket limiter: at most MAX_EVENTS events per WINDOW_MS.
const WINDOW_MS = 10_000;
const MAX_EVENTS = 400; // ICE trickling is bursty; this is generous but bounded.

function makeLimiter() {
  let windowStart = Date.now();
  let count = 0;
  return () => {
    const now = Date.now();
    if (now - windowStart > WINDOW_MS) {
      windowStart = now;
      count = 0;
    }
    return ++count <= MAX_EVENTS;
  };
}

const short = (id) => String(id).slice(0, 4) + '…';

/**
 * Socket.IO is used ONLY for signaling and call lifecycle. Media never touches
 * this server. SDP/ICE payloads are relayed but never logged.
 */
export function registerSignaling(io, rooms) {
  io.on('connection', (socket) => {
    const allow = makeLimiter();
    socket.use((_packet, next) => (allow() ? next() : next(new Error('RATE_LIMITED'))));

    socket.on('join-room', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const valid = validateJoin(payload);
      if (!valid) return reply({ ok: false, code: 'INVALID_PAYLOAD' });

      const result = rooms.join(valid.roomId, socket.id, valid);
      if (!result.ok) return reply({ ok: false, code: result.code });

      socket.join(valid.roomId);
      socket.to(valid.roomId).emit('peer-joined', {
        id: socket.id,
        name: valid.name,
        sessionId: valid.sessionId,
      });
      console.log(`[join] room=${short(valid.roomId)} size=${result.peers.length + 1}`);
      reply({ ok: true, selfId: socket.id, peers: result.peers });
    });

    // Relay SDP / ICE to ONE intended peer, and only if both are in the same room.
    socket.on('signal', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const { to, data } = payload;
      if (!validateTarget(to) || !rooms.areInSameRoom(socket.id, to)) return;
      const clean = validateSignalData(data);
      if (!clean) return;
      io.to(to).emit('signal', { from: socket.id, data: clean });
    });

    socket.on('peer-event', (payload) => {
      if (!payload || typeof payload !== 'object') return;
      const { to, event } = payload;
      if (!validateTarget(to) || !rooms.areInSameRoom(socket.id, to)) return;
      const clean = validatePeerEvent(event);
      if (!clean) return;
      io.to(to).emit('peer-event', { from: socket.id, event: clean });
    });

    const leave = (reason) => {
      const left = rooms.leave(socket.id);
      if (!left) return;
      socket.leave(left.roomId);
      for (const id of left.remaining) io.to(id).emit('peer-left', { id: socket.id, reason });
      console.log(`[leave] room=${short(left.roomId)} reason=${reason}`);
    };

    socket.on('hang-up', () => leave('hangup'));
    socket.on('disconnect', () => leave('disconnect'));
  });
}
