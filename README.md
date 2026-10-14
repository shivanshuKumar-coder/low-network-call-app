# Steady Call — a low-network calling app

One-to-one audio/video calls in the browser (WebRTC) built to **stay usable on weak, unstable or high-latency
connections**. When the network gets worse, it protects the conversation first: it lowers video quality, then turns
video off, explains what happened, and recovers gradually.

> **Honest limits.** No app can guarantee zero lag. WebRTC cannot work with no internet, cannot fix congestion outside
> your control, and cannot beat device limits. The goal is *graceful degradation*. This is a **prototype**: do not
> call it production-ready until you have configured a real TURN server and tested across real networks.

## Stack

| Layer | Tech |
|---|---|
| Client | React + Vite, JavaScript, plain CSS, WebRTC, Socket.IO client |
| Server | Node.js, Express, Socket.IO (signaling only) |
| Connectivity | STUN + TURN (served to the browser by the server) |

No database. Rooms live in memory only and disappear when empty. Media, SDP and ICE data are never stored or logged.

## Quick start (local)

Requires Node.js 18+.

```bash
# 1. Install
npm run install:all        # or: npm install --prefix server && npm install --prefix client

# 2. Configure the server
cp server/.env.example server/.env

# 3. Run (two terminals)
npm run dev:server         # http://localhost:4000
npm run dev:client         # http://localhost:5173
```

Open <http://localhost:5173> in two browser windows (or two devices), create a call in one, and open the invite link in
the other. Camera/mic access works on `localhost` without HTTPS.

Run the tests with `npm test` (server validation/rooms/ICE config, plus the stats and adaptation logic).

### Testing on a phone or another network

Browsers only allow camera/mic on **HTTPS** (or localhost). Easiest: expose the Vite dev server through an HTTPS tunnel
(e.g. `cloudflared tunnel --url http://localhost:5173` or `ngrok http 5173`). Vite proxies `/socket.io` and `/api` to the
server, so one tunnel is enough. Then add the tunnel origin to `CLIENT_ORIGIN` in `server/.env` (comma-separated) and
restart the server.

## Environment variables

**`server/.env`** (see `server/.env.example`)

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 4000) |
| `CLIENT_ORIGIN` | Comma-separated allowed frontend origins (CORS for HTTP and Socket.IO). Never `*` in production |
| `SERVE_CLIENT` | `true` to serve `client/dist` from the server (single-origin deploy) |
| `STUN_URLS` | Comma-separated STUN URLs |
| `TURN_URLS` | Comma-separated TURN URLs (UDP, TCP and `turns:` variants) |
| `TURN_SHARED_SECRET`, `TURN_CREDENTIAL_TTL_SECONDS` | coturn `use-auth-secret` mode: the server mints short-lived credentials |
| `TURN_USERNAME`, `TURN_CREDENTIAL` | Static credentials from a managed TURN provider |

**`client/.env`** (see `client/.env.example`): `VITE_SERVER_URL` is empty in development (same-origin via proxy). Set it
only if the client and server are on different origins.

TURN credentials are held **server-side** and handed out through `GET /api/ice-servers`, so they never appear in the
frontend bundle or source control. Never commit `.env`.

## STUN and TURN — required reading before production

* **STUN** only helps browsers discover a route. It relays nothing.
* **TURN** relays media when a direct path is impossible (symmetric NATs, corporate firewalls, many mobile carriers).
  Without it, a real share of calls will fail. The default public Google STUN server is fine for development only.
* **Do not use a public demo TURN server in production.**

Setting up TURN, two options:

1. **Managed provider** (Twilio Network Traversal, Cloudflare, Metered, etc.): put their URLs in `TURN_URLS` and the
   credentials in `TURN_USERNAME` / `TURN_CREDENTIAL`. Prefer a provider API that issues short-lived credentials.
2. **Self-hosted coturn**: enable `use-auth-secret` with `static-auth-secret=<secret>` and a `realm`, open UDP/TCP 3478
   and a relay port range (and TLS on 5349 for `turns:`), then set `TURN_URLS`, `TURN_SHARED_SECRET`.
   Include `?transport=udp`, `?transport=tcp` and `turns:` URLs so restrictive networks can still connect.

**Verify TURN:** in the call screen open *Details*; the *Route* row shows `Relayed (TURN)` when relay is in use. To force
it for testing, use Chrome's `chrome://webrtc-internals` or temporarily set `iceTransportPolicy: 'relay'` in
`client/src/services/webrtc.js`.

