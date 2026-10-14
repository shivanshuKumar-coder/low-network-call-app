import { CamIcon, CamOffIcon, DataSaverIcon, HangUpIcon, MicIcon, MicOffIcon } from './Icons.jsx';

export default function CallControls({ micOn, videoOn, lowData, peerLowData, noCamera, onMic, onCamera, onLowData, onHangUp }) {
  const cameraBlocked = lowData || peerLowData;
  const cameraLabel = peerLowData
    ? 'Camera is off while the other person saves data'
    : lowData
      ? 'Camera is off in audio-only mode'
      : videoOn
        ? 'Turn camera off'
        : noCamera
          ? 'No camera found'
          : 'Turn camera on';

  return (
    <div className="controls" role="toolbar" aria-label="Call controls">
      <button type="button" className={`ctl ${micOn ? '' : 'is-off'}`} onClick={onMic} aria-pressed={!micOn} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'}>
        {micOn ? <MicIcon /> : <MicOffIcon />}
        <span>{micOn ? 'Mute' : 'Unmute'}</span>
      </button>

      <button type="button" className={`ctl ${videoOn ? '' : 'is-off'}`} onClick={onCamera} disabled={cameraBlocked} aria-pressed={!videoOn} aria-label={cameraLabel} title={cameraLabel}>
        {videoOn ? <CamIcon /> : <CamOffIcon />}
        <span>{videoOn ? 'Camera' : 'Camera off'}</span>
      </button>

      <button type="button" className={`ctl ${lowData ? 'is-on' : ''}`} onClick={() => onLowData(!lowData)} aria-pressed={lowData} aria-label="Audio only, low data mode" title="Audio only uses far less data. It also asks the other person to pause their video.">
        <DataSaverIcon />
        <span>{lowData ? 'Audio only on' : 'Audio only'}</span>
      </button>

      <button type="button" className="ctl hangup" onClick={onHangUp} aria-label="Hang up">
        <HangUpIcon />
        <span>Hang up</span>
      </button>
    </div>
  );
}
