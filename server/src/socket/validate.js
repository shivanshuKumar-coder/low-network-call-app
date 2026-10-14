// Strict validation for everything clients send. Payloads are rebuilt field by
// field so unexpected properties never get relayed to the other participant.

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const SESSION_RE = /^[A-Za-z0-9-]{8,64}$/;
const SDP_TYPES = new Set(['offer', 'answer', 'pranswer', 'rollback']);
const MAX_SDP_LENGTH = 100_000;

export function validateJoin(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const { roomId, name, sessionId } = payload;
  if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) return null;
  if (typeof sessionId !== 'string' || !SESSION_RE.test(sessionId)) return null;
  if (typeof name !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  if (!clean) return null;
  return { roomId, name: clean, sessionId };
}

export function validateTarget(to) {
  return typeof to === 'string' && to.length > 0 && to.length <= 64;
}

export function validateSignalData(data) {
  if (!data || typeof data !== 'object') return null;

  if (data.type === 'description') {
    const d = data.description;
    if (!d || typeof d !== 'object' || !SDP_TYPES.has(d.type)) return null;
    const sdp = d.sdp ?? '';
    if (typeof sdp !== 'string' || sdp.length > MAX_SDP_LENGTH) return null;
    if (d.type !== 'rollback' && sdp.length === 0) return null;
    return { type: 'description', description: { type: d.type, sdp } };
  }

  if (data.type === 'candidate') {
    const c = data.candidate;
    if (!c || typeof c !== 'object') return null;
    if (typeof c.candidate !== 'string' || c.candidate.length > 2000) return null;
    const out = {
      candidate: c.candidate,
      sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 64) : null,
      sdpMLineIndex:
        Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64
          ? c.sdpMLineIndex
          : null,
    };
    if (typeof c.usernameFragment === 'string') out.usernameFragment = c.usernameFragment.slice(0, 64);
    return { type: 'candidate', candidate: out };
  }

  return null;
}

// Small app-level events (not media): "my video is on/off", "I'm in low-data mode".
export function validatePeerEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if ((event.type === 'video-state' || event.type === 'low-data') && typeof event.value === 'boolean') {
    return { type: event.type, value: event.value };
  }
  return null;
}
