import { ROOM_ID_RE } from '../socket/validate.js';

export const MAX_PARTICIPANTS = 2;

/**
 * In-memory room registry. Nothing is persisted: rooms exist only while
 * someone is connected.
 *
 * rooms:      roomId   -> Map(socketId -> { name, sessionId })
 * socketRoom: socketId -> roomId
 */
export class RoomManager {
  #rooms = new Map();
  #socketRoom = new Map();

  join(roomId, socketId, { name, sessionId }) {
    if (!ROOM_ID_RE.test(roomId)) return { ok: false, code: 'INVALID_ROOM' };
    if (this.#socketRoom.has(socketId)) return { ok: false, code: 'ALREADY_IN_ROOM' };

    let room = this.#rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.#rooms.set(roomId, room);
    }

    // A browser that briefly lost its socket reconnects with a NEW socket id but
    // the SAME sessionId. Drop the stale entry so it does not count toward the limit.
    for (const [oldId, info] of room) {
      if (info.sessionId === sessionId) {
        room.delete(oldId);
        this.#socketRoom.delete(oldId);
      }
    }

    if (room.size >= MAX_PARTICIPANTS) return { ok: false, code: 'ROOM_FULL' };

    const peers = [...room].map(([id, info]) => ({ id, name: info.name, sessionId: info.sessionId }));
    room.set(socketId, { name, sessionId });
    this.#socketRoom.set(socketId, roomId);
    return { ok: true, peers };
  }

  /** Remove a socket from its room. Returns { roomId, remaining: [socketId] } or null. */
  leave(socketId) {
    const roomId = this.#socketRoom.get(socketId);
    if (!roomId) return null;
    this.#socketRoom.delete(socketId);
    const room = this.#rooms.get(roomId);
    if (!room) return { roomId, remaining: [] };
    room.delete(socketId);
    const remaining = [...room.keys()];
    if (room.size === 0) this.#rooms.delete(roomId);
    return { roomId, remaining };
  }

  getRoomOf(socketId) {
    return this.#socketRoom.get(socketId) ?? null;
  }

  areInSameRoom(a, b) {
    const ra = this.#socketRoom.get(a);
    return ra !== undefined && ra === this.#socketRoom.get(b) && a !== b;
  }

  get roomCount() {
    return this.#rooms.size;
  }
}
