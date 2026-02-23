import React, { useEffect, useState, useRef, useCallback } from 'react';

declare const Peer: any;

interface ViewerPageProps { streamId: string; }

const PEER_PREFIX = 'ss-';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',              username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',             username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const MAX_RETRIES = 8;

type Status = 'connecting' | 'live' | 'ended' | 'retrying';

const QUALITY_OPTIONS = [
  { label: 'Auto',  height: 0 },
  { label: '1080p', height: 1080 },
  { label: '720p',  height: 720 },
  { label: '480p',  height: 480 },
  { label: '360p',  height: 360 },
  { label: '240p',  height: 240 },
];

const ViewerPage: React.FC<ViewerPageProps> = ({ streamId }) => {
  const [status, setStatus]         = useState<Status>('connecting');
  const [errorMsg, setErrorMsg]     = useState('');
  const [retryIn, setRetryIn]       = useState(0);
  const [retryCount, setRetryCount] = useState(0);

  const [playing, setPlaying]       = useState(false);
  const [muted, setMuted]           = useState(false);
  const [volume, setVolume]         = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [theaterMode, setTheaterMode] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [hasVideo, setHasVideo]     = useState(false);
  const [hasAudio, setHasAudio]     = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [resolution, setResolution] = useState('');
  const [liveTime, setLiveTime]     = useState(0);
  const [networkQuality, setNetworkQuality] = useState<'good'|'fair'|'poor'>('good');
  const [quality, setQuality]       = useState(QUALITY_OPTIONS[0]);
  const [pip, setPip]               = useState(false);
  const [pipSupport]                = useState(() => typeof document !== 'undefined' && 'pictureInPictureEnabled' in document);

  const containerRef   = useRef<HTMLDivElement>(null);
  const videoRef       = useRef<HTMLVideoElement>(null);
  const peerRef        = useRef<any>(null);
  const connRef        = useRef<any>(null);   // data connection for registration
  const callRef        = useRef<any>(null);
  const controlsTimer  = useRef<number | null>(null);
  const mounted        = useRef(true);
  const statusRef      = useRef<Status>('connecting');
  const retriesRef     = useRef(0);
  const retryTimer     = useRef<number | null>(null);
  const countdownTimer = useRef<number | null>(null);
  const statsTimer     = useRef<number | null>(null);
  const liveTimer      = useRef<number | null>(null);
  const liveStart      = useRef(0);
  const audioCtx       = useRef<AudioContext | null>(null);
  const audioAnim      = useRef<number | null>(null);
  const adminPeerId    = `${PEER_PREFIX}${streamId}`;

  const setSt = (s: Status) => { statusRef.current = s; if (mounted.current) setStatus(s); };

  // ── Audio monitoring ───────────────────────────────────────────────────────
  const startAudio = useCallback((stream: MediaStream) => {
    if (!stream.getAudioTracks().length) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtx.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 128; an.smoothingTimeConstant = 0.85;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
        if (mounted.current) setAudioLevel(avg);
        audioAnim.current = requestAnimationFrame(tick);
      };
      audioAnim.current = requestAnimationFrame(tick);
    } catch {}
  }, []);

  const stopAudio = useCallback(() => {
    if (audioAnim.current) { cancelAnimationFrame(audioAnim.current); audioAnim.current = null; }
    if (audioCtx.current) { audioCtx.current.close().catch(() => {}); audioCtx.current = null; }
    setAudioLevel(0);
  }, []);

  // ── Cleanup ─────────────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    stopAudio();
    [retryTimer, countdownTimer, statsTimer, liveTimer, controlsTimer].forEach(r => {
      if (r.current) { clearTimeout(r.current as any); clearInterval(r.current as any); r.current = null; }
    });
    if (callRef.current) { try { callRef.current.close(); } catch {} callRef.current = null; }
    if (connRef.current) { try { connRef.current.close(); } catch {} connRef.current = null; }
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {} peerRef.current = null; }
    if (videoRef.current) { videoRef.current.srcObject = null; }
    setHasVideo(false); setHasAudio(false);
  }, [stopAudio]);

  // ── Schedule retry ──────────────────────────────────────────────────────
  const scheduleRetry = useCallback((connectFn: () => void) => {
    const attempt = retriesRef.current;
    if (attempt >= MAX_RETRIES) { setSt('ended'); setErrorMsg('Stream not found or connection failed after multiple attempts.'); return; }
    const delay = Math.min(2000 * Math.pow(1.5, attempt), 20000);
    const secs = Math.ceil(delay / 1000);
    setRetryIn(secs); setSt('retrying');
    if (countdownTimer.current) clearInterval(countdownTimer.current);
    countdownTimer.current = window.setInterval(() => setRetryIn(p => { if (p <= 1) { clearInterval(countdownTimer.current!); return 0; } return p - 1; }), 1000);
    retryTimer.current = window.setTimeout(() => { if (mounted.current) connectFn(); }, delay);
  }, []);

  // ── Core connect ──────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!mounted.current) return;
    cleanup();
    retriesRef.current++;
    setRetryCount(retriesRef.current);
    setSt('connecting');
    setErrorMsg('');

    const viewerId = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    let peer: any;
    try {
      peer = new Peer(viewerId, {
        config: { iceServers: ICE_SERVERS, iceTransportPolicy: 'all', iceCandidatePoolSize: 12 },
        debug: 0,
      });
    } catch (e) {
      console.error('[Viewer] Peer init failed:', e);
      scheduleRetry(connect); return;
    }
    peerRef.current = peer;

    // Timeout if peer doesn't open
    const openTimeout = window.setTimeout(() => {
      if (statusRef.current === 'connecting' && mounted.current) {
        console.warn('[Viewer] Peer open timeout'); scheduleRetry(connect);
      }
    }, 15000);

    peer.on('open', () => {
      clearTimeout(openTimeout);
      if (!mounted.current) { peer.destroy(); return; }
      console.log('[Viewer] Peer open. Registering with admin…');

      // Step 1: Connect via data channel to admin — this triggers admin to call us back
      try {
        const conn = peer.connect(adminPeerId, { reliable: true, serialization: 'json' });
        connRef.current = conn;

        const connTimeout = window.setTimeout(() => {
          if (statusRef.current === 'connecting' && mounted.current) {
            console.warn('[Viewer] Data conn timeout'); scheduleRetry(connect);
          }
        }, 12000);

        conn.on('open', () => {
          clearTimeout(connTimeout);
          console.log('[Viewer] Registered with admin. Waiting for call…');
          // Send registration message
          try { conn.send({ type: 'register', viewerId }); } catch {}
        });

        conn.on('error', (e: any) => {
          clearTimeout(connTimeout); console.warn('[Viewer] Data conn error:', e);
          if (mounted.current && statusRef.current !== 'live') scheduleRetry(connect);
        });

        conn.on('close', () => {
          clearTimeout(connTimeout);
          if (mounted.current && statusRef.current === 'live') {
            console.log('[Viewer] Admin data conn closed'); scheduleRetry(connect);
          }
        });
      } catch (e) {
        console.error('[Viewer] connect() failed:', e); scheduleRetry(connect);
      }

      // Step 2: Wait for admin to call us with the stream
      peer.on('call', (call: any) => {
        console.log('[Viewer] Receiving call from admin');
        callRef.current = call;

        // Answer with empty stream (we only receive)
        call.answer(new MediaStream());

        const streamTimeout = window.setTimeout(() => {
          if (statusRef.current === 'connecting' && mounted.current) {
            console.warn('[Viewer] No stream received'); scheduleRetry(connect);
          }
        }, 15000);

        call.on('stream', (remoteStream: MediaStream) => {
          clearTimeout(streamTimeout);
          if (!mounted.current) return;

          const vt = remoteStream.getVideoTracks();
          const at = remoteStream.getAudioTracks();
          console.log(`[Viewer] Stream received! video:${vt.length} audio:${at.length}`);

          setHasVideo(vt.length > 0);
          setHasAudio(at.length > 0);

          if (!vt.length && !at.length) {
            console.warn('[Viewer] Empty stream, retrying…'); scheduleRetry(connect); return;
          }

          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;
            videoRef.current.play()
              .then(() => {
                if (!mounted.current) return;
                setPlaying(true); setSt('live');
                retriesRef.current = 0; setRetryCount(0);
                liveStart.current = Date.now();
                liveTimer.current = window.setInterval(() => {
                  if (mounted.current) setLiveTime(Math.floor((Date.now() - liveStart.current) / 1000));
                }, 1000);
                // Stats
                statsTimer.current = window.setInterval(() => {
                  const v = videoRef.current; if (!v) return;
                  if (v.videoWidth) setResolution(`${v.videoWidth}×${v.videoHeight}`);
                  if (v.buffered.length) {
                    const ahead = v.buffered.end(v.buffered.length - 1) - v.currentTime;
                    setNetworkQuality(ahead < 0.3 ? 'poor' : ahead < 1.5 ? 'fair' : 'good');
                  }
                }, 2000);
              })
              .catch(err => {
                console.warn('[Viewer] Autoplay blocked:', err);
                setSt('live'); setPlaying(false);
              });
          }

          if (at.length) startAudio(remoteStream);

          // Watch for stream ending
          vt.forEach(t => t.addEventListener('ended', () => {
            if (mounted.current && statusRef.current === 'live') { setSt('ended'); setErrorMsg('Broadcast has ended'); cleanup(); }
          }));

          // Connection health monitoring
          const pc = call.peerConnection;
          if (pc) {
            pc.addEventListener('connectionstatechange', () => {
              if (!mounted.current) return;
              const st = pc.connectionState;
              console.log('[Viewer] PC state:', st);
              if (st === 'failed' && statusRef.current === 'live') scheduleRetry(connect);
              else if (st === 'disconnected') setNetworkQuality('poor');
              else if (st === 'connected') setNetworkQuality('good');
            });
          }
        });

        call.on('close', () => {
          clearTimeout(streamTimeout);
          if (mounted.current && statusRef.current === 'live') { setSt('ended'); setErrorMsg('Broadcast ended'); cleanup(); }
        });

        call.on('error', (e: any) => {
          clearTimeout(streamTimeout);
          console.warn('[Viewer] Call error:', e);
          if (mounted.current && statusRef.current !== 'ended') scheduleRetry(connect);
        });
      });
    });

    peer.on('error', (err: any) => {
      clearTimeout(openTimeout);
      console.warn('[Viewer] Peer error:', err.type);
      if (!mounted.current) return;
      if (err.type === 'peer-unavailable') {
        // Admin peer not up yet — retry
        scheduleRetry(connect);
      } else if (err.type === 'unavailable-id') {
        // Our viewer ID collision — retry immediately with new ID
        setTimeout(() => { retriesRef.current--; connect(); }, 100);
      } else {
        scheduleRetry(connect);
      }
    });

    peer.on('disconnected', () => {
      if (mounted.current && statusRef.current === 'live') { setNetworkQuality('poor'); scheduleRetry(connect); }
    });
  }, [adminPeerId, cleanup, scheduleRetry, startAudio]);

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    mounted.current = true;
    retriesRef.current = 0;
    connect();
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    const onPipIn = () => setPip(true);
    const onPipOut = () => setPip(false);
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('enterpictureinpicture', onPipIn);
    document.addEventListener('leavepictureinpicture', onPipOut);
    return () => {
      mounted.current = false;
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('enterpictureinpicture', onPipIn);
      document.removeEventListener('leavepictureinpicture', onPipOut);
      cleanup();
    };
  }, []); // eslint-disable-line

  // ── Video events ──────────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const onPlay    = () => mounted.current && setPlaying(true);
    const onPause   = () => mounted.current && setPlaying(false);
    const onVolume  = () => { setMuted(v.muted); setVolume(v.volume); };
    const onWait    = () => mounted.current && setIsBuffering(true);
    const onPlay2   = () => { mounted.current && setIsBuffering(false); if (statusRef.current !== 'live') setSt('live'); };
    const onErr     = () => { if (mounted.current && statusRef.current === 'live') scheduleRetry(connect); };
    v.addEventListener('play', onPlay); v.addEventListener('pause', onPause);
    v.addEventListener('volumechange', onVolume); v.addEventListener('waiting', onWait);
    v.addEventListener('playing', onPlay2); v.addEventListener('error', onErr);
    return () => {
      v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause);
      v.removeEventListener('volumechange', onVolume); v.removeEventListener('waiting', onWait);
      v.removeEventListener('playing', onPlay2); v.removeEventListener('error', onErr);
    };
  }, [connect, scheduleRetry]);

  // ── Keyboard shortcuts ───────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'KeyM') toggleMute();
      if (e.code === 'KeyF') toggleFullscreen();
      if (e.code === 'KeyT') setTheaterMode(p => !p);
      if (e.code === 'KeyI' && pipSupport) togglePip();
      if (e.code === 'ArrowUp') { e.preventDefault(); setVol(Math.min(1, volume + 0.1)); }
      if (e.code === 'ArrowDown') { e.preventDefault(); setVol(Math.max(0, volume - 0.1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [volume, pipSupport]); // eslint-disable-line

  // ── Controls ──────────────────────────────────────────────────────────────
  const togglePlay = useCallback(() => { const v = videoRef.current; if (!v) return; v.paused ? v.play().catch(() => {}) : v.pause(); }, []);
  const toggleMute = useCallback(() => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); }, []);
  const setVol = useCallback((val: number) => {
    const v = videoRef.current; if (!v) return;
    const n = Math.max(0, Math.min(1, val)); v.volume = n; v.muted = n === 0; setVolume(n); setMuted(n === 0);
  }, []);
  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try { if (!document.fullscreenElement) await containerRef.current.requestFullscreen(); else await document.exitFullscreen(); } catch {}
  }, []);
  const togglePip = useCallback(async () => {
    if (!videoRef.current) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await (videoRef.current as any).requestPictureInPicture(); } catch {}
  }, []);
  const changeRate = useCallback((r: number) => { const v = videoRef.current; if (v) v.playbackRate = r; setPlaybackRate(r); setShowSettings(false); }, []);
  const resetControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => { setShowControls(false); setShowVolume(false); setShowSettings(false); }, 3500);
  }, []);

  const fmt = (s: number) => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`; };
  const p2 = (n: number) => n.toString().padStart(2, '0');
  const volPct = (muted ? 0 : volume) * 100;

  // ── Ended screen ──────────────────────────────────────────────────────────
  if (status === 'ended') {
    return (
      <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center p-6" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
        <div className="max-w-sm w-full text-center space-y-6">
          <div className="text-6xl">📺</div>
          <div>
            <h2 className="text-2xl font-bold text-white">Stream Ended</h2>
            <p className="text-white/40 mt-2 text-sm">{errorMsg || 'The broadcast has ended'}</p>
          </div>
          <div className="flex items-center justify-center gap-3">
            <button onClick={() => { retriesRef.current = 0; connect(); }} className="px-6 py-2.5 bg-white/10 text-white border border-white/20 rounded-full text-sm font-medium hover:bg-white/15 transition-colors">
              Try Reconnect
            </button>
            <button onClick={() => window.location.hash = '#/'} className="px-6 py-2.5 bg-red-600 text-white rounded-full text-sm font-medium hover:bg-red-700 transition-colors">
              Go Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Player ────────────────────────────────────────────────────────────────
  return (
    <div className="bg-black min-h-screen flex flex-col" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div
        ref={containerRef}
        className={`relative bg-black ${fullscreen ? 'fixed inset-0 z-50' : theaterMode ? 'w-full' : 'w-full'}`}
        style={{ aspectRatio: fullscreen ? undefined : '16/9' }}
        onMouseMove={resetControls}
        onMouseLeave={() => { if (controlsTimer.current) clearTimeout(controlsTimer.current); controlsTimer.current = window.setTimeout(() => { setShowControls(false); setShowVolume(false); setShowSettings(false); }, 1200); }}
        onDoubleClick={toggleFullscreen}
      >
        {/* Video */}
        <video ref={videoRef} className="w-full h-full object-contain bg-black" playsInline onClick={() => { resetControls(); if (status === 'live') togglePlay(); }}/>

        {/* Connecting / retrying overlay */}
        {(status === 'connecting' || status === 'retrying') && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f0f0f]">
            <div className="text-center space-y-4 px-6 max-w-sm">
              <div className="w-16 h-16 mx-auto relative">
                <div className="absolute inset-0 border-4 border-white/10 rounded-full"/>
                <div className="absolute inset-0 border-4 border-t-red-500 border-r-transparent border-b-transparent border-l-transparent rounded-full spin"/>
              </div>
              <div>
                <p className="text-white font-semibold text-lg">
                  {status === 'retrying' ? 'Reconnecting…' : 'Connecting to stream…'}
                </p>
                <p className="text-white/40 text-sm mt-1">
                  {status === 'retrying'
                    ? `Retrying in ${retryIn}s (${retryCount}/${MAX_RETRIES})`
                    : 'Establishing secure P2P connection'
                  }
                </p>
              </div>
              <p className="text-white/20 text-xs font-mono">{streamId.slice(0,10)}…</p>
              {status === 'retrying' && (
                <button onClick={() => { if (retryTimer.current) clearTimeout(retryTimer.current); if (countdownTimer.current) clearInterval(countdownTimer.current); retriesRef.current = Math.max(0, retriesRef.current - 1); connect(); }}
                  className="px-5 py-2 bg-white/10 hover:bg-white/15 rounded-full text-white text-sm transition-colors border border-white/10">
                  Retry Now
                </button>
              )}
            </div>
          </div>
        )}

        {/* Buffering */}
        {isBuffering && status === 'live' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full spin"/>
          </div>
        )}

        {/* Play button overlay */}
        {hasVideo && !playing && !isBuffering && status === 'live' && (
          <div className="absolute inset-0 flex items-center justify-center cursor-pointer" onClick={e => { e.stopPropagation(); togglePlay(); }}>
            <div className="w-20 h-20 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center hover:bg-black/80 transition-all border border-white/20 hover:scale-105" style={{ transition: 'transform 0.15s' }}>
              <svg className="w-10 h-10 text-white ml-1" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </div>
          </div>
        )}

        {/* Network warning */}
        {status === 'live' && networkQuality !== 'good' && (
          <div className={`absolute top-14 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-semibold ${networkQuality === 'poor' ? 'bg-red-600/90 text-white' : 'bg-yellow-500/90 text-black'}`}>
            ⚠ {networkQuality === 'poor' ? 'Poor connection' : 'Unstable'}
          </div>
        )}

        {/* Controls */}
        <div className={`absolute inset-0 flex flex-col justify-between transition-opacity duration-300 ${showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
          style={{ background: showControls || !playing ? 'linear-gradient(to top, rgba(0,0,0,0.9) 0%, transparent 40%, rgba(0,0,0,0.4) 100%)' : 'none' }}>

          {/* Top bar */}
          <div className="p-3 flex items-center gap-2">
            {status === 'live' && <>
              <span className="flex items-center gap-1.5 px-2.5 py-1 bg-red-600 rounded-full">
                <span className="w-1.5 h-1.5 bg-white rounded-full live-dot"/>
                <span className="text-white text-xs font-bold">LIVE</span>
              </span>
              <span className="px-2.5 py-1 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white font-mono">{fmt(liveTime)}</span>
              {resolution && <span className="hidden sm:block px-2.5 py-1 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white/60">{resolution}</span>}
            </>}
            <button onClick={e => { e.stopPropagation(); window.location.hash = '#/'; }} className="ml-auto p-2 bg-black/40 backdrop-blur-sm rounded-full hover:bg-black/60 transition-colors">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/></svg>
            </button>
          </div>

          {/* Bottom controls */}
          <div className="p-3 space-y-2" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-1.5">

              {/* Play */}
              <button onClick={togglePlay} className="text-white p-1.5 hover:opacity-80 transition-opacity">
                {playing
                  ? <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                  : <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                }
              </button>

              {/* Volume */}
              <div className="relative flex items-center" onMouseEnter={() => setShowVolume(true)} onMouseLeave={() => setShowVolume(false)}>
                <button onClick={toggleMute} className="text-white p-1.5 hover:opacity-80 transition-opacity">
                  {muted || volume === 0
                    ? <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                    : volume < 0.5
                    ? <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>
                    : <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                  }
                </button>
                {showVolume && (
                  <div className="flex items-center gap-2 ml-1">
                    <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume}
                      onChange={e => setVol(parseFloat(e.target.value))}
                      className="volume-slider w-20 sm:w-28"
                      style={{ background: `linear-gradient(to right, white ${volPct}%, rgba(255,255,255,0.25) ${volPct}%)` }}/>
                    <span className="text-white/50 text-xs w-7 font-mono">{Math.round(volPct)}%</span>
                  </div>
                )}
              </div>

              {/* Audio bars */}
              {hasAudio && playing && (
                <div className="hidden sm:flex items-end gap-0.5 h-5 ml-1">
                  {[0.15, 0.35, 0.55, 0.75, 0.55, 0.35, 0.15].map((t, i) => (
                    <div key={i} className={`w-0.5 rounded-full transition-all duration-75 ${audioLevel > t ? audioLevel > 0.8 ? 'bg-red-400' : 'bg-green-400' : 'bg-white/20'}`} style={{ height: `${30 + i * 8 + (i > 3 ? (6-i)*8 : 0)}%` }}/>
                  ))}
                </div>
              )}

              <div className="flex-1"/>

              {/* Theater mode */}
              <button onClick={() => setTheaterMode(p => !p)} title="Theater mode (T)" className="hidden sm:block p-1.5 text-white/70 hover:text-white transition-colors">
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  {theaterMode ? <path d="M22 7H2v10h20V7zm-2 8H4V9h16v6z"/> : <path d="M19 7H5c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm0 8H5V9h14v6z"/>}
                </svg>
              </button>

              {/* PiP */}
              {pipSupport && (
                <button onClick={togglePip} title="Picture in picture (I)" className="hidden sm:block p-1.5 text-white/70 hover:text-white transition-colors">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M19 7H5c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zm0 12H5V9h14v10zm-8-4h6v-4h-6v4z"/></svg>
                </button>
              )}

              {/* Settings */}
              <div className="relative">
                <button onClick={() => setShowSettings(p => !p)} className={`p-1.5 transition-colors ${showSettings ? 'text-white' : 'text-white/70 hover:text-white'}`}>
                  <svg className={`w-5 h-5 transition-transform duration-300 ${showSettings ? 'rotate-45' : ''}`} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
                  </svg>
                </button>

                {showSettings && (
                  <div className="absolute bottom-full right-0 mb-2 w-56 bg-[#1c1c1c] rounded-2xl shadow-2xl border border-white/10 overflow-hidden scale-in">
                    {/* Quality */}
                    <div className="px-4 py-2.5 text-xs font-bold text-white/40 uppercase tracking-wider border-b border-white/10">Quality</div>
                    <div className="p-2 space-y-0.5">
                      {QUALITY_OPTIONS.map(q => (
                        <button key={q.label} onClick={() => { setQuality(q); setShowSettings(false); }}
                          className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-sm transition-colors ${quality.label === q.label ? 'bg-red-600 text-white font-semibold' : 'text-white/60 hover:bg-white/8 hover:text-white'}`}>
                          <span>{q.label}</span>
                          {q.height >= 720 && <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${quality.label === q.label ? 'bg-white/20 text-white' : 'bg-white/10 text-white/40'}`}>HD</span>}
                        </button>
                      ))}
                    </div>

                    {/* Playback speed */}
                    <div className="px-4 py-2.5 text-xs font-bold text-white/40 uppercase tracking-wider border-t border-white/10">Speed</div>
                    <div className="grid grid-cols-3 gap-1 p-2">
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => (
                        <button key={r} onClick={() => changeRate(r)} className={`py-1.5 text-xs rounded-lg font-semibold transition-colors ${playbackRate === r ? 'bg-red-600 text-white' : 'text-white/50 hover:bg-white/8 hover:text-white'}`}>
                          {r === 1 ? 'Normal' : `${r}×`}
                        </button>
                      ))}
                    </div>

                    {/* Shortcuts */}
                    <div className="px-4 pt-2 pb-3 border-t border-white/10">
                      <p className="text-[10px] font-bold text-white/30 uppercase tracking-wider mb-1.5">Shortcuts</p>
                      {[['Space','Play'],['M','Mute'],['F','Fullscreen'],['T','Theater'],['↑↓','Volume']].map(([k,l]) => (
                        <div key={k} className="flex justify-between text-xs py-0.5">
                          <span className="text-white/35">{l}</span>
                          <kbd className="px-1.5 bg-white/10 rounded text-white/50 font-mono">{k}</kbd>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Fullscreen */}
              <button onClick={toggleFullscreen} className="p-1.5 text-white/70 hover:text-white transition-colors">
                {fullscreen
                  ? <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M15 9h4.5M15 9V4.5M9 15v4.5M9 15H4.5M15 15h4.5M15 15v4.5"/></svg>
                  : <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4"/></svg>
                }
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Info strip */}
      {!fullscreen && (
        <div className="bg-[#0f0f0f] border-t border-white/5 px-4 py-2.5 flex items-center gap-3">
          <div className="w-7 h-7 bg-red-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 8l-6 4V7l6 4z"/></svg>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-white leading-none">Live Stream</p>
            <p className="text-xs text-white/30 font-mono mt-0.5 truncate">{streamId}</p>
          </div>
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            {status === 'live' && resolution && <span className="px-2 py-0.5 bg-white/5 rounded-full text-xs text-white/40">{resolution}</span>}
            {quality.label !== 'Auto' && <span className="px-2 py-0.5 bg-white/5 rounded-full text-xs text-white/40">{quality.label}</span>}
            {status === 'live' && (
              <span className="flex items-center gap-1.5 px-2 py-0.5 bg-red-900/30 rounded-full text-xs text-red-400">
                <span className="w-1 h-1 bg-red-500 rounded-full live-dot"/> {fmt(liveTime)}
              </span>
            )}
            {/* Signal bars */}
            <div className="flex items-end gap-0.5">
              {[2, 3.5, 5].map((h, i) => (
                <div key={i} style={{ height: `${h * 3}px`, width: '4px' }} className={`rounded-sm ${
                  networkQuality === 'good' ? 'bg-green-500' :
                  networkQuality === 'fair' && i < 2 ? 'bg-yellow-400' :
                  networkQuality === 'poor' && i === 0 ? 'bg-red-500' : 'bg-white/15'
                }`}/>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ViewerPage;
