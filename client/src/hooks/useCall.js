import { useCallback, useEffect, useRef, useState } from "react";
import { createSocket } from "../services/socket.js";
import { CallSession, fetchIceServers } from "../services/webrtc.js";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "";

const INITIAL = {
  phase: "idle", // see CallRoom for how each phase is presented
  error: null,
  notice: null, // { text, id }
  endReason: null,
  remoteName: null,
  localStream: null,
  remoteStream: null,
  micOn: true,
  videoOn: false,
  videoPauseReason: null,
  remoteVideoOn: false,
  lowData: false,
  peerLowData: false,
  autoAudioOnly: true,
  tier: 0, // 0 full, 1 reduced, 2 low, 3 audio-only
  quality: null,
  resumeHint: null, // 'network-recovered' | 'peer-resumed' | null
  suggestAudioOnly: false,
};

export function useCall(roomId) {
  const [state, setState] = useState(INITIAL);
  const sessionRef = useRef(null);
  const merge = useCallback(
    (patch) => setState((s) => ({ ...s, ...patch })),
    [],
  );

  const join = useCallback(
    async (name) => {
      sessionRef.current?.destroy();
      setState({ ...INITIAL, phase: "requesting-media" });
      const iceServers = await fetchIceServers(SERVER_URL);
      const session = new CallSession({
        socket: createSocket(SERVER_URL),
        roomId,
        name,
        iceServers,
        onChange: merge,
      });
      sessionRef.current = session;
      await session.start();
    },
    [roomId, merge],
  );

  // Leaving the page = leaving the call. Releases camera, mic, peer connection and socket.
  useEffect(() => () => sessionRef.current?.destroy(), []);

  const call =
    (method) =>
    (...args) =>
      sessionRef.current?.[method](...args);

  return {
    state,
    join,
    hangUp: call("hangUp"),
    toggleMic: call("toggleMic"),
    toggleCamera: call("toggleCamera"),
    setLowData: call("setLowData"),
    resumeVideo: call("resumeVideo"),
    setAutoAudioOnly: call("setAutoAudioOnly"),
    retryConnection: call("retryConnection"),
  };
}
