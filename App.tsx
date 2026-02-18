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
      <div className="min-h-screen bg-white flex items-center justify-center p-4">
        <div className="max-w-md w-full">
          {/* Header */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 bg-gray-900 rounded-full mb-4">
              <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h1 className="text-3xl font-bold text-gray-900">StreamStudios</h1>
            <p className="text-gray-500 mt-2">Simple, secure live broadcasting</p>
          </div>

          {/* CTA */}
          <div className="space-y-3">
            <button
              onClick={() => {
                window.location.hash = '#/admin';
              }}
              className="w-full py-3 bg-gray-900 text-white font-medium rounded-full hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-700"
              type="button"
            >
              Open Broadcast Studio
            </button>
            <p className="text-xs text-gray-400 text-center">No account needed • Private streaming links</p>
          </div>

          {/* Features */}
          <div className="grid grid-cols-3 gap-4 mt-8 pt-8 border-t border-gray-100">
            {[
              { icon: '🔗', label: 'Private Links' },
              { icon: '🔒', label: 'Encrypted' },
              { icon: '📱', label: 'Cross-device' },
            ].map((f) => (
              <div key={f.label} className="text-center">
                <div className="text-2xl mb-1">{f.icon}</div>
                <div className="text-xs font-medium text-gray-700">{f.label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <style>{`
        /* Custom scrollbar from index.html */
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
        /* Firefox */
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