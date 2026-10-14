// Pure, browser-independent logic for reading WebRTC stats and deciding how to
// adapt. Kept free of DOM/WebRTC globals (apart from the pc passed to the
// monitor) so it can be unit-tested with plain Node.
//
// Design notes
//  * We do NOT fight WebRTC's own congestion control. We only set CEILINGS
//    (max bitrate / frame rate / resolution scale) and let the browser adapt below them.
//  * No single metric decides anything: severity is the worst of loss, RTT and jitter,
//    and a tier only changes after the condition has been sustained (hysteresis).
//  * Missing stats are normal (browser differences). Missing => "no data", never a crash.

/** Encoding ceilings per tier. Tier 3 is audio-only (no video sent). */
export const PROFILES = [
  { label: 'Full', maxBitrate: 1_000_000, maxFramerate: 30, scale: 1 },
  { label: 'Reduced', maxBitrate: 500_000, maxFramerate: 20, scale: 1 },
  { label: 'Low', maxBitrate: 200_000, maxFramerate: 12, scale: 2 },
];
export const AUDIO_ONLY_TIER = 3;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Initial heuristics; tune with real-world testing. [fair, poor, veryPoor] lower bounds. */
export const THRESHOLDS = {
  lossPct: [2, 5, 10],
  rttMs: [300, 500, 900],
  jitterMs: [30, 60, 120],
};

const level = (value, [fair, poor, veryPoor]) =>
  value === null ? null : value < fair ? 0 : value < poor ? 1 : value < veryPoor ? 2 : 3;

/** 0 good, 1 fair, 2 poor, 3 very poor, or null when there is no usable data. */
export function severityOf(sample) {
  if (!sample) return null;
  const levels = [
    level(num(sample.lossPct), THRESHOLDS.lossPct),
    level(num(sample.rttMs), THRESHOLDS.rttMs),
    level(num(sample.jitterMs), THRESHOLDS.jitterMs),
  ].filter((l) => l !== null);
  return levels.length ? Math.max(...levels) : null;
}

/**
 * Turns one RTCStatsReport into a flat sample. `prev` is the object returned as
 * `next` by the previous call; loss and bitrate are computed from COUNTER DELTAS
 * over the interval, never from lifetime totals.
 */
export function computeSample(report, prev = {}, now = Date.now()) {
  const byId = new Map();
  report.forEach((s) => byId.set(s.id, s));
  const kindOf = (s) => s.kind || s.mediaType;

  let pair = null;
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId && byId.has(s.selectedCandidatePairId)) {
      pair = byId.get(s.selectedCandidatePairId);
    }
  });
  if (!pair) {
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && s.state === 'succeeded' && (s.nominated || s.selected)) pair = s;
    });
  }

  let rttMs = num(pair?.currentRoundTripTime) !== null ? pair.currentRoundTripTime * 1000 : null;
  const localCandidate = pair ? byId.get(pair.localCandidateId) : null;
  const relay = localCandidate ? localCandidate.candidateType === 'relay' : null;

  const dt = prev.t ? (now - prev.t) / 1000 : null;
  const cur = {};
  let dLost = 0;
  let dRecv = 0;
  let audioJitter = null;
  let videoJitter = null;
  let upLossAudio = null;
  let upLossVideo = null;
  let remoteRtt = null;
  let videoBitrateKbps = null;
  let frameWidth = null;
  let frameHeight = null;
  let fps = null;
  let framesDropped = null;
  let limitation = null;

  report.forEach((s) => {
    const kind = kindOf(s);

    if (s.type === 'inbound-rtp' && !s.isRemote) {
      const lost = Math.max(0, num(s.packetsLost) ?? 0);
      const recv = num(s.packetsReceived) ?? 0;
      const p = prev.c?.[s.id];
      cur[s.id] = { lost, recv, dropped: num(s.framesDropped) ?? 0 };
      if (p) {
        dLost += Math.max(0, lost - p.lost);
        dRecv += Math.max(0, recv - p.recv);
        if (kind === 'video' && num(s.framesDropped) !== null) {
          framesDropped = Math.max(0, s.framesDropped - p.dropped);
        }
      }
      const j = num(s.jitter) !== null ? s.jitter * 1000 : null;
      if (kind === 'audio') audioJitter = j;
      else if (kind === 'video') videoJitter = j;
    }

    if (s.type === 'remote-inbound-rtp') {
      // What the OTHER side reports about the media we send (uplink health).
      const frac = num(s.fractionLost) !== null ? s.fractionLost * 100 : null;
      if (kind === 'audio') upLossAudio = frac;
      else if (kind === 'video') upLossVideo = frac;
      if (num(s.roundTripTime) !== null) remoteRtt = s.roundTripTime * 1000;
    }

    if (s.type === 'outbound-rtp' && kind === 'video') {
      const bytes = num(s.bytesSent) ?? 0;
      const p = prev.c?.[s.id];
      cur[s.id] = { bytes };
      if (p && dt && dt > 0 && bytes >= p.bytes) videoBitrateKbps = ((bytes - p.bytes) * 8) / dt / 1000;
      frameWidth = num(s.frameWidth);
      frameHeight = num(s.frameHeight);
      fps = num(s.framesPerSecond);
      limitation = s.qualityLimitationReason ?? null;
    }
  });

  if (rttMs === null) rttMs = remoteRtt;

  const total = dLost + dRecv;
  const downLossPct = total >= 20 ? (dLost / total) * 100 : null; // ignore tiny samples
  const upLossPct = upLossAudio ?? upLossVideo;
  const losses = [downLossPct, upLossPct].filter((v) => v !== null);

  return {
    sample: {
      t: now,
      rttMs,
      jitterMs: audioJitter ?? videoJitter,
      lossPct: losses.length ? Math.max(...losses) : null,
      downLossPct,
      upLossPct,
      videoBitrateKbps,
      frameWidth,
      frameHeight,
      fps,
      framesDropped,
      limitation,
      relay,
    },
    next: { t: now, c: cur },
  };
}

