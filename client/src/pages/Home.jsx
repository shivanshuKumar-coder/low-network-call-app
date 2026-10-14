import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ROOM_ID_RE } from "../services/webrtc.js";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

// 12 random characters (~60 bits) so room links are not guessable.
function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8, 12)]
    .map((g) => g.join(""))
    .join("-");
}

function parseRoom(input) {
  const last = input.trim().split(/[/?#]/).filter(Boolean).pop() ?? "";
  return ROOM_ID_RE.test(last) ? last : null;
}

export default function Home() {
  const navigate = useNavigate();
  const [name, setName] = useState(
    () => sessionStorage.getItem("lnc:name") ?? "",
  );
  const [roomInput, setRoomInput] = useState("");
  const [error, setError] = useState("");

  const go = (roomId) => {
    const clean = name.trim();
    if (!clean)
      return setError(
        "Enter your name so the other person knows who is calling.",
      );
    sessionStorage.setItem("lnc:name", clean);
    navigate(`/room/${roomId}`);
  };

  const join = (e) => {
    e.preventDefault();
    const id = parseRoom(roomInput);
    if (!id)
      return setError(
        "That does not look like a room ID or call link. Paste the link you were sent.",
      );
    go(id);
  };

  return (
    <main className="home">
      {/* <section className="home-copy">
        <div className="brand">
          <svg viewBox="0 0 32 32" width="34" height="34" aria-hidden="true">
            <rect x="6" y="19" width="4" height="7" rx="1.5" />
            <rect x="12" y="14" width="4" height="12" rx="1.5" />
            <rect x="18" y="9" width="4" height="17" rx="1.5" />
            <rect x="24" y="5" width="3" height="21" rx="1.5" opacity=".35" />
          </svg>
          <span>Steady Call</span>
        </div>
        <h1>When the signal drops, the conversation keeps going.</h1>
        <p className="lede">
          One-to-one audio and video calls that protect your voice first. On a
          weak connection the app lowers video quality, then switches to audio
          only, and tells you what it is doing.
        </p>
        <ul className="plain-list">
          <li>Both people open this app and join the same room.</li>
          <li>
            Your browser asks for camera and microphone access only after you
            press Join.
          </li>
          <li>No camera? You can still join with audio only.</li>
        </ul>
      </section> */}

      <section className="panel" aria-labelledby="start-heading">
        <h2 id="start-heading">Start or join a call</h2>
        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            maxLength={40}
            autoComplete="name"
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            placeholder="eg..shiva"
          />
        </label>

        <button 
          type="button"
          className="btn primary wide"
          onClick={() => go(newRoomId())}
        >
          Create a new call
        </button>

        <div className="or" role="separator">
          <span>or join one</span>
        </div>

        <form onSubmit={join}>
          <label className="field">
            <span>Room ID or call link</span>
            <input
              value={roomInput}
              onChange={(e) => {
                setRoomInput(e.target.value);
                setError("");
              }}
              placeholder="abcd-efgh-jkmn"
              autoCapitalize="none"
              spellCheck="false"
            />
          </label>
          <button
            type="submit"
            className="btn wide"
            disabled={!roomInput.trim()}
          >
            Join call
          </button>
        </form>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
