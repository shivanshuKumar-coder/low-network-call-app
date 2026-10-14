import { useEffect, useRef } from "react";

export default function LocalVideo({ stream, videoOn, micOn }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream ?? null;
  }, [stream]);

  return (
    <div className="local" aria-label="Your camera preview">
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={videoOn ? "visible" : ""}
      />
      {!videoOn && <span className="local-off">Camera off</span>}
      <span className={`pill ${micOn ? "" : "pill-off"}`}>
        {micOn ? "Mic on" : "Mic muted"}
      </span>
    </div>
  );
}