## How it works

```
Browser A ──Socket.IO (signaling only)── Server ──Socket.IO── Browser B
    └────────── WebRTC media (direct, or via TURN relay) ──────────┘
```

* The server creates/joins rooms (max **2** people), relays SDP offers/answers and ICE candidates **only to the other
  person in the same room**, validates every payload's shape and size, rate-limits each socket, and announces
  hang-up/disconnect.
* The client uses the "perfect negotiation" pattern, so simultaneous offers and ICE restarts from either side resolve
  cleanly. After a brief signaling drop, the live media path is kept for up to 20 seconds.
* On connection failure it attempts up to **3 ICE restarts** (with backoff), then shows a *Try to reconnect* button.

### Weak-network adaptation (`client/src/services/networkManager.js`)

Every 2 seconds the monitor reads `getStats()` and computes RTT, jitter, packet loss (from **counter deltas** over the
interval, not lifetime totals), outgoing video bitrate/resolution/fps and whether the route is relayed. Missing fields are
treated as "no data", never as an error.

Severity is the *worst* of loss / RTT / jitter against conservative starting thresholds (`THRESHOLDS`, tune these):

| Tier | Trigger (sustained) | Video ceiling |
|---|---|---|
| 0 Full | good | 1 Mbps, 30 fps |
| 1 Reduced | fair | 500 kbps, 20 fps |
| 2 Low | poor | 200 kbps, 12 fps, half resolution |
| 3 Audio only | very poor | video off |

* **Hysteresis:** worse for 3 samples (~6 s) → one tier down; better for 10 samples (~20 s) → one tier up; leaving
  audio-only needs ~30 s. One tier at a time, so it never flaps.
* These are *ceilings* set with `RTCRtpSender.setParameters()`; the browser's own congestion control still adapts beneath
  them. No peer connection is rebuilt. Audio is given higher sender priority than video.
* **Camera policy:** the app never turns your camera back on by itself. After an automatic switch to audio-only it shows
  *"Connection looks stable again. Turn my video on"*, and resuming restarts at the Low tier. Turning video off releases the
  camera hardware (the camera light goes out).
* **Audio only / Low data** is a manual toggle at any time. It also asks the other person's app to pause their video, so
  it saves *your* downlink data too. The automatic switch to audio-only can be disabled with the checkbox under the controls.
* The mic stays live whenever you have not muted it, including with video off. Mic/camera state is always visible.

## Security and privacy

* Camera/mic are requested only after you press **Allow access and join**.
* Nothing is recorded. No media, SDP or ICE data is stored; SDP/ICE is never logged.
* Room IDs are random (~60 bits), but **a room ID alone is not authentication.** Before exposing private calls publicly,
  add real authentication or short-lived signed invitations (e.g. JWT-signed room tokens verified in `join-room`).
* Restrict `CLIENT_ORIGIN` to your real origins and serve everything over HTTPS/WSS.

## Project layout

```
server/src/index.js              Express + Socket.IO bootstrap, /api/ice-servers
server/src/socket/signaling.js   join, relay, hang-up, rate limiting
server/src/socket/validate.js    payload validation
server/src/rooms/roomManager.js  in-memory rooms (max 2)
client/src/services/webrtc.js    CallSession: media, negotiation, ICE restart, adaptation wiring
client/src/services/networkManager.js  stats → severity → tier (pure logic, unit-tested)
client/src/hooks/                useCall, useNetworkQuality
client/src/components/, pages/   UI
```

## Known limitations and manual testing still needed

* One-to-one only (no group calls, no SFU).
* Thresholds are initial heuristics; tune them against real traffic. Simulate trouble with Chrome DevTools network
  throttling, or `tc netem` / Network Link Conditioner (bandwidth caps, 5–20% loss, high latency, jitter).
* Automated tests cover the pure logic only. Real calls need manual testing across: two devices, different networks,
  Wi-Fi ↔ mobile switching, TURN relay (UDP/TCP/TLS), permission denial, no camera/mic, unplugging devices, refresh,
  simultaneous joins, and Safari/iOS.
* Audio-only recovery detection is inherently optimistic: with video off the connection looks better than it would
  with video on, which is why resuming video starts at the Low tier and steps up.
* `RTCRtpSender.setParameters()` support for some fields varies by browser; unsupported fields are skipped safely.
* Closing a tab looks like a network drop to the other person; they see "disconnected" after a ~20 s grace period.
# low-network-call-app
