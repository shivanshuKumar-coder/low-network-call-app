import { useMemo } from "react";

const LABELS = [
  { label: "Good", tone: "good", bars: 4 },
  { label: "Fair", tone: "fair", bars: 3 },
  { label: "Poor", tone: "poor", bars: 2 },
  { label: "Very poor", tone: "poor", bars: 1 },
];

const fmt = (v, digits = 0, unit = "") =>
  typeof v === "number" && Number.isFinite(v)
    ? `${v.toFixed(digits)}${unit}`
    : "—";

/**
 * Turns raw stats into something a person can read. It is an estimate based on a few
 * seconds of measurements, so the UI always labels it as such.
 */
export function useNetworkQuality(phase, quality) {
  return useMemo(() => {
    if (phase === "reconnecting")
      return { label: "Reconnecting", tone: "poor", bars: 1, details: [] };
    if (
      phase !== "connected" ||
      !quality ||
      quality.severity === null ||
      quality.severity === undefined
    ) {
      return {
        label: phase === "connected" ? "Measuring" : "",
        tone: "idle",
        bars: 0,
        details: [],
      };
    }
    const base = LABELS[quality.severity];
    const res = quality.frameWidth
      ? `${quality.frameWidth}×${quality.frameHeight}`
      : "—";
    return {
      ...base,
      details: [
        [
          "Route",
          quality.relay === null
            ? "—"
            : quality.relay
              ? "Relayed (TURN)"
              : "Direct",
        ],
        ["Round trip", fmt(quality.rttMs, 0, " ms")],
        ["Packet loss", fmt(quality.lossPct, 1, "%")],
        ["Jitter", fmt(quality.jitterMs, 0, " ms")],
        [
          "Video sent",
          quality.videoBitrateKbps != null
            ? `${fmt(quality.videoBitrateKbps, 0, " kbps")} · ${res}`
            : "—",
        ],
      ],
    };
  }, [phase, quality]);
}
