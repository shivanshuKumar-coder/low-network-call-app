import { createHmac } from 'node:crypto';

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Builds the ICE server list handed to browsers. Keeping this on the server means
 * TURN secrets never ship in the frontend bundle or source control.
 */
export function buildIceServers(env = process.env) {
  const servers = [];

  const stun = list(env.STUN_URLS ?? 'stun:stun.l.google.com:19302');
  if (stun.length) servers.push({ urls: stun });

  const turn = list(env.TURN_URLS);
  if (turn.length) {
    if (env.TURN_SHARED_SECRET) {
      // coturn "use-auth-secret" REST scheme: username = expiry timestamp, credential = HMAC-SHA1.
      const ttl = Number(env.TURN_CREDENTIAL_TTL_SECONDS) || 3600;
      const username = `${Math.floor(Date.now() / 1000) + ttl}:lnc`;
      const credential = createHmac('sha1', env.TURN_SHARED_SECRET).update(username).digest('base64');
      servers.push({ urls: turn, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      servers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    } else {
      console.warn('[ice] TURN_URLS is set but no credentials were provided; TURN is disabled.');
    }
  }
  return servers;
}
