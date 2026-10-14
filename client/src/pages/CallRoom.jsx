import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useCall } from '../hooks/useCall.js';
import { ROOM_ID_RE } from '../services/webrtc.js';
import CallControls from '../components/CallControls.jsx';
import ConnectionStatus from '../components/ConnectionStatus.jsx';
import LocalVideo from '../components/LocalVideo.jsx';
import RemoteVideo from '../components/RemoteVideo.jsx';
import { CopyIcon } from '../components/Icons.jsx';

const BLOCKING = new Set(['unsupported', 'media-error', 'room-full', 'error']);

export default function CallRoom() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const validRoom = ROOM_ID_RE.test(roomId ?? '');
  const call = useCall(roomId);
  const { state: s } = call;
  const [name, setName] = useState(() => sessionStorage.getItem('lnc:name') ?? '');
  const [copied, setCopied] = useState(false);
  const [visibleNotice, setVisibleNotice] = useState(null);

  useEffect(() => {
    if (s.phase === 'ended') navigate('/ended', { replace: true, state: { reason: s.endReason, roomId } });
  }, [s.phase, s.endReason, navigate, roomId]);

  // Notices are announced politely to screen readers and fade after a few seconds.
  useEffect(() => {
    if (!s.notice) return undefined;
    setVisibleNotice(s.notice.text);
    const t = setTimeout(() => setVisibleNotice(null), 8000);
    return () => clearTimeout(t);
  }, [s.notice]);

  const link = `${window.location.origin}/room/${roomId}`;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this link', link);
    }
  };

  const startJoin = (e) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean) return;
    sessionStorage.setItem('lnc:name', clean);
    call.join(clean);
  };

  if (!validRoom) {
    return (
      <main className="center-page">
        <div className="panel narrow">
          <h1 className="h2">That room link is not valid</h1>
          <p>Room IDs use letters, numbers, dashes and underscores. Ask for a new link.</p>
          <Link className="btn primary" to="/">Back to home</Link>
        </div>
      </main>
    );
  }

  // ---- Before joining: nothing is requested until the person presses the button ----
  if (s.phase === 'idle') {
    return (
      <main className="center-page">
        <form className="panel narrow" onSubmit={startJoin}>
          <h1 className="h2">Ready to join?</h1>
          <p>
            When you press Join, your browser will ask to use your microphone and camera. Audio is required; video is optional.
            If the other person has not arrived yet, you will wait in the room.
          </p>
          <label className="field">
            <span>Your name</span>
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <div className="row">
            <button type="submit" className="btn primary" disabled={!name.trim()}>Allow access and join</button>
            <Link className="btn" to="/">Cancel</Link>
          </div>
        </form>
      </main>
    );
  }

  // ---- Problems that stop the call before it starts ----
  if (BLOCKING.has(s.phase)) {
    const title = {
      unsupported: 'This browser cannot start a call',
      'media-error': 'We could not access your microphone',
      'room-full': 'This room already has two people',
      error: 'We could not join this room',
    }[s.phase];
    return (
      <main className="center-page">
        <div className="panel narrow" role="alert">
          <h1 className="h2">{title}</h1>
          {s.error && <p>{s.error}</p>}
          {s.phase === 'room-full' && <p>Calls here are one-to-one. Ask the host for a new room link.</p>}
          <div className="row">
            {(s.phase === 'media-error' || s.phase === 'error') && (
              <button type="button" className="btn primary" onClick={() => call.join(name.trim())}>Try again</button>
            )}
            <Link className="btn" to="/">Back to home</Link>
          </div>
        </div>
      </main>
    );
  }

  const connected = s.phase === 'connected';
  const showRemoteVideo = connected && s.remoteVideoOn && !!s.remoteStream;
  const inLowMode = s.tier > 0 || s.lowData;
  const audioOnlyNow = !s.videoOn && (s.lowData || s.videoPauseReason === 'auto-poor-network');
  const them = s.remoteName || 'The other person';

  const overlay = {
    'requesting-media': 'Waiting for permission to use your microphone and camera…',
    joining: 'Connecting to the call server…',
    waiting: 'Waiting for someone to join this room.',
    connecting: `Connecting to ${them}…`,
    reconnecting: 'The connection was interrupted. Trying to restore it…',
    'peer-disconnected': `${them} disconnected. You can wait for them to rejoin or hang up.`,
    failed: s.error,
  }[s.phase];

  return (
    <main className="call">
      <header className="call-bar">
        <div className="call-title">
          <strong>{s.remoteName ? `Call with ${s.remoteName}` : 'Your call room'}</strong>
        </div>
        <ConnectionStatus phase={s.phase} quality={s.quality} />
      </header>

      <section className="stage" aria-label="Call">
        <RemoteVideo
          stream={s.remoteStream}
          showVideo={showRemoteVideo}
          name={s.remoteName}
          audioOnlyNote={s.peerLowData ? `${them} is saving data` : s.remoteVideoOn ? 'Video unavailable' : 'Audio only'}
        />

        {overlay && (
          <div className="overlay" role="status">
            <p>{overlay}</p>
            {s.phase === 'waiting' && (
              <button type="button" className="btn small" onClick={copyLink}>
                <CopyIcon /> {copied ? 'Link copied' : 'Copy invite link'}
              </button>
            )}
            {s.phase === 'failed' && (
              <button type="button" className="btn primary small" onClick={call.retryConnection}>Try to reconnect</button>
            )}
          </div>
        )}

        <LocalVideo stream={s.localStream} videoOn={s.videoOn} micOn={s.micOn} />
      </section>

      <div className="banners">
        {inLowMode && (
          <p className="banner low" role="status">
            <strong>Low-network mode.</strong>{' '}
            {s.lowData
              ? 'Audio only is on to save data.'
              : audioOnlyNow
                ? 'Video is off so your audio stays clear.'
                : s.tier === 1
                  ? 'Video quality is slightly reduced.'
                  : 'Video quality is reduced to keep your audio clear.'}
          </p>
        )}
        {s.peerLowData && <p className="banner" role="status">{them} is saving data, so video is paused.</p>}
        {s.suggestAudioOnly && (
          <p className="banner warn">
            The connection is very poor. <button type="button" className="link" onClick={() => call.setLowData(true)}>Switch to audio only</button>
          </p>
        )}
        {s.resumeHint && (
          <p className="banner good">
            {s.resumeHint === 'network-recovered' ? 'The connection looks stable again.' : `${them} turned video back on.`}{' '}
            <button type="button" className="link" onClick={call.resumeVideo}>Turn my video on</button>
          </p>
        )}
      </div>

      <p className="sr-only" aria-live="polite">{visibleNotice}</p>
      {visibleNotice && <p className="toast" aria-hidden="true">{visibleNotice}</p>}

      <CallControls
        micOn={s.micOn}
        videoOn={s.videoOn}
        lowData={s.lowData}
        peerLowData={s.peerLowData}
        noCamera={s.videoPauseReason === 'no-camera'}
        onMic={call.toggleMic}
        onCamera={call.toggleCamera}
        onLowData={call.setLowData}
        onHangUp={call.hangUp}
      />

      <label className="auto-toggle">
        <input type="checkbox" checked={s.autoAudioOnly} onChange={(e) => call.setAutoAudioOnly(e.target.checked)} />
        <span>Switch to audio only automatically if the connection gets very poor</span>
      </label>
    </main>
  );
}
