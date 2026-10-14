import { Link, useLocation, useNavigate } from 'react-router-dom';

export default function CallEnded() {
  const { state } = useLocation();
  const navigate = useNavigate();
  return (
    <main className="center-page">
      <div className="panel narrow">
        <h1 className="h2">Call ended</h1>
        <p>{state?.reason ?? 'This call has ended.'}</p>
        <div className="row">
          <Link className="btn primary" to="/">Back to home</Link>
          {state?.roomId && (
            <button type="button" className="btn" onClick={() => navigate(`/room/${state.roomId}`)}>Rejoin this room</button>
          )}
        </div>
      </div>
    </main>
  );
}
