import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StreamMode, Resolution } from '../types';

declare const Peer: any;

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

const RESOLUTIONS: Resolution[] = [
  { width: 426,  height: 240,  label: '240p',       frameRate: 30 },
  { width: 640,  height: 360,  label: '360p',       frameRate: 30 },
  { width: 854,  height: 480,  label: '480p',       frameRate: 30 },
  { width: 1280, height: 720,  label: '720p HD',    frameRate: 30 },
  { width: 1280, height: 720,  label: '720p 60fps', frameRate: 60 },
  { width: 1920, height: 1080, label: '1080p FHD',  frameRate: 30 },
];

interface ViewerInfo { id: string; joinedAt: number; callState: string; }

const AdminPanel: React.FC = () => {
  const [mode, setMode]             = useState<StreamMode>(StreamMode.IDLE);
  const [streamTitle, setStreamTitle] = useState('My Live Stream');
  const [editTitle, setEditTitle]   = useState(false);
  const [streamUrl, setStreamUrl]   = useState('');
  const [copied, setCopied]         = useState(false);
  const [error, setError]           = useState('');
  const [activeTab, setActiveTab]   = useState<'source'|'settings'|'viewers'>('source');

  const [videoDevices, setVideoDevices] = useState<{deviceId:string;label:string}[]>([]);
  const [audioDevices, setAudioDevices] = useState<{deviceId:string;label:string}[]>([]);
  const [selectedVideo, setSelectedVideo] = useState('');
  const [selectedAudio, setSelectedAudio] = useState('');
  const [selectedRes, setSelectedRes] = useState<Resolution>(RESOLUTIONS[3]);

  const [streamDuration, setStreamDuration] = useState(0);
  const [hasAudio, setHasAudio]   = useState(false);
  const [micOn, setMicOn]         = useState(true);
  const [camOn, setCamOn]         = useState(true);
  const [uploadName, setUploadName] = useState('');
  const [uploading, setUploading] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [peakLevel, setPeakLevel] = useState(0);
  const [peerStatus, setPeerStatus] = useState<'idle'|'connecting'|'ready'|'error'>('idle');
  const [viewers, setViewers]     = useState<Map<string, ViewerInfo>>(new Map());

  const videoRef      = useRef<HTMLVideoElement>(null);
  const streamRef     = useRef<MediaStream | null>(null);
  const peerRef       = useRef<any>(null);
  const callsRef      = useRef<Map<string, any>>(new Map());
  const fileVideoRef  = useRef<HTMLVideoElement | null>(null);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const durationRef   = useRef<number | null>(null);
  const startTimeRef  = useRef(0);
  const audioCtxRef   = useRef<AudioContext | null>(null);
  const audioAnimRef  = useRef<number | null>(null);
  const peakDecayRef  = useRef(0);

  // ── Devices ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
          .then(s => s.getTracks().forEach(t => t.stop())).catch(() => {});
        const devs = await navigator.mediaDevices.enumerateDevices();
        const v = devs.filter(d => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i+1}` }));
        const a = devs.filter(d => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Mic ${i+1}` }));
        setVideoDevices(v); setAudioDevices(a);
        if (v.length) setSelectedVideo(x => x || v[0].deviceId);
        if (a.length) setSelectedAudio(x => x || a[0].deviceId);
      } catch {}
    };
    navigator.mediaDevices.addEventListener('devicechange', load);
    load();
    return () => navigator.mediaDevices.removeEventListener('devicechange', load);
  }, []);

  // ── Duration ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== StreamMode.IDLE) {
      startTimeRef.current = Date.now();
      durationRef.current = window.setInterval(() =>
        setStreamDuration(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    } else {
      if (durationRef.current) clearInterval(durationRef.current);
      setStreamDuration(0);
    }
    return () => { if (durationRef.current) clearInterval(durationRef.current); };
  }, [mode]);

  // ── Audio meter ───────────────────────────────────────────────────────────
  const startMeter = useCallback((stream: MediaStream) => {
    if (!stream.getAudioTracks().length) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 256; an.smoothingTimeConstant = 0.8;
      src.connect(an);
      const buf = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        an.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
        setAudioLevel(avg);
        if (avg > peakDecayRef.current) { peakDecayRef.current = avg; setPeakLevel(avg); }
        else { peakDecayRef.current = Math.max(0, peakDecayRef.current - 0.003); setPeakLevel(peakDecayRef.current); }
        audioAnimRef.current = requestAnimationFrame(tick);
      };
      audioAnimRef.current = requestAnimationFrame(tick);
    } catch {}
  }, []);

  const stopMeter = useCallback(() => {
    if (audioAnimRef.current) { cancelAnimationFrame(audioAnimRef.current); audioAnimRef.current = null; }
    if (audioCtxRef.current) { audioCtxRef.current.close(); audioCtxRef.current = null; }
    setAudioLevel(0); setPeakLevel(0); peakDecayRef.current = 0;
  }, []);

  // ── Peer ─────────────────────────────────────────────────────────────────
  const destroyPeer = useCallback(() => {
    callsRef.current.forEach(c => { try { c.close(); } catch {} });
    callsRef.current.clear();
    if (peerRef.current) { try { peerRef.current.destroy(); } catch {} peerRef.current = null; }
    setViewers(new Map()); setPeerStatus('idle');
  }, []);

  /**
   * KEY FIX: Admin calls the viewer — not the other way around.
   * This is the correct WebRTC broadcast pattern.
   */
  const callViewer = useCallback((viewerPeerId: string, stream: MediaStream) => {
    if (!peerRef.current || peerRef.current.destroyed) return;
    try {
      console.log('[Admin] Calling viewer:', viewerPeerId);
      const call = peerRef.current.call(viewerPeerId, stream);
      if (!call) { console.warn('[Admin] call() returned null'); return; }

      callsRef.current.set(viewerPeerId, call);
      setViewers(prev => new Map(prev).set(viewerPeerId, { id: viewerPeerId, joinedAt: Date.now(), callState: 'connecting' }));

      call.peerConnection?.addEventListener('connectionstatechange', () => {
        const state = call.peerConnection?.connectionState ?? 'unknown';
        setViewers(prev => { const n = new Map(prev); const v = n.get(viewerPeerId); if (v) n.set(viewerPeerId, { ...v, callState: state }); return n; });
      });

      call.on('close', () => {
        callsRef.current.delete(viewerPeerId);
        setViewers(prev => { const n = new Map(prev); n.delete(viewerPeerId); return n; });
      });
      call.on('error', () => {
        callsRef.current.delete(viewerPeerId);
        setViewers(prev => { const n = new Map(prev); n.delete(viewerPeerId); return n; });
      });
    } catch (e) { console.error('[Admin] callViewer error:', e); }
  }, []);

  const createPeer = useCallback((id: string, stream: MediaStream) => {
    destroyPeer();
    setPeerStatus('connecting');
    const peer = new Peer(`${PEER_PREFIX}${id}`, {
      config: { iceServers: ICE_SERVERS, iceTransportPolicy: 'all', iceCandidatePoolSize: 10 },
      debug: 0,
    });
    peerRef.current = peer;

    peer.on('open', () => { setPeerStatus('ready'); console.log('[Admin] Peer ready'); });

    // Viewer connects via data channel to register → we call them back with stream
    peer.on('connection', (conn: any) => {
      console.log('[Admin] Viewer registering via data channel:', conn.peer);
      conn.on('open', () => {
        if (streamRef.current) callViewer(conn.peer, streamRef.current);
      });
    });

    peer.on('error', (err: any) => {
      console.error('[Admin] Peer error:', err.type);
      if (err.type === 'unavailable-id') {
        const newId = genId();
        setStreamUrl(`${window.location.origin}${window.location.pathname}#/viewer/${newId}`);
        setTimeout(() => { if (streamRef.current) createPeer(newId, streamRef.current); }, 500);
      } else if (err.type !== 'peer-unavailable') {
        setPeerStatus('error'); setError(`Connection error: ${err.type}`);
      }
    });

    peer.on('disconnected', () => { setPeerStatus('connecting'); try { peer.reconnect(); } catch {} });
  }, [destroyPeer, callViewer]);

  // ── Stream setup ──────────────────────────────────────────────────────────
  const setupStream = useCallback(async (stream: MediaStream, newMode: StreamMode, id: string) => {
    streamRef.current = stream;
    const gotAudio = stream.getAudioTracks().length > 0;
    setHasAudio(gotAudio);
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      try { await videoRef.current.play(); } catch {}
    }
    if (gotAudio) startMeter(stream);
    setMode(newMode);
    setStreamUrl(`${window.location.origin}${window.location.pathname}#/viewer/${id}`);
    setMicOn(true); setCamOn(true);
    createPeer(id, stream);
  }, [createPeer, startMeter]);

  const genId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const startCamera = async () => {
    try {
      setError('');
      streamRef.current?.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: selectedVideo ? { deviceId: { exact: selectedVideo }, width: { ideal: selectedRes.width }, height: { ideal: selectedRes.height }, frameRate: { ideal: selectedRes.frameRate ?? 30 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: selectedAudio ? { deviceId: { exact: selectedAudio }, echoCancellation: true, noiseSuppression: true }
          : { echoCancellation: true, noiseSuppression: true },
      });
      await setupStream(stream, StreamMode.LIVE, genId());
    } catch (e: any) {
      setError(e.name === 'NotAllowedError' ? 'Permission denied. Allow camera/mic in browser settings.' : e.message || 'Camera failed');
    }
  };

  const startScreen = async () => {
    try {
      setError('');
      streamRef.current?.getTracks().forEach(t => t.stop());
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
      try {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: selectedAudio ? { deviceId: { exact: selectedAudio } } : true });
        mic.getAudioTracks().forEach(t => display.addTrack(t));
      } catch {}
      display.getVideoTracks()[0].addEventListener('ended', () => stopStream());
      await setupStream(display, StreamMode.SCREEN, genId());
    } catch (e: any) { if (e.name !== 'NotAllowedError') setError('Screen share failed.'); }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    setUploading(true); setUploadName(file.name);
    try {
      streamRef.current?.getTracks().forEach(t => t.stop());
      const url = URL.createObjectURL(file);
      const vid = Object.assign(document.createElement('video'), { src: url, loop: true, muted: false, playsInline: true, crossOrigin: 'anonymous' });
      await new Promise((res, rej) => { vid.onloadedmetadata = res; vid.onerror = rej; setTimeout(() => rej(new Error('Timeout')), 15000); });
      await vid.play();
      // @ts-ignore
      const stream = vid.captureStream(30);
      fileVideoRef.current = vid;
      await setupStream(stream, StreamMode.FILE_UPLOAD, genId());
    } catch (err: any) { setError(`File error: ${err.message}`); }
    finally { setUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const stopStream = useCallback(() => {
    stopMeter(); destroyPeer();
    streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null;
    if (fileVideoRef.current) { fileVideoRef.current.pause(); URL.revokeObjectURL(fileVideoRef.current.src); fileVideoRef.current = null; }
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.srcObject = null; }
    setMode(StreamMode.IDLE); setStreamUrl(''); setUploadName(''); setHasAudio(false); setMicOn(true); setCamOn(true);
  }, [destroyPeer, stopMeter]);

  const toggleMic = () => { streamRef.current?.getAudioTracks().forEach(t => { t.enabled = !micOn; }); setMicOn(p => !p); };
  const toggleCam = () => { streamRef.current?.getVideoTracks().forEach(t => { t.enabled = !camOn; }); setCamOn(p => !p); };

  const fmt = (s: number) => { const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60; return h ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`; };
  const p2 = (n: number) => n.toString().padStart(2, '0');
  const copyLink = () => { navigator.clipboard.writeText(streamUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2500); }); };
  const isLive = mode !== StreamMode.IDLE;
  const BARS = 24;

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>

      {/* Header */}
      <header className="h-12 border-b border-white/10 bg-[#111] flex items-center px-4 gap-4 flex-shrink-0 z-10">
        <button onClick={() => window.location.hash = '#/'} className="flex items-center gap-2 hover:opacity-75 transition-opacity">
          <div className="w-7 h-7 bg-red-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 8l-6 4V7l6 4z"/>
            </svg>
          </div>
          <span className="font-bold text-sm hidden sm:block">StreamStudio</span>
        </button>
        <span className="text-white/20 hidden sm:block">|</span>
        {editTitle
          ? <input autoFocus value={streamTitle} onChange={e => setStreamTitle(e.target.value)} onBlur={() => setEditTitle(false)} onKeyDown={e => e.key === 'Enter' && setEditTitle(false)} className="hidden sm:block bg-white/10 border border-white/20 rounded px-2 py-0.5 text-sm outline-none w-44"/>
          : <button onClick={() => setEditTitle(true)} className="hidden sm:flex items-center gap-1.5 text-sm text-white/60 hover:text-white transition-colors">
              {streamTitle}
              <svg className="w-3 h-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4z" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
        }
        <div className="flex items-center gap-2 ml-auto">
          {isLive && <>
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-white/5 rounded-full border border-white/10 text-xs text-white/50">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full live-dot"/> {fmt(streamDuration)}
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-white/5 rounded-full border border-white/10 text-xs text-white/50">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
              {viewers.size}
            </div>
            <span className={`px-2 py-1 rounded-full text-xs font-mono ${peerStatus === 'ready' ? 'text-green-400 bg-green-400/10' : peerStatus === 'connecting' ? 'text-yellow-400 bg-yellow-400/10' : 'text-red-400 bg-red-400/10'}`}>
              {peerStatus === 'ready' ? '● Ready' : peerStatus === 'connecting' ? '◌ Connecting…' : '✕ Error'}
            </span>
            <button onClick={stopStream} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-full transition-colors">End</button>
          </>}
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">

        {/* Preview */}
        <div className="flex-1 flex flex-col gap-4 p-4 min-w-0">

          {/* Video */}
          <div className="relative rounded-xl overflow-hidden border border-white/10 bg-black" style={{ aspectRatio: '16/9' }}>
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-contain"/>
            {!isLive && !uploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0a0a0a]">
                <div className="w-14 h-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                  <svg className="w-7 h-7 text-white/15" viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-9 8l-6 4V7l6 4z"/></svg>
                </div>
                <p className="text-white/25 text-sm">Select a source to go live</p>
              </div>
            )}
            {uploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
                <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full spin"/>
                <p className="text-white/60 text-sm truncate max-w-xs">Loading {uploadName}…</p>
              </div>
            )}
            {isLive && (
              <div className="absolute top-3 left-3 flex items-center gap-2 flex-wrap">
                <span className="flex items-center gap-1.5 px-2.5 py-1 bg-red-600 rounded-md">
                  <span className="w-1.5 h-1.5 bg-white rounded-full live-dot"/>
                  <span className="text-white text-xs font-bold tracking-wider">LIVE</span>
                </span>
                <span className="px-2 py-1 bg-black/70 backdrop-blur-sm rounded-md text-xs text-white/80">
                  {mode === StreamMode.LIVE ? 'Camera' : mode === StreamMode.SCREEN ? 'Screen' : uploadName || 'File'}
                </span>
                {!micOn && <span className="px-2 py-1 bg-red-600/80 rounded-md text-xs text-white">Mic Off</span>}
                {!camOn && <span className="px-2 py-1 bg-red-600/80 rounded-md text-xs text-white">Cam Off</span>}
              </div>
            )}
          </div>

          {/* Audio meter + controls */}
          {isLive && (
            <div className="bg-[#181818] border border-white/10 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white/40 uppercase tracking-wider">Audio</span>
                {!hasAudio && <span className="text-xs text-yellow-500">No audio track</span>}
              </div>
              <div className="flex items-end gap-0.5 h-7">
                {Array.from({ length: BARS }).map((_, i) => {
                  const thr = i / BARS;
                  const active = audioLevel > thr;
                  const isPeak = Math.abs(peakLevel - thr) < 1/BARS;
                  return <div key={i} className={`flex-1 rounded-sm transition-all duration-75 ${active ? i > BARS*0.88 ? 'bg-red-500' : i > BARS*0.7 ? 'bg-yellow-400' : 'bg-green-500' : isPeak ? 'bg-white/50' : 'bg-white/8'}`} style={{ height: active ? `${Math.max(20, 20 + (i/BARS)*80)}%` : '15%' }}/>;
                })}
              </div>
              <div className="flex gap-2 pt-1 border-t border-white/10">
                <button onClick={toggleMic} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all ${micOn ? 'bg-white/8 text-white hover:bg-white/12' : 'bg-red-600/20 text-red-400 border border-red-600/30'}`}>
                  {micOn ? '🎤' : '🔇'} {micOn ? 'Mic On' : 'Mic Off'}
                </button>
                <button onClick={toggleCam} className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-all ${camOn ? 'bg-white/8 text-white hover:bg-white/12' : 'bg-red-600/20 text-red-400 border border-red-600/30'}`}>
                  {camOn ? '📷' : '🚫'} {camOn ? 'Cam On' : 'Cam Off'}
                </button>
              </div>
            </div>
          )}

          {/* Stream link */}
          {streamUrl && (
            <div className="bg-[#181818] border border-white/10 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-white/40 uppercase tracking-wider">Viewer Link</p>
                <span className="text-xs text-green-400 flex items-center gap-1"><span className="w-1.5 h-1.5 bg-green-500 rounded-full"/>Active</span>
              </div>
              <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 mb-3">
                <span className="flex-1 text-xs text-white/60 font-mono truncate">{streamUrl}</span>
              </div>
              <div className="flex gap-2">
                <button onClick={copyLink} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-semibold transition-all ${copied ? 'bg-green-600/20 text-green-400 border border-green-600/30' : 'bg-white/8 text-white hover:bg-white/12'}`}>
                  {copied ? '✓ Copied!' : '📋 Copy Link'}
                </button>
                <button onClick={() => window.open(streamUrl, '_blank')} className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold transition-colors">
                  ↗ Open Viewer
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-900/20 border border-red-800/40 rounded-xl p-4 flex items-start gap-3">
              <p className="text-sm text-red-400 flex-1">{error}</p>
              <button onClick={() => setError('')} className="text-red-400/60 hover:text-red-400 text-lg leading-none">×</button>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-full lg:w-72 xl:w-80 border-t lg:border-t-0 lg:border-l border-white/10 bg-[#141414] flex flex-col flex-shrink-0">
          <div className="flex border-b border-white/10 flex-shrink-0">
            {(['source', 'settings', 'viewers'] as const).map(t => (
              <button key={t} onClick={() => setActiveTab(t)} className={`flex-1 py-3 text-xs font-bold uppercase tracking-wider transition-colors relative ${activeTab === t ? 'text-white' : 'text-white/30 hover:text-white/60'}`}>
                {t === 'viewers' && viewers.size > 0 && <span className="absolute top-2 right-2 w-4 h-4 bg-red-600 rounded-full text-[10px] flex items-center justify-center">{viewers.size}</span>}
                {t}
                {activeTab === t && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600 rounded-full"/>}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">

            {/* SOURCE */}
            {activeTab === 'source' && <>
              <p className="text-xs font-bold text-white/30 uppercase tracking-wider">Broadcast Source</p>
              <div className="space-y-2">
                {[
                  { label: 'Camera', sub: `Webcam · ${selectedRes.label}`, icon: '📷', active: mode === StreamMode.LIVE, color: 'blue', onClick: startCamera },
                  { label: 'Screen Share', sub: 'Display + mic audio', icon: '🖥️', active: mode === StreamMode.SCREEN, color: 'green', onClick: startScreen },
                ].map(item => (
                  <button key={item.label} onClick={item.onClick} disabled={uploading}
                    className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left ${item.active ? `border-${item.color}-500 bg-${item.color}-500/10` : 'border-white/10 bg-white/5 hover:bg-white/8 hover:border-white/20'} ${uploading ? 'opacity-40 cursor-not-allowed' : ''}`}>
                    <span className="text-2xl">{item.icon}</span>
                    <div>
                      <p className="text-sm font-semibold text-white">{item.label}</p>
                      <p className="text-xs text-white/40">{item.sub}</p>
                    </div>
                    {item.active && <div className="ml-auto w-2 h-2 bg-green-500 rounded-full live-dot"/>}
                  </button>
                ))}

                <label className={`w-full flex items-center gap-3 p-3.5 rounded-xl border transition-all cursor-pointer ${mode === StreamMode.FILE_UPLOAD ? 'border-purple-500 bg-purple-500/10' : 'border-white/10 bg-white/5 hover:bg-white/8 hover:border-white/20'} ${uploading ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  <span className="text-2xl">{uploading ? '⏳' : '📁'}</span>
                  <div>
                    <p className="text-sm font-semibold text-white">Upload Video</p>
                    <p className="text-xs text-white/40">{uploadName || 'MP4, WebM, MOV'}</p>
                  </div>
                  {mode === StreamMode.FILE_UPLOAD && <div className="ml-auto w-2 h-2 bg-purple-500 rounded-full live-dot"/>}
                  <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFile} disabled={uploading}/>
                </label>
              </div>

              {isLive && (
                <button onClick={stopStream} className="w-full py-2.5 bg-red-600/15 text-red-400 border border-red-600/25 rounded-xl text-sm font-semibold hover:bg-red-600/25 transition-colors">
                  ⏹ End Stream
                </button>
              )}
              {!isLive && (
                <div className="p-4 bg-white/3 rounded-xl border border-white/8 space-y-2">
                  {[['🔴','Click a source above to start broadcasting'],['🔗','Share the viewer link with your audience'],['🔒','Direct P2P — no upload, no cloud storage']].map(([icon, text]) => (
                    <div key={text} className="flex items-start gap-2"><span>{icon}</span><p className="text-xs text-white/35 leading-relaxed">{text}</p></div>
                  ))}
                </div>
              )}
            </>}

            {/* SETTINGS */}
            {activeTab === 'settings' && <>
              {videoDevices.length > 0 && <>
                <label className="block text-xs font-bold text-white/30 uppercase tracking-wider mb-2">Camera</label>
                <select value={selectedVideo} onChange={e => setSelectedVideo(e.target.value)} className="w-full p-3 text-sm bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-white/30 mb-4">
                  {videoDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              </>}
              {audioDevices.length > 0 && <>
                <label className="block text-xs font-bold text-white/30 uppercase tracking-wider mb-2">Microphone</label>
                <select value={selectedAudio} onChange={e => setSelectedAudio(e.target.value)} className="w-full p-3 text-sm bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-white/30 mb-4">
                  {audioDevices.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
                </select>
              </>}
              <label className="block text-xs font-bold text-white/30 uppercase tracking-wider mb-2">Quality / Resolution</label>
              <div className="space-y-1.5">
                {RESOLUTIONS.map(r => (
                  <button key={r.label} onClick={() => setSelectedRes(r)} className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-sm transition-all ${selectedRes.label === r.label ? 'bg-white text-black font-bold' : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white border border-white/10'}`}>
                    <span>{r.label}</span>
                    <div className="flex gap-1">
                      {r.frameRate === 60 && <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${selectedRes.label === r.label ? 'bg-blue-600 text-white' : 'bg-white/10 text-white/40'}`}>60fps</span>}
                      {r.width >= 1920 && <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${selectedRes.label === r.label ? 'bg-purple-600 text-white' : 'bg-white/10 text-white/40'}`}>FHD</span>}
                      {r.width >= 1280 && r.width < 1920 && <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${selectedRes.label === r.label ? 'bg-red-600 text-white' : 'bg-white/10 text-white/40'}`}>HD</span>}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-4 p-3 bg-yellow-500/8 border border-yellow-500/15 rounded-xl">
                <p className="text-xs text-yellow-500/80">Changes apply on next stream start.</p>
              </div>
            </>}

            {/* VIEWERS */}
            {activeTab === 'viewers' && <>
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-white/30 uppercase tracking-wider">Live Viewers</p>
                <span className="text-xs font-bold bg-white/8 px-2 py-0.5 rounded-full">{viewers.size}</span>
              </div>
              {viewers.size === 0
                ? <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
                    <span className="text-4xl">👥</span>
                    <p className="text-sm text-white/25">{isLive ? 'No viewers yet — share your link!' : 'Start streaming to see viewers'}</p>
                  </div>
                : <div className="space-y-2">
                    {Array.from(viewers.values()).map((v, i) => (
                      <div key={v.id} className="flex items-center gap-3 px-3 py-2.5 bg-white/5 rounded-xl border border-white/8">
                        <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs font-bold text-white/60">{i+1}</div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white font-medium">Viewer {i+1}</p>
                          <p className="text-xs text-white/30 font-mono">{v.callState}</p>
                        </div>
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${v.callState === 'connected' ? 'bg-green-500' : v.callState === 'connecting' ? 'bg-yellow-400 live-dot' : 'bg-red-400'}`}/>
                      </div>
                    ))}
                  </div>
              }
            </>}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
