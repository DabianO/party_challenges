import { Link, Route, Routes } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { Display } from './pages/Display';
import { HostGame } from './pages/HostGame';
import { HostHome } from './pages/HostHome';
import { Join } from './pages/Join';
import { Landing } from './pages/Landing';
import { PublicResults } from './pages/PublicResults';

function NotFound() {
  return (
    <main className="page page-narrow center-text">
      <h1>Page not found</h1>
      <p className="muted">That link doesn't lead anywhere.</p>
      <Link className="btn btn-primary" to="/">
        Go to start
      </Link>
    </main>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/join" element={<Join />} />
        <Route path="/join/:code" element={<Join />} />
        <Route path="/display/:code" element={<Display />} />
        <Route path="/host" element={<HostHome />} />
        <Route path="/host/:gameId" element={<HostGame />} />
        <Route path="/results/:gameId" element={<PublicResults />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </ToastProvider>
  );
}
