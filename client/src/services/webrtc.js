import {
  AUDIO_ONLY_TIER,
  AdaptationController,
  NetworkMonitor,
  PROFILES,
  severityOf,
} from './networkManager.js';

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

const MAX_ICE_RESTARTS = 3;
const PEER_GRACE_MS = 20_000; // how long we keep a live media path after the peer's signaling drops
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1, // mono is plenty for speech and saves bandwidth
};
const VIDEO_CONSTRAINTS = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: 'user',
};

export function checkSupport() {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason:
        'Camera and microphone need a secure connection. Open this app over https:// (or on localhost).',
    };
  }
  if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) {
    return { ok: false, reason: 'This browser cannot make calls. Try a recent version of Chrome, Edge, Firefox or Safari.' };
  }
  return { ok: true };
}

export async function fetchIceServers(serverUrl = '') {
  try {
    const res = await fetch(`${serverUrl}/api/ice-servers`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { iceServers } = await res.json();
    if (Array.isArray(iceServers) && iceServers.length) return iceServers;
  } catch (err) {
    console.warn('Could not load ICE servers from the server; falling back to public STUN only.', err);
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

export function describeMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow microphone access in your browser’s site settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Connect a microphone and try again.';
    case 'NotReadableError':
      return 'Your microphone is being used by another app. Close it and try again.';
    default:
      return 'We could not start your microphone. Check your device and try again.';
  }
}

/**
 * Owns one call: media, signaling, the RTCPeerConnection and adaptation.
 * React talks to it through `onChange(patch)` and the action methods.
 *
 * Negotiation follows the "perfect negotiation" pattern so that simultaneous
 * offers (glare) and ICE restarts from either side resolve cleanly. The person who
 * joined second is "polite" and yields on collision.
 */
export class CallSession {
  constructor({ socket, roomId, name, iceServers, onChange }) {
    this.socket = socket;
    this.roomId = roomId;
    this.name = name;
    this.iceServers = iceServers;
    this.onChange = onChange;

    this.sessionId = crypto.randomUUID();
    this.destroyed = false;
    this.joined = false;
    this.phase = 'idle';
    this.noticeId = 0;

    this.localStream = null;
    this.audioTrack = null;
    this.videoTrack = null;
    this.videoPauseReason = null; // null | 'user' | 'low-data' | 'peer-low-data' | 'auto-poor-network' | 'no-camera'
    this.lowData = false;
    this.peerLowData = false;
    this.autoAudioOnly = true;

    this.remote = null; // { id, name, sessionId }
    this.remoteStream = null;
    this.pc = null;
    this.audioSender = null;
    this.videoSender = null;
    this.polite = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.signalQueue = Promise.resolve();

    this.restartCount = 0;
    this.restartTimer = null;
    this.graceTimer = null;
    this.monitor = null;
    this.controller = new AdaptationController();
    this.offs = [];
  }

  // ---------- lifecycle ----------

  async start() {
    const support = checkSupport();
    if (!support.ok) return this.#emit({ phase: 'unsupported', error: support.reason });

    this.#emit({ phase: 'requesting-media', error: null });
    try {
      await this.#acquireMedia();
    } catch (err) {
      return this.#emit({ phase: 'media-error', error: describeMediaError(err) });
    }
    if (this.destroyed) return this.#stopTracks();

    this.#bindSocket();
    this.#emit({ phase: 'joining' });
    this.socket.connect();
  }

  hangUp() {
    if (this.joined && this.socket.connected) this.socket.emit('hang-up');
    this.joined = false; // already told the server; destroy() must not repeat it
    this.#finish('You ended the call.');
  }

  /** Idempotent. Releases tracks, the peer connection, timers, listeners and the socket. */
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.joined && this.socket.connected) this.socket.emit('hang-up');
    clearTimeout(this.restartTimer);
    clearTimeout(this.graceTimer);
    this.offs.forEach((off) => off());
    this.offs = [];
    this.#closePeerConnection();
    this.#stopTracks();
    this.socket.disconnect();
  }

  #finish(reason) {
    this.#emit({ phase: 'ended', endReason: reason });
    this.destroy();
  }

  // ---------- local media ----------

  async #acquireMedia() {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });
    } catch (firstErr) {
      // Camera missing/blocked? A call with audio only is still a call.
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
        this.videoPauseReason = 'no-camera';
      } catch {
        throw firstErr;
      }
    }
    this.audioTrack = stream.getAudioTracks()[0] ?? null;
    this.videoTrack = stream.getVideoTracks()[0] ?? null;
    if (!this.audioTrack) throw Object.assign(new Error('no audio'), { name: 'NotFoundError' });
    this.audioTrack.onended = () => this.#recoverMicrophone();
    if (this.videoTrack) this.videoTrack.onended = () => this.#onVideoEnded();
    this.#refreshLocalStream();
    this.#emit({
      micOn: true,
      videoOn: !!this.videoTrack,
      videoPauseReason: this.videoPauseReason,
      notice: this.videoPauseReason === 'no-camera' ? this.#notice('No camera available. Joining with audio only.') : undefined,
    });
  }

  async #recoverMicrophone() {
    if (this.destroyed) return;
    const wasMuted = this.audioTrack ? !this.audioTrack.enabled : false;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      const track = s.getAudioTracks()[0];
      track.enabled = !wasMuted;
      track.onended = () => this.#recoverMicrophone();
      await this.audioSender?.replaceTrack(track);
      this.audioTrack = track;
      this.#refreshLocalStream();
      this.#emit({ notice: this.#notice('Your microphone changed. Switched to the available one.') });
    } catch {
      this.#emit({ notice: this.#notice('Your microphone was disconnected and no replacement was found.') });
    }
  }

  #onVideoEnded() {
    // Camera unplugged or taken by another app.
    if (!this.videoTrack || this.videoTrack.readyState !== 'ended') return;
    this.videoTrack = null;
    this.videoPauseReason = 'no-camera';
    this.videoSender?.replaceTrack(null).catch(() => {});
    this.#refreshLocalStream();
    this.#emit({ videoOn: false, videoPauseReason: 'no-camera', notice: this.#notice('Your camera stopped. Continuing with audio.') });
    this.#sendEvent({ type: 'video-state', value: false });
  }

  #refreshLocalStream() {
    // A fresh MediaStream object makes <video> elements pick up added/removed tracks reliably.
    const tracks = [this.audioTrack, this.videoTrack].filter(Boolean);
    this.localStream = new MediaStream(tracks);
    this.#emit({ localStream: this.localStream });
  }

  #stopTracks() {
    this.audioTrack?.stop();
    this.videoTrack?.stop();
    this.localStream?.getTracks().forEach((t) => t.stop());
  }

  // ---------- user actions ----------

  toggleMic() {
    if (!this.audioTrack) return;
    this.audioTrack.enabled = !this.audioTrack.enabled;
    this.#emit({ micOn: this.audioTrack.enabled });
  }

  async toggleCamera() {
    if (this.videoTrack) await this.pauseVideo('user');
    else await this.resumeVideo();
  }

  /** Manual "Audio only / Low data" mode. Also asks the other person to pause video to save OUR data. */
  async setLowData(on) {
    this.lowData = on;
    this.#emit({ lowData: on });
    this.#sendEvent({ type: 'low-data', value: on });
    if (on) {
      await this.pauseVideo('low-data');
      this.#emit({ suggestAudioOnly: false });
    } else if (this.videoPauseReason === 'low-data') {
      await this.resumeVideo();
    }
  }

  setAutoAudioOnly(value) {
    this.autoAudioOnly = value;
    this.#emit({ autoAudioOnly: value });
  }

  /** Stops sending video AND releases the camera (so the camera light goes off). */
  async pauseVideo(reason) {
    if (!this.videoTrack) return;
    const track = this.videoTrack;
    this.videoTrack = null;
    this.videoPauseReason = reason;
    try {
      await this.videoSender?.replaceTrack(null);
    } catch (err) {
      console.debug('replaceTrack(null) failed', err);
    }
    track.onended = null;
    track.stop();
    this.#refreshLocalStream();
    this.#emit({ videoOn: false, videoPauseReason: reason, resumeHint: null });
    this.#sendEvent({ type: 'video-state', value: false });
  }

  /** Only ever called from a user action (button/prompt). We never re-enable the camera silently. */
  async resumeVideo() {
    if (this.videoTrack || this.destroyed) return;
    if (this.peerLowData) {
      return this.#emit({ notice: this.#notice(`${this.remote?.name ?? 'The other person'} is saving data, so video stays off for now.`) });
    }
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
      const track = s.getVideoTracks()[0];
      if (this.destroyed) return track.stop();
      track.onended = () => this.#onVideoEnded();
      this.videoTrack = track;
      this.videoPauseReason = null;
      // Come back gradually: never straight to the top tier after audio-only.
      if (this.controller.tier >= AUDIO_ONLY_TIER) {
        this.controller.reset(AUDIO_ONLY_TIER - 1);
        this.#emit({ tier: AUDIO_ONLY_TIER - 1 });
      }
      await this.videoSender?.replaceTrack(track);
      this.#refreshLocalStream();
      this.#emit({ videoOn: true, videoPauseReason: null, resumeHint: null, suggestAudioOnly: false });
      await this.#applyVideoProfile(Math.min(this.controller.tier, AUDIO_ONLY_TIER - 1));
      this.#sendEvent({ type: 'video-state', value: true });
    } catch (err) {
      this.#emit({
        notice: this.#notice(
          err?.name === 'NotAllowedError'
            ? 'Camera access is blocked. Allow it in your browser’s site settings.'
            : 'Could not start the camera. Check that no other app is using it.',
        ),
      });
    }
  }

  retryConnection() {
    this.restartCount = 0;
    if (this.pc) this.#restartIce();
    else this.#emit({ phase: 'waiting', error: null });
  }

  // ---------- socket / signaling ----------

  #bindSocket() {
    const on = (event, fn) => {
      this.socket.on(event, fn);
      this.offs.push(() => this.socket.off(event, fn));
    };
    on('connect', () => this.#join());
    on('disconnect', () => {
      if (this.destroyed) return;
      this.#emit({ notice: this.#notice('Lost contact with the call server. Reconnecting…') });
      if (!this.pc) this.#emit({ phase: 'joining' });
    });
    on('connect_error', () => {
      if (!this.destroyed && !this.joined) this.#emit({ phase: 'joining', notice: this.#notice('Still trying to reach the call server…') });
    });
    on('peer-joined', (peer) => this.#onPeerPresent(peer, false));
    on('peer-left', ({ id, reason }) => this.#onPeerLeft(id, reason));
    on('signal', ({ from, data }) => {
      if (!this.remote || from !== this.remote.id) return;
      this.signalQueue = this.signalQueue.then(() => this.#handleSignal(data)).catch((e) => console.warn('signal error', e));
    });
    on('peer-event', ({ from, event }) => this.#onPeerEvent(from, event));
  }

  #join() {
    this.socket.emit('join-room', { roomId: this.roomId, name: this.name, sessionId: this.sessionId }, (res) => {
      if (this.destroyed) return;
      if (!res?.ok) {
        if (res?.code === 'ROOM_FULL') return this.#emit({ phase: 'room-full' });
        return this.#emit({ phase: 'error', error: 'Could not join this room. Check the room ID and try again.' });
      }
      this.joined = true;
      const peer = res.peers[0];
      if (peer) this.#onPeerPresent(peer, true);
      else if (!this.pc) this.#emit({ phase: 'waiting', error: null });
    });
  }

  #signal(data) {
    if (this.remote) this.socket.emit('signal', { to: this.remote.id, data });
  }

  #sendEvent(event) {
    if (this.remote && this.socket.connected) this.socket.emit('peer-event', { to: this.remote.id, event });
  }

  #onPeerPresent(peer, weJoinedSecond) {
    clearTimeout(this.graceTimer);
    // Same browser session coming back after a signaling blip: keep the live media path.
    if (this.pc && this.remote?.sessionId === peer.sessionId) {
      this.remote = { ...peer };
      if (this.pc.connectionState !== 'connected') this.#restartIce();
      this.#syncStateToPeer();
      return;
    }
    // A different session (e.g. page refresh): start fresh.
    this.#closePeerConnection();
    this.remote = { ...peer };
    this.polite = weJoinedSecond;
    this.peerLowData = false;
    this.#emit({ remoteName: peer.name, phase: 'connecting', remoteVideoOn: false, peerLowData: false, error: null });
    this.#createPeerConnection();
    this.#syncStateToPeer();
  }

  #syncStateToPeer() {
    this.#sendEvent({ type: 'video-state', value: !!this.videoTrack });
    this.#sendEvent({ type: 'low-data', value: this.lowData });
  }

  #onPeerLeft(id, reason) {
    if (!this.remote || this.remote.id !== id) return;
    const who = this.remote.name;
    if (reason === 'hangup') return this.#finish(`${who} ended the call.`);

    // Their signaling dropped (or they closed the tab). If media is still flowing keep it for a while.
    const alive = this.pc?.connectionState === 'connected';
    this.#emit({
      phase: alive ? 'connected' : 'peer-disconnected',
      notice: this.#notice(`${who} lost their connection to the call server. Waiting for them to come back…`),
    });
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      this.#closePeerConnection();
      this.remote = null;
      this.#emit({ phase: 'peer-disconnected', remoteName: who, remoteVideoOn: false, remoteStream: null, quality: null, tier: 0 });
    }, PEER_GRACE_MS);
  }

  #onPeerEvent(from, event) {
    if (!this.remote || from !== this.remote.id) return;
    if (event.type === 'video-state') this.#emit({ remoteVideoOn: event.value });
    if (event.type === 'low-data') {
      this.peerLowData = event.value;
      this.#emit({ peerLowData: event.value });
      const who = this.remote.name;
      if (event.value) {
        this.#emit({ notice: this.#notice(`${who} is saving data, so your video was paused.`) });
        this.pauseVideo('peer-low-data');
      } else if (this.videoPauseReason === 'peer-low-data') {
        this.#emit({ resumeHint: 'peer-resumed', notice: this.#notice(`${who} turned video back on. You can turn yours on too.`) });
      }
    }
  }

  // ---------- peer connection ----------

  #createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.restartCount = 0;
    this.signalQueue = Promise.resolve();
    this.remoteStream = new MediaStream();

    this.audioSender = pc.addTrack(this.audioTrack, this.localStream);
    if (this.videoTrack) this.videoSender = pc.addTrack(this.videoTrack, this.localStream);
    // No camera right now? Keep a video transceiver so we can still RECEIVE video and
    // later start sending with replaceTrack() without renegotiating.
    else this.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;

    pc.ontrack = ({ track }) => {
      if (pc !== this.pc) return;
      const tracks = this.remoteStream.getTracks().filter((t) => t.id !== track.id);
      this.remoteStream = new MediaStream([...tracks, track]);
      this.#emit({ remoteStream: this.remoteStream });
    };

    pc.onicecandidate = ({ candidate }) => {
      if (pc === this.pc && candidate) this.#signal({ type: 'candidate', candidate: candidate.toJSON() });
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (pc !== this.pc) return;
        this.#signal({ type: 'description', description: pc.localDescription.toJSON() });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => pc === this.pc && this.#onConnectionChange();
    pc.oniceconnectionstatechange = () => pc === this.pc && this.#onConnectionChange();
  }

  async #handleSignal(data) {
    const pc = this.pc;
    if (!pc) return;
    if (data.type === 'description') {
      const description = data.description;
      const collision = description.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(description); // polite side rolls back implicitly
      if (pc !== this.pc) return;
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        if (pc === this.pc) this.#signal({ type: 'description', description: pc.localDescription.toJSON() });
      }
    } else if (data.type === 'candidate') {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!this.ignoreOffer) console.warn('addIceCandidate failed', err);
      }
    }
  }

  #onConnectionChange() {
    const pc = this.pc;
    if (!pc || this.destroyed) return;
    const state = pc.connectionState;
    const ice = pc.iceConnectionState;

    if (state === 'connected') {
      clearTimeout(this.restartTimer);
      this.restartCount = 0;
      this.#emit({ phase: 'connected', error: null });
      this.#startMonitoring();
      this.#applySenderPolicy();
    } else if (state === 'failed') {
      this.#restartIce();
    } else if (state === 'disconnected' || ice === 'disconnected') {
      this.#emit({ phase: 'reconnecting' });
      clearTimeout(this.restartTimer);
      // Brief blips often heal on their own; restart ICE only if it does not.
      this.restartTimer = setTimeout(() => {
        if (this.pc === pc && pc.connectionState !== 'connected') this.#restartIce();
      }, 4000);
    } else if ((state === 'connecting' || state === 'new') && this.phase !== 'connected' && this.phase !== 'reconnecting') {
      this.#emit({ phase: 'connecting' });
    }
  }

  #restartIce() {
    const pc = this.pc;
    if (!pc || this.destroyed) return;
    if (this.restartCount >= MAX_ICE_RESTARTS) {
      return this.#emit({
        phase: 'failed',
        error: 'We could not restore the connection. Check your internet, then try again.',
      });
    }
    this.restartCount += 1;
    this.#emit({ phase: 'reconnecting' });
    pc.restartIce(); // triggers negotiationneeded -> offer with iceRestart
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (this.pc === pc && pc.connectionState !== 'connected') this.#restartIce();
    }, 6000 * this.restartCount);
  }

  #closePeerConnection() {
    clearTimeout(this.restartTimer);
    this.monitor?.stop();
    this.monitor = null;
    const pc = this.pc;
    this.pc = null;
    this.audioSender = null;
    this.videoSender = null;
    if (pc) {
      pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = null;
      pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
      pc.close();
    }
    this.remoteStream = null;
  }

  // ---------- monitoring & adaptation ----------

  #startMonitoring() {
    if (this.monitor || !this.pc) return;
    this.monitor = new NetworkMonitor(this.pc, { intervalMs: 2000, onSample: (s) => this.#onSample(s) });
    this.monitor.start();
  }

  #onSample(sample) {
    if (this.destroyed) return;
    const severity = severityOf(sample);
    this.#emit({ quality: { ...sample, severity } });
    const change = this.controller.update(severity);
    if (change) this.#applyTier(change);
  }

  async #applyTier({ from, to }) {
    this.#emit({ tier: to });

    if (to >= AUDIO_ONLY_TIER) {
      if (!this.videoTrack) return; // nothing to turn off
      if (this.autoAudioOnly) {
        await this.pauseVideo('auto-poor-network');
        this.#emit({ notice: this.#notice('Connection is very poor, so video was turned off to keep the conversation going.') });
      } else {
        this.#emit({ suggestAudioOnly: true, notice: this.#notice('Connection is very poor. Switching to audio only may help.') });
      }
      return;
    }

    this.#emit({ suggestAudioOnly: false });
    if (from >= AUDIO_ONLY_TIER) {
      if (this.videoPauseReason === 'auto-poor-network') {
        this.#emit({ resumeHint: 'network-recovered', notice: this.#notice('Connection looks stable again. You can turn video back on.') });
      }
      return;
    }
    await this.#applyVideoProfile(to);
    this.#emit({
      notice: this.#notice(
        to > from
          ? 'Connection is weak, so video quality was lowered to protect your audio.'
          : 'Connection improved. Video quality went back up a step.',
      ),
    });
  }

  /** Lowers/raises the sender's CEILINGS. WebRTC's own congestion control still adapts beneath them. */
  async #applyVideoProfile(tier) {
    const sender = this.videoSender;
    if (!sender?.track) return;
    const p = PROFILES[Math.min(tier, PROFILES.length - 1)];
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      Object.assign(params.encodings[0], {
        maxBitrate: p.maxBitrate,
        maxFramerate: p.maxFramerate,
        scaleResolutionDownBy: p.scale,
        priority: 'low',
        networkPriority: 'low',
      });
      await sender.setParameters(params);
    } catch (err) {
      console.debug('setParameters not applied (unsupported or not negotiated yet)', err);
    }
  }

  async #applySenderPolicy() {
    // Audio gets priority over video wherever the browser supports it.
    try {
      const params = this.audioSender?.getParameters();
      if (params) {
        if (!params.encodings?.length) params.encodings = [{}];
        Object.assign(params.encodings[0], { priority: 'high', networkPriority: 'high' });
        await this.audioSender.setParameters(params);
      }
    } catch (err) {
      console.debug('audio priority not applied', err);
    }
    await this.#applyVideoProfile(Math.min(this.controller.tier, AUDIO_ONLY_TIER - 1));
  }

  // ---------- helpers ----------

  #notice(text) {
    return { text, id: ++this.noticeId };
  }

  #emit(patch) {
    if (patch.phase) {
      // Never leave "ended" once reached.
      if (this.phase === 'ended') return;
      this.phase = patch.phase;
    }
    // Drop undefined keys so they don't overwrite state.
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    this.onChange(clean);
  }
}
