import { io } from 'socket.io-client';

/**
 * Socket.IO is used for signaling and call lifecycle only. Media never goes through it.
 * serverUrl '' = same origin (Vite proxies to the server in development).
 */
export function createSocket(serverUrl = '') {
  return io(serverUrl || undefined, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelayMax: 5000,
  });
}
