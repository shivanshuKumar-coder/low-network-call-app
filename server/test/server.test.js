import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager } from '../src/rooms/roomManager.js';
import { validateJoin, validateSignalData, validatePeerEvent } from '../src/socket/validate.js';
import { buildIceServers } from '../src/iceServers.js';

const user = (n, s = `session-${n}-aaaa`) => ({ name: n, sessionId: s });

test('rooms: limit of two participants', () => {
  const rm = new RoomManager();
  assert.equal(rm.join('room-1234', 'a', user('A')).ok, true);
  const b = rm.join('room-1234', 'b', user('B'));
  assert.equal(b.ok, true);
  assert.equal(b.peers.length, 1);
  const c = rm.join('room-1234', 'c', user('C'));
  assert.deepEqual([c.ok, c.code], [false, 'ROOM_FULL']);
});

test('rooms: same-room checks and cleanup', () => {
  const rm = new RoomManager();
  rm.join('room-1234', 'a', user('A'));
  rm.join('room-1234', 'b', user('B'));
  rm.join('other-room', 'x', user('X'));
  assert.equal(rm.areInSameRoom('a', 'b'), true);
  assert.equal(rm.areInSameRoom('a', 'x'), false);
  assert.equal(rm.areInSameRoom('a', 'a'), false);
  assert.deepEqual(rm.leave('a').remaining, ['b']);
  assert.equal(rm.areInSameRoom('a', 'b'), false);
  rm.leave('b');
  rm.leave('x');
  assert.equal(rm.roomCount, 0);
  assert.equal(rm.leave('nobody'), null);
});

test('rooms: reconnecting session replaces its stale socket instead of filling the room', () => {
  const rm = new RoomManager();
  rm.join('room-1234', 'a-old', user('A', 'session-A-aaaa'));
  rm.join('room-1234', 'b', user('B'));
  const again = rm.join('room-1234', 'a-new', user('A', 'session-A-aaaa'));
  assert.equal(again.ok, true);
  assert.deepEqual(again.peers.map((p) => p.id), ['b']);
  assert.equal(rm.leave('a-old'), null); // stale socket is already gone
});

test('rooms: rejects invalid room ids and double joins', () => {
  const rm = new RoomManager();
  assert.equal(rm.join('x', 'a', user('A')).code, 'INVALID_ROOM');
  rm.join('room-1234', 'a', user('A'));
  assert.equal(rm.join('room-5678', 'a', user('A')).code, 'ALREADY_IN_ROOM');
});

test('validate: join payload', () => {
  assert.deepEqual(validateJoin({ roomId: 'room-1234', name: '  Sam\n ', sessionId: 'abcdefgh-1' }), {
    roomId: 'room-1234',
    name: 'Sam',
    sessionId: 'abcdefgh-1',
  });
  assert.equal(validateJoin({ roomId: 'bad room!', name: 'Sam', sessionId: 'abcdefgh-1' }), null);
  assert.equal(validateJoin({ roomId: 'room-1234', name: '   ', sessionId: 'abcdefgh-1' }), null);
  assert.equal(validateJoin(null), null);
});

test('validate: signal payloads are rebuilt and bounded', () => {
  const ok = validateSignalData({ type: 'description', description: { type: 'offer', sdp: 'v=0', evil: 1 } });
  assert.deepEqual(ok, { type: 'description', description: { type: 'offer', sdp: 'v=0' } });
  assert.equal(validateSignalData({ type: 'description', description: { type: 'offer', sdp: 'x'.repeat(100_001) } }), null);
  assert.equal(validateSignalData({ type: 'description', description: { type: 'hax', sdp: 'v=0' } }), null);
  const c = validateSignalData({ type: 'candidate', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0, extra: 1 } });
  assert.deepEqual(c.candidate, { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 });
  assert.equal(validateSignalData({ type: 'unknown' }), null);
});

test('validate: peer events are whitelisted', () => {
  assert.deepEqual(validatePeerEvent({ type: 'low-data', value: true }), { type: 'low-data', value: true });
  assert.equal(validatePeerEvent({ type: 'low-data', value: 'yes' }), null);
  assert.equal(validatePeerEvent({ type: 'eval', value: true }), null);
});

test('ice: shared secret yields time-limited credentials; no creds disables TURN', () => {
  const s = buildIceServers({ STUN_URLS: 'stun:s:3478', TURN_URLS: 'turn:t:3478', TURN_SHARED_SECRET: 'shh' });
  assert.equal(s.length, 2);
  assert.match(s[1].username, /^\d+:lnc$/);
  assert.ok(s[1].credential && s[1].credential !== 'shh');
  assert.equal(buildIceServers({ STUN_URLS: '', TURN_URLS: 'turn:t:3478' }).length, 0);
});
