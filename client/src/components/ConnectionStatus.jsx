import { useNetworkQuality } from "../hooks/useNetworkQuality.js";

const PHASE_TEXT = {
  "requesting-media": "Waiting for camera and microphone permission",
  joining: "Connecting to the call server",
  waiting: "Waiting for the other person",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Connection interrupted. Reconnecting",
  failed: "Connection lost",
  "peer-disconnected": "The other person disconnected",
};

export function SignalMeter({ bars, tone }) {
  return (
    <span className={`meter tone-${tone}`} aria-hidden="true">
      {[1, 2, 3, 4].map((n) => (
        <i
          key={n}
          className={n <= bars ? "on" : ""}
          style={{ height: `${25 + n * 18}%` }}
        />
      ))}
    </span>
  );
}

export default function ConnectionStatus({ phase, quality }) {
  const q = useNetworkQuality(phase, quality);
  const text = PHASE_TEXT[phase] ?? "";
  return (
    <div className="status">
      <SignalMeter bars={q.bars} tone={q.tone} />
      <div className="status-text">
        <strong>{q.label || text}</strong>
        {q.label && phase === "connected" && (
          <span className="muted"> · estimate</span>
        )}
        {q.label && phase !== "connected" && (
          <span className="muted"> · {text}</span>
        )}
      </div>
      {q.details.length > 0 && (
        <details className="status-details">
          <summary>Details</summary>
          <div className="pop">
            <dl>
              {q.details.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="muted small">
              Measured over the last few seconds. Treat it as a guide, not an
              exact reading.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
