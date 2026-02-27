import React, { useState, useEffect, useCallback } from 'react';
import AdminPanel from './components/AdminPanel';
import ViewerPage from './components/ViewerPage';

const App: React.FC = () => {
  const [route, setRoute] = useState<string>(() => {
    // SSR guard: ensure we only read window on the client
    return typeof window !== 'undefined' ? window.location.hash || '#/' : '#/';
  });

  const handleHashChange = useCallback(() => {
    setRoute(window.location.hash || '#/');
  }, []);

  useEffect(() => {
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [handleHashChange]);

  const renderView = () => {
    if (route.startsWith('#/viewer/')) {
      const streamId = route.split('#/viewer/')[1];
      return <ViewerPage streamId={streamId} />;
    }
    if (route === '#/admin') {
      return <AdminPanel />;
    }

    return (
      <div className="min-h-screen bg-[#0f0f0f] flex flex-col">
        {/* Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-[#0f0f0f] sticky top-0 z-40">
          <div className="flex items-center gap-4">
            <button
              onClick={() => window.location.hash = '#/'}
              className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            >
              <div className="w-9 h-6 bg-red-600 rounded-lg flex items-center justify-center">
                <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.28 6.28 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.2 8.2 0 004.79 1.52V6.76a4.85 4.85 0 01-1.02-.07z"/>
                </svg>
              </div>
              <span className="font-bold text-white text-lg tracking-tight">StreamStudio</span>
            </button>
          </div>
          <button
            onClick={() => { window.location.hash = '#/admin'; }}
            className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-full transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Go Live
          </button>
        </header>

        {/* Hero Section */}
        <div className="flex-1 flex flex-col items-center justify-center p-8">
          <div className="max-w-2xl w-full text-center">
            {/* Logo/Icon */}
            <div className="mb-8">
              <div className="inline-flex items-center justify-center w-24 h-24 bg-gradient-to-br from-red-600 to-red-700 rounded-3xl shadow-lg shadow-red-600/20 mb-6">
                <svg className="w-12 h-12 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.28 6.28 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.2 8.2 0 004.79 1.52V6.76a4.85 4.85 0 01-1.02-.07z"/>
                </svg>
              </div>
              <h1 className="text-4xl font-bold text-white mb-3">StreamStudio</h1>
              <p className="text-white/50 text-lg">Professional live streaming, simplified</p>
            </div>

            {/* CTA */}
            <div className="space-y-4">
              <button
                onClick={() => { window.location.hash = '#/admin'; }}
                className="w-full sm:w-auto px-10 py-4 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-full transition-all hover:scale-105 shadow-lg shadow-red-600/25"
              >
                Start Broadcasting
              </button>
              <p className="text-white/40 text-sm">No account required • Instant streaming links</p>
            </div>

            {/* Features */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 mt-12 pt-8 border-t border-white/10">
              {[
                { icon: '🎥', label: 'HD Streaming', desc: 'Up to 1080p' },
                { icon: '🔒', label: 'Private Links', desc: 'Share securely' },
                { icon: '⚡', label: 'Low Latency', desc: 'Real-time video' },
                { icon: '📱', label: 'Any Device', desc: 'Watch anywhere' },
              ].map((f) => (
                <div key={f.label} className="text-center">
                  <div className="text-3xl mb-2">{f.icon}</div>
                  <div className="text-white font-medium text-sm">{f.label}</div>
                  <div className="text-white/40 text-xs">{f.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="px-4 py-6 border-t border-white/10 text-center">
          <p className="text-white/30 text-xs">Built with WebRTC • Peer-to-peer streaming</p>
        </footer>
      </div>
    );
  };

  return (
    <>
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        .spin {
          animation: spin 0.8s linear infinite;
        }
        @keyframes live-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        .live-dot {
          animation: live-pulse 1.5s ease-in-out infinite;
        }
        ::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: #4d4d4dff;
          border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #161616ff;
        }
        * {
          scrollbar-width: thin;
          scrollbar-color: #4d4d4dff transparent;
        }
      `}</style>
      {renderView()}
    </>
  );
};

export default App;