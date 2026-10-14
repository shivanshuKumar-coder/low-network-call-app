import { useEffect, useRef } from 'react';

export default function RemoteVideo({ stream, showVideo, name, audioOnlyNote }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream ?? null;
  }, [stream]);

  return (
    <div className="remote">
      {/* The <video> element also plays the remote audio, so it stays mounted even when video is hidden. */}
      <video ref={ref} autoPlay playsInline className={showVideo ? 'visible' : ''} aria-label={name ? `Video of ${name}` : 'Remote video'} />
      {!showVideo && stream && (
        <div className="avatar" role="img" aria-label={`${name || 'Other person'}, audio only`}>
          <span>{(name || '?').trim().charAt(0).toUpperCase()}</span>
          <p>{audioOnlyNote || 'Audio only'}</p>
        </div>
      )}
    </div>
  );
}
