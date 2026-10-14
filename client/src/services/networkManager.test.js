import test from "node:test";
import assert from "node:assert/strict";
import {
  AdaptationController,
  computeSample,
  severityOf,
} from "./networkManager.js";

const report = (entries) => new Map(entries.map((e) => [e.id, e]));

test("severityOf: worst metric wins, missing data is null", () => {
  assert.equal(severityOf({ lossPct: 0, rttMs: 80, jitterMs: 5 }), 0);
  assert.equal(severityOf({ lossPct: 3, rttMs: 80, jitterMs: 5 }), 1);
  assert.equal(severityOf({ lossPct: 0, rttMs: 600, jitterMs: 5 }), 2);
  assert.equal(severityOf({ lossPct: 0, rttMs: 80, jitterMs: 200 }), 3);
  assert.equal(
    severityOf({ lossPct: null, rttMs: null, jitterMs: null }),
    null,
  );
  assert.equal(severityOf(undefined), null);
  assert.equal(severityOf({ rttMs: 100 }), 0); // partial data is still usable
});

test("controller: downgrades only after sustained trouble, one step at a time", () => {
  const c = new AdaptationController();
  assert.equal(c.update(2), null);
  assert.equal(c.update(0), null); // a recovery blip resets the worsening streak
  assert.equal(c.update(2), null);
  assert.equal(c.update(2), null);
  assert.deepEqual(c.update(2), { from: 0, to: 1 });
  assert.equal(c.update(3), null);
  assert.equal(c.update(3), null);
  assert.deepEqual(c.update(3), { from: 1, to: 2 });
});

test("controller: single spikes never change tier", () => {
  const c = new AdaptationController();
  for (let i = 0; i < 50; i++)
    assert.equal(c.update(i % 3 === 0 ? 3 : 0), null);
  assert.equal(c.tier, 0);
});

test("controller: recovery is slower than degradation and leaving audio-only is slowest", () => {
  const c = new AdaptationController();
  c.reset(2);
  for (let i = 0; i < 9; i++) assert.equal(c.update(0), null);
  assert.deepEqual(c.update(0), { from: 2, to: 1 });

  c.reset(3);
  for (let i = 0; i < 14; i++) assert.equal(c.update(1), null);
  assert.deepEqual(c.update(1), { from: 3, to: 2 });
});

test("controller: null severity (no data) changes nothing", () => {
  const c = new AdaptationController();
  c.update(3);
  c.update(3);
  assert.equal(c.update(null), null);
  assert.deepEqual(c.update(3), { from: 0, to: 1 }); // streak was preserved
});

test("computeSample: loss uses counter deltas, not lifetime totals", () => {
  const mk = (lost, recv, bytes) => [
    { id: "T", type: "transport", selectedCandidatePairId: "P" },
    {
      id: "P",
      type: "candidate-pair",
      currentRoundTripTime: 0.12,
      localCandidateId: "L",
    },
    { id: "L", type: "local-candidate", candidateType: "relay" },
    {
      id: "A",
      type: "inbound-rtp",
      kind: "audio",
      packetsLost: lost,
      packetsReceived: recv,
      jitter: 0.02,
    },
    {
      id: "V",
      type: "outbound-rtp",
      kind: "video",
      bytesSent: bytes,
      frameWidth: 640,
      frameHeight: 480,
      framesPerSecond: 24,
    },
  ];
  // Lifetime: 500 lost of 10000 (5%). In the last interval only 10 of 100 were lost (10%).
  const first = computeSample(report(mk(490, 9900, 0)), {}, 1000);
  assert.equal(first.sample.lossPct, null); // no previous counters yet
  const second = computeSample(
    report(mk(500, 9990, 250_000)),
    first.next,
    3000,
  );
  assert.ok(Math.abs(second.sample.downLossPct - 10) < 0.01);
  assert.equal(Math.round(second.sample.videoBitrateKbps), 1000); // 250 kB in 2 s
  assert.equal(Math.round(second.sample.rttMs), 120);
  assert.equal(Math.round(second.sample.jitterMs), 20);
  assert.equal(second.sample.relay, true);
  assert.equal(second.sample.frameWidth, 640);
});

test("computeSample: empty or partial reports do not throw", () => {
  const { sample } = computeSample(report([]), {}, 1);
  assert.equal(severityOf(sample), null);
  const partial = computeSample(
    report([{ id: "x", type: "inbound-rtp", kind: "audio" }]),
    {},
    1,
  );
  assert.equal(partial.sample.lossPct, null);
});

test("computeSample: tiny samples are ignored to avoid noisy loss figures", () => {
  const mk = (lost, recv) => [
    {
      id: "A",
      type: "inbound-rtp",
      kind: "audio",
      packetsLost: lost,
      packetsReceived: recv,
    },
  ];
  const a = computeSample(report(mk(0, 0)), {}, 1000);
  const b = computeSample(report(mk(2, 3)), a.next, 3000);
  assert.equal(b.sample.downLossPct, null);
});
