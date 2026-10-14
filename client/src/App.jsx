import { Navigate, Route, Routes } from 'react-router-dom';
import Home from './pages/Home.jsx';
import CallRoom from './pages/CallRoom.jsx';
import CallEnded from './pages/CallEnded.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/room/:roomId" element={<CallRoom />} />
      <Route path="/ended" element={<CallEnded />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