/** Polls getStats() on a timer and reports samples. Safe against overlapping/late calls. */
export class NetworkMonitor {
  constructor(pc, { intervalMs = 2000, onSample }) {
    this.pc = pc;
    this.intervalMs = intervalMs;
    this.onSample = onSample;
    this.prev = {};
    this.timer = null;
    this.busy = false;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.#tick(), this.intervalMs);
    this.#tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }

  async #tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const report = await this.pc.getStats();
      if (this.stopped) return;
      const { sample, next } = computeSample(report, this.prev);
      this.prev = next;
      this.onSample({
        ...sample,
        connectionState: this.pc.connectionState,
        iceState: this.pc.iceConnectionState,
      });
    } catch {
      // getStats can reject while the connection is closing; just skip this tick.
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Hysteresis: move ONE tier at a time, only after the condition has persisted.
 *  - worse for `downAfter` consecutive samples  -> tier + 1
 *  - better for `upAfter`  consecutive samples  -> tier - 1 (slower; leaving audio-only is slowest)
 * `update()` returns { from, to } when the tier changed, otherwise null.
 */
export class AdaptationController {
  constructor({ downAfter = 3, upAfter = 10, upAfterAudioOnly = 15 } = {}) {
    this.downAfter = downAfter;
    this.upAfter = upAfter;
    this.upAfterAudioOnly = upAfterAudioOnly;
    this.tier = 0;
    this.worse = 0;
    this.better = 0;
  }

  update(severity) {
    if (severity === null || severity === undefined) return null; // no data: change nothing
    const from = this.tier;

    if (severity > this.tier && this.tier < AUDIO_ONLY_TIER) {
      this.better = 0;
      if (++this.worse >= this.downAfter) {
        this.tier += 1;
        this.worse = 0;
      }
    } else if (severity < this.tier) {
      this.worse = 0;
      const need = this.tier === AUDIO_ONLY_TIER ? this.upAfterAudioOnly : this.upAfter;
      if (++this.better >= need) {
        this.tier -= 1;
        this.better = 0;
      }
    } else {
      this.worse = 0;
      this.better = 0;
    }
    return this.tier !== from ? { from, to: this.tier } : null;
  }

  reset(tier = 0) {
    this.tier = tier;
    this.worse = 0;
    this.better = 0;
  }
}
