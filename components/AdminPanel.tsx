import React, { useState, useRef, useEffect, useCallback } from 'react';
import { StreamMode, VideoDevice, AudioDevice, Resolution } from '../types';

declare const Peer: any;

const PEER_PREFIX = 'ss-';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

const RESOLUTIONS: Resolution[] = [
  { width: 426, height: 240, label: '240p', frameRate: 30 },
  { width: 640, height: 360, label: '360p', frameRate: 30 },
  { width: 854, height: 480, label: '480p', frameRate: 30 },
  { width: 1280, height: 720, label: '720p HD', frameRate: 30 },
  { width: 1280, height: 720, label: '720p 60fps', frameRate: 60 },
  { width: 1920, height: 1080, label: '1080p Full HD', frameRate: 30 },
];

interface ViewerInfo {
  id: string;
  joinedAt: number;
  connectionState?: string;
}

const AdminPanel: React.FC = () => {
  const [streamTitle, setStreamTitle] = useState('My Live Stream');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [mode, setMode] = useState<StreamMode>(StreamMode.IDLE);
  const [streamUrl, setStreamUrl] = useState('');
  const [streamId, setStreamId] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [peerStatus, setPeerStatus] = useState<'idle' | 'connecting' | 'ready' | 'error'>('idle');

  const [videoDevices, setVideoDevices] = useState<VideoDevice[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [selectedResolution, setSelectedResolution] = useState<Resolution>(RESOLUTIONS[3]);
  const [showDeviceMenu, setShowDeviceMenu] = useState(false);

  const [viewers, setViewers] = useState<Map<string, ViewerInfo>>(new Map());
  const [isFileUploading, setIsFileUploading] = useState(false);
  const [uploadFileName, setUploadFileName] = useState('');
  const [streamDuration, setStreamDuration] = useState(0);
  const [isPreviewMuted, setIsPreviewMuted] = useState(true);
  const [hasAudio, setHasAudio] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isMicEnabled, setIsMicEnabled] = useState(true);
  const [isCamEnabled, setIsCamEnabled] = useState(true);
  const [peakAudioLevel, setPeakAudioLevel] = useState(0);
  const [networkHealth, setNetworkHealth] = useState<'excellent' | 'good' | 'fair' | 'poor'>('good');
  const [activeTab, setActiveTab] = useState<'source' | 'settings' | 'viewers'>('source');

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const peerRef = useRef<any>(null);
  const callsRef = useRef<Map<string, any>>(new Map());
  const fileVideoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const durationTimer = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioAnimRef = useRef<number | null>(null);
  const peakDecayRef = useRef<number>(0);
  const reconnectTimerRef = useRef<number | null>(null);

  // ── Device enumeration ────────────────────────────────────────────────────
  useEffect(() => {
    const loadDevices = async () => {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
          .then(s => s.getTracks().forEach(t => t.stop()))
          .catch(() => {});
        const devices = await navigator.mediaDevices.enumerateDevices();
        const vids = devices.filter(d => d.kind === 'videoinput').map((d, i) => ({
          deviceId: d.deviceId, label: d.label || `Camera ${i + 1}`
        }));
        const auds = devices.filter(d => d.kind === 'audioinput').map((d, i) => ({
          deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}`
        }));
        setVideoDevices(vids);
        setAudioDevices(auds);
        if (vids.length > 0) setSelectedVideoDevice(prev => prev || vids[0].deviceId);
        if (auds.length > 0) setSelectedAudioDevice(prev => prev || auds[0].deviceId);
      } catch (e) { console.warn('Device enum:', e); }
    };
    navigator.mediaDevices.addEventListener('devicechange', loadDevices);
    loadDevices();
    return () => navigator.mediaDevices.removeEventListener('devicechange', loadDevices);
  }, []);

  // ── Duration timer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (mode !== StreamMode.IDLE) {
      startTimeRef.current = Date.now();
      durationTimer.current = window.setInterval(() =>
        setStreamDuration(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    } else {
      if (durationTimer.current) clearInterval(durationTimer.current);
      setStreamDuration(0);
    }
    return () => { if (durationTimer.current) clearInterval(durationTimer.current); };
  }, [mode]);

  // ── Audio level monitoring ────────────────────────────────────────────────
  const startAudioMonitoring = useCallback((stream: MediaStream) => {
    stopAudioMonitoring();
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;
      const buf = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const avg = buf.reduce((a, b) => a + b, 0) / buf.length / 255;
        setAudioLevel(avg);
        if (avg > peakDecayRef.current) {
          peakDecayRef.current = avg;
          setPeakAudioLevel(avg);
        } else {
          peakDecayRef.current = Math.max(0, peakDecayRef.current - 0.005);
          setPeakAudioLevel(peakDecayRef.current);
        }
        audioAnimRef.current = requestAnimationFrame(tick);
      };
      audioAnimRef.current = requestAnimationFrame(tick);
    } catch (e) { console.warn('Audio monitoring error:', e); }
  }, []);

  const stopAudioMonitoring = useCallback(() => {
    if (audioAnimRef.current) { cancelAnimationFrame(audioAnimRef.current); audioAnimRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    analyserRef.current = null;
    setAudioLevel(0);
    setPeakAudioLevel(0);
    peakDecayRef.current = 0;
  }, []);

  // ── Peer management ───────────────────────────────────────────────────────
  const destroyPeer = useCallback(() => {
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
    callsRef.current.forEach(call => { try { call.close(); } catch {} });
    callsRef.current.clear();
    setViewers(new Map());
    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch {}
      peerRef.current = null;
    }
    setPeerStatus('idle');
  }, []);

  const createPeer = useCallback((id: string, stream: MediaStream) => {
    destroyPeer();
    setPeerStatus('connecting');
    const peerId = `${PEER_PREFIX}${id}`;

    const peer = new Peer(peerId, {
      config: {
        iceServers: ICE_SERVERS,
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      },
      debug: 0
    });

    peer.on('open', () => {
      setPeerStatus('ready');
      setNetworkHealth('excellent');
    });

    peer.on('call', (call: any) => {
      // Answer immediately with the full stream (video + audio)
      call.answer(stream);

      const viewerInfo: ViewerInfo = { id: call.peer, joinedAt: Date.now(), connectionState: 'connected' };
      setViewers(prev => { const n = new Map(prev); n.set(call.peer, viewerInfo); return n; });
      callsRef.current.set(call.peer, call);

      call.peerConnection?.addEventListener('connectionstatechange', () => {
        const state = call.peerConnection?.connectionState;
        setViewers(prev => {
          const n = new Map(prev);
          const v = n.get(call.peer);
          if (v) n.set(call.peer, { ...v, connectionState: state });
          return n;
        });
      });

      call.on('close', () => {
        setViewers(prev => { const n = new Map(prev); n.delete(call.peer); return n; });
        callsRef.current.delete(call.peer);
      });

      call.on('error', (err: any) => {
        console.warn('[Admin] Call error for', call.peer, err);
        setViewers(prev => { const n = new Map(prev); n.delete(call.peer); return n; });
        callsRef.current.delete(call.peer);
      });
    });

    peer.on('error', (err: any) => {
      console.error('[Admin] Peer error:', err.type);
      if (err.type === 'unavailable-id') {
        setError('Stream ID conflict. Restarting...');
        // Auto retry with new ID
        setTimeout(() => {
          if (streamRef.current) createPeer(generateId(), streamRef.current);
        }, 1500);
      } else if (err.type === 'network' || err.type === 'disconnected') {
        setPeerStatus('connecting');
        setNetworkHealth('poor');
      } else if (err.type !== 'peer-unavailable') {
        setError(`Signaling error: ${err.type}`);
        setPeerStatus('error');
      }
    });

    peer.on('disconnected', () => {
      setPeerStatus('connecting');
      setNetworkHealth('fair');
      // Auto reconnect
      reconnectTimerRef.current = window.setTimeout(() => {
        if (peerRef.current === peer) {
          try { peer.reconnect(); } catch (e) {
            console.warn('[Admin] Reconnect failed, creating new peer');
            if (streamRef.current) createPeer(id, streamRef.current);
          }
        }
      }, 2000);
    });

    peer.on('connection', (conn: any) => {
      // Handle data connections (for future chat features)
      conn.on('data', (data: any) => { console.log('[Admin] Data received:', data); });
    });

    peerRef.current = peer;
  }, [destroyPeer]);

  // ── Stream setup ──────────────────────────────────────────────────────────
  const setupStream = useCallback(async (stream: MediaStream, newMode: StreamMode, id: string) => {
    streamRef.current = stream;
    const audioTracks = stream.getAudioTracks();
    setHasAudio(audioTracks.length > 0);

    // Update existing calls with new stream tracks
    if (callsRef.current.size > 0) {
      callsRef.current.forEach(call => {
        try {
          const senders = call.peerConnection?.getSenders();
          stream.getTracks().forEach(track => {
            const sender = senders?.find((s: any) => s.track?.kind === track.kind);
            if (sender) sender.replaceTrack(track);
          });
        } catch (e) { console.warn('[Admin] Track replace error:', e); }
      });
    }

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = isPreviewMuted;
      try { await videoRef.current.play(); } catch {}
    }

    if (audioTracks.length > 0) startAudioMonitoring(stream);

    setMode(newMode);
    setStreamId(id);
    setStreamUrl(`${window.location.origin}${window.location.pathname}#/viewer/${id}`);
    createPeer(id, stream);
  }, [createPeer, isPreviewMuted, startAudioMonitoring]);

  const generateId = () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;

  // ── Source controls ───────────────────────────────────────────────────────
  const startCamera = async () => {
    try {
      setError('');
      const constraints: MediaStreamConstraints = {
        video: selectedVideoDevice
          ? { deviceId: { exact: selectedVideoDevice }, width: { ideal: selectedResolution.width }, height: { ideal: selectedResolution.height }, frameRate: { ideal: selectedResolution.frameRate || 30 } }
          : { width: { ideal: selectedResolution.width }, height: { ideal: selectedResolution.height } },
        audio: selectedAudioDevice
          ? { deviceId: { exact: selectedAudioDevice }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      };
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      await setupStream(stream, StreamMode.LIVE, generateId());
    } catch (e: any) {
      setError(e.message || 'Camera access failed. Check permissions.');
    }
  };

  const startScreen = async () => {
    try {
      setError('');
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
        audio: true
      });

      // Try to mix in microphone audio
      let finalStream = displayStream;
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({
          audio: selectedAudioDevice
            ? { deviceId: { exact: selectedAudioDevice }, echoCancellation: true }
            : { echoCancellation: true }
        });
        const micTrack = micStream.getAudioTracks()[0];
        if (micTrack) {
          displayStream.addTrack(micTrack);
        }
      } catch (micErr) { console.warn('[Admin] Mic for screen share failed:', micErr); }

      displayStream.getVideoTracks()[0].addEventListener('ended', () => stopStream());
      await setupStream(finalStream, StreamMode.SCREEN, generateId());
    } catch (e: any) {
      if (e.name !== 'NotAllowedError') setError('Screen share cancelled or failed.');
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsFileUploading(true);
    setUploadFileName(file.name);
    try {
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
      const videoUrl = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.src = videoUrl;
      video.loop = true;
      video.muted = false;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';

      await new Promise((resolve, reject) => {
        video.onloadedmetadata = resolve;
        video.onerror = reject;
        setTimeout(() => reject(new Error('Load timeout')), 15000);
      });

      await video.play();
      // @ts-ignore
      const stream = video.captureStream(30);
      fileVideoRef.current = video;
      await setupStream(stream, StreamMode.FILE_UPLOAD, generateId());
    } catch (err: any) {
      setError(`File upload failed: ${err.message}`);
    } finally {
      setIsFileUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const stopStream = useCallback(() => {
    stopAudioMonitoring();
    destroyPeer();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (fileVideoRef.current) {
      fileVideoRef.current.pause();
      URL.revokeObjectURL(fileVideoRef.current.src);
      fileVideoRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    setMode(StreamMode.IDLE);
    setStreamUrl('');
    setStreamId('');
    setUploadFileName('');
    setHasAudio(false);
    setIsMicEnabled(true);
    setIsCamEnabled(true);
  }, [destroyPeer, stopAudioMonitoring]);

  // ── Track toggles ─────────────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (!streamRef.current) return;
    streamRef.current.getAudioTracks().forEach(t => {
      t.enabled = !isMicEnabled;
    });
    setIsMicEnabled(prev => !prev);
  }, [isMicEnabled]);

  const toggleCam = useCallback(() => {
    if (!streamRef.current) return;
    streamRef.current.getVideoTracks().forEach(t => {
      t.enabled = !isCamEnabled;
    });
    setIsCamEnabled(prev => !prev);
  }, [isCamEnabled]);

  const togglePreviewAudio = () => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setIsPreviewMuted(videoRef.current.muted);
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  const formatDuration = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const copyLink = () => {
    navigator.clipboard.writeText(streamUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const isLive = mode !== StreamMode.IDLE;

  // Audio meter bars (20 bars)
  const BARS = 20;
  const audioPercent = audioLevel * 100;
  const peakPercent = peakAudioLevel * 100;

  const healthColor = { excellent: '#22c55e', good: '#86efac', fair: '#fbbf24', poor: '#ef4444' }[networkHealth];

  const peerStatusLabel = {
    idle: 'Offline',
    connecting: 'Connecting…',
    ready: 'Live',
    error: 'Error'
  }[peerStatus];

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white flex flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-white/10 bg-[#0f0f0f] sticky top-0 z-50 px-4 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={() => window.location.hash = '#/'} className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 bg-red-600 rounded-lg flex items-center justify-center">
              <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 8l6 4-6 4V8z M21 3H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
              </svg>
            </div>
            <span className="font-bold text-white text-sm tracking-tight hidden sm:block">StreamStudio</span>
          </button>

          {/* Stream title */}
          <div className="hidden sm:flex items-center gap-2">
            <span className="text-white/30 text-sm">|</span>
            {isEditingTitle ? (
              <input
                autoFocus
                value={streamTitle}
                onChange={e => setStreamTitle(e.target.value)}
                onBlur={() => setIsEditingTitle(false)}
                onKeyDown={e => e.key === 'Enter' && setIsEditingTitle(false)}
                className="bg-white/10 border border-white/20 rounded px-2 py-0.5 text-sm text-white outline-none focus:border-white/40 w-48"
              />
            ) : (
              <button onClick={() => setIsEditingTitle(true)} className="text-sm text-white/70 hover:text-white transition-colors flex items-center gap-1.5">
                {streamTitle}
                <svg className="w-3 h-3 opacity-50" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Network health */}
          {isLive && (
            <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-white/5 rounded-full border border-white/10">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: healthColor }} />
              <span className="text-xs text-white/60 capitalize">{networkHealth}</span>
            </div>
          )}

          {/* Duration */}
          {isLive && (
            <div className="flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/10">
              <span className="w-1.5 h-1.5 bg-red-500 rounded-full live-dot" />
              <span className="text-xs font-mono text-white">{formatDuration(streamDuration)}</span>
            </div>
          )}

          {/* Viewer count */}
          {isLive && (
            <div className="flex items-center gap-1.5 bg-white/5 px-3 py-1.5 rounded-full border border-white/10">
              <svg className="w-3.5 h-3.5 text-white/60" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
              </svg>
              <span className="text-xs font-semibold text-white">{viewers.size}</span>
            </div>
          )}

          {/* End stream */}
          {isLive && (
            <button onClick={stopStream} className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-full transition-colors uppercase tracking-wide">
              End Stream
            </button>
          )}
        </div>
      </header>

      {/* ── Main Layout ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden">

        {/* Preview Panel */}
        <div className="flex-1 p-4 space-y-4 min-w-0">

          {/* Video Preview */}
          <div className="rounded-xl overflow-hidden border border-white/10 bg-black relative" style={{ aspectRatio: '16/9' }}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted={isPreviewMuted}
              className="w-full h-full object-contain"
            />

            {/* Idle overlay */}
            {!isLive && !isFileUploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black">
                <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
                  <svg className="w-8 h-8 text-white/20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>
                <p className="text-white/30 text-sm">No source selected</p>
              </div>
            )}

            {/* Loading overlay */}
            {isFileUploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
                <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full spin" />
                <p className="text-white/60 text-sm">Loading {uploadFileName}…</p>
              </div>
            )}

            {/* Live overlays */}
            {isLive && (
              <>
                {/* Top-left badges */}
                <div className="absolute top-3 left-3 flex items-center gap-2">
                  <span className="flex items-center gap-1.5 px-2.5 py-1 bg-red-600 rounded-md">
                    <span className="w-1.5 h-1.5 bg-white rounded-full live-dot" />
                    <span className="text-white text-xs font-bold tracking-wider">LIVE</span>
                  </span>
                  <span className="px-2 py-1 bg-black/60 backdrop-blur-sm rounded-md text-xs text-white/80 font-medium">
                    {mode === StreamMode.LIVE ? 'Camera' : mode === StreamMode.SCREEN ? 'Screen Share' : uploadFileName || 'File'}
                  </span>
                  <span className="px-2 py-1 bg-black/60 backdrop-blur-sm rounded-md text-xs text-white/80 font-mono">
                    {peerStatus === 'ready' ? (
                      <span className="text-green-400">● Connected</span>
                    ) : peerStatus === 'connecting' ? (
                      <span className="text-yellow-400">◌ {peerStatusLabel}</span>
                    ) : (
                      <span className="text-red-400">✕ {peerStatusLabel}</span>
                    )}
                  </span>
                </div>

                {/* Top-right: mic/cam status */}
                <div className="absolute top-3 right-3 flex items-center gap-2">
                  {!isMicEnabled && (
                    <div className="px-2 py-1 bg-red-600/90 rounded-md text-xs text-white font-medium flex items-center gap-1">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                      </svg>
                      Muted
                    </div>
                  )}
                  {!isCamEnabled && (
                    <div className="px-2 py-1 bg-red-600/90 rounded-md text-xs text-white font-medium flex items-center gap-1">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M21 6.5l-4-4-14 14 4 4 1.42-1.42-.72-.72A2 2 0 017 17H5a2 2 0 01-2-2V9a2 2 0 012-2h2c.38 0 .72.12 1.02.29L21 6.5z M17 7.91V7l-3 1.5V10l1.73 1.73L17 12V7.91z" />
                      </svg>
                      Camera Off
                    </div>
                  )}
                </div>

                {/* Preview audio toggle */}
                <button
                  onClick={togglePreviewAudio}
                  className="absolute bottom-3 right-3 p-2 bg-black/60 backdrop-blur-sm rounded-lg hover:bg-black/80 transition-colors"
                  title={isPreviewMuted ? 'Unmute preview' : 'Mute preview (prevents echo)'}
                >
                  {isPreviewMuted ? (
                    <svg className="w-4 h-4 text-white/60" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l6.73 6.73V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  )}
                </button>
              </>
            )}
          </div>

          {/* Audio meter + Quick controls */}
          {isLive && (
            <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-white/50 uppercase tracking-wider">Audio Level</span>
                {!hasAudio && <span className="text-xs text-yellow-400">No audio source</span>}
              </div>

              {/* Meter bars */}
              <div className="flex items-end gap-0.5 h-8">
                {Array.from({ length: BARS }).map((_, i) => {
                  const threshold = (i / BARS) * 100;
                  const active = audioPercent > threshold;
                  const isPeak = Math.abs(peakPercent - threshold) < 100 / BARS;
                  const isWarning = i >= BARS * 0.75;
                  const isDanger = i >= BARS * 0.9;
                  return (
                    <div
                      key={i}
                      className={`flex-1 rounded-sm transition-all duration-75 ${
                        active
                          ? isDanger
                            ? 'bg-red-500'
                            : isWarning
                            ? 'bg-yellow-400'
                            : 'bg-green-500'
                          : isPeak
                          ? 'bg-white/60'
                          : 'bg-white/10'
                      }`}
                      style={{ height: active ? `${60 + (i / BARS) * 40}%` : '20%' }}
                    />
                  );
                })}
              </div>

              {/* Quick Controls */}
              <div className="flex items-center gap-2 pt-1 border-t border-white/10">
                <button
                  onClick={toggleMic}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-all ${
                    isMicEnabled
                      ? 'bg-white/10 text-white hover:bg-white/15'
                      : 'bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30'
                  }`}
                >
                  {isMicEnabled ? (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.33 3 2.99 3 .22 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z" />
                    </svg>
                  )}
                  {isMicEnabled ? 'Mic On' : 'Mic Off'}
                </button>

                <button
                  onClick={toggleCam}
                  className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-medium transition-all ${
                    isCamEnabled
                      ? 'bg-white/10 text-white hover:bg-white/15'
                      : 'bg-red-600/20 text-red-400 border border-red-600/30 hover:bg-red-600/30'
                  }`}
                >
                  {isCamEnabled ? (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M21 6.5l-4-4-14 14 4 4 1.42-1.42-.72-.72A2 2 0 017 17H5a2 2 0 01-2-2V9a2 2 0 012-2h.18l2.31 2.31A3 3 0 009 13h.18l2.31 2.31A3 3 0 0014 12v-1.18l3 3V12l4 4V6.5z" />
                    </svg>
                  )}
                  {isCamEnabled ? 'Cam On' : 'Cam Off'}
                </button>
              </div>
            </div>
          )}

          {/* Stream Link */}
          {streamUrl && (
            <div className="bg-[#1a1a1a] border border-white/10 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-medium text-white/50 uppercase tracking-wider">Viewer Link</p>
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
                  <span className="text-xs text-green-400">Active</span>
                </div>
              </div>
              <div className="flex items-center gap-2 bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 mb-3">
                <svg className="w-4 h-4 text-white/30 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <span className="flex-1 text-xs text-white/60 font-mono truncate">{streamUrl}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={copyLink}
                  className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs font-semibold transition-all ${
                    copied
                      ? 'bg-green-600/20 text-green-400 border border-green-600/30'
                      : 'bg-white/10 text-white hover:bg-white/15'
                  }`}
                >
                  {copied ? (
                    <><svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>Copied!</>
                  ) : (
                    <><svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy Link</>
                  )}
                </button>
                <button
                  onClick={() => window.open(streamUrl, '_blank')}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-lg text-xs font-semibold transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                  Open Viewer
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="bg-red-900/20 border border-red-800/40 rounded-xl p-4 flex items-start gap-3">
              <svg className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
              <p className="text-sm text-red-400">{error}</p>
              <button onClick={() => setError('')} className="ml-auto text-red-400/60 hover:text-red-400">
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* ── Right Sidebar ────────────────────────────────────────────────── */}
        <div className="w-full lg:w-80 border-t lg:border-t-0 lg:border-l border-white/10 bg-[#141414] flex flex-col">

          {/* Tabs */}
          <div className="flex border-b border-white/10">
            {(['source', 'settings', 'viewers'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 py-3 text-xs font-semibold uppercase tracking-wider transition-colors relative ${
                  activeTab === tab ? 'text-white' : 'text-white/40 hover:text-white/70'
                }`}
              >
                {tab === 'viewers' && viewers.size > 0 && (
                  <span className="absolute top-2 right-2 w-4 h-4 bg-red-600 rounded-full text-[10px] font-bold flex items-center justify-center">
                    {viewers.size > 9 ? '9+' : viewers.size}
                  </span>
                )}
                {tab}
                {activeTab === tab && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600 rounded-full" />}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">

            {/* SOURCE TAB */}
            {activeTab === 'source' && (
              <>
                <div>
                  <p className="text-xs font-medium text-white/40 uppercase tracking-wider mb-3">Broadcast Source</p>
                  <div className="grid grid-cols-1 gap-2">
                    <button
                      onClick={startCamera}
                      disabled={isFileUploading}
                      className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all ${
                        mode === StreamMode.LIVE
                          ? 'border-blue-500 bg-blue-500/10'
                          : 'border-white/10 bg-white/5 hover:bg-white/8 hover:border-white/20'
                      } ${isFileUploading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${mode === StreamMode.LIVE ? 'bg-blue-500' : 'bg-white/10'}`}>
                        <svg className={`w-4 h-4 ${mode === StreamMode.LIVE ? 'text-white' : 'text-white/60'}`} viewBox="0 0 24 24" fill="currentColor">
                          <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z" />
                        </svg>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-semibold text-white">Camera</p>
                        <p className="text-xs text-white/40">Webcam or capture card</p>
                      </div>
                      {mode === StreamMode.LIVE && <div className="ml-auto w-2 h-2 bg-blue-500 rounded-full live-dot" />}
                    </button>

                    <button
                      onClick={startScreen}
                      disabled={isFileUploading}
                      className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all ${
                        mode === StreamMode.SCREEN
                          ? 'border-green-500 bg-green-500/10'
                          : 'border-white/10 bg-white/5 hover:bg-white/8 hover:border-white/20'
                      } ${isFileUploading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${mode === StreamMode.SCREEN ? 'bg-green-500' : 'bg-white/10'}`}>
                        <svg className={`w-4 h-4 ${mode === StreamMode.SCREEN ? 'text-white' : 'text-white/60'}`} viewBox="0 0 24 24" fill="currentColor">
                          <path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h3v2h10v-2h3c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z" />
                        </svg>
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-semibold text-white">Screen Share</p>
                        <p className="text-xs text-white/40">Capture your display</p>
                      </div>
                      {mode === StreamMode.SCREEN && <div className="ml-auto w-2 h-2 bg-green-500 rounded-full live-dot" />}
                    </button>

                    <label className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all ${
                      mode === StreamMode.FILE_UPLOAD
                        ? 'border-purple-500 bg-purple-500/10'
                        : 'border-white/10 bg-white/5 hover:bg-white/8 hover:border-white/20'
                    } ${isFileUploading ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${mode === StreamMode.FILE_UPLOAD ? 'bg-purple-500' : 'bg-white/10'}`}>
                        {isFileUploading ? (
                          <div className="w-4 h-4 border-2 border-purple-400 border-t-transparent rounded-full spin" />
                        ) : (
                          <svg className={`w-4 h-4 ${mode === StreamMode.FILE_UPLOAD ? 'text-white' : 'text-white/60'}`} viewBox="0 0 24 24" fill="currentColor">
                            <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3H8l4-4 4 4zm-3-7V3.5L18.5 9H13z" />
                          </svg>
                        )}
                      </div>
                      <div className="text-left">
                        <p className="text-sm font-semibold text-white">Upload Video</p>
                        <p className="text-xs text-white/40">{uploadFileName || 'MP4, WebM, MOV'}</p>
                      </div>
                      {mode === StreamMode.FILE_UPLOAD && <div className="ml-auto w-2 h-2 bg-purple-500 rounded-full live-dot" />}
                      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleFile} disabled={isFileUploading} />
                    </label>
                  </div>
                </div>

                {isLive && (
                  <button
                    onClick={stopStream}
                    className="w-full py-3 bg-red-600/20 text-red-400 border border-red-600/30 rounded-xl text-sm font-semibold hover:bg-red-600/30 transition-colors"
                  >
                    ⏹ End Stream
                  </button>
                )}

                {/* Stream status summary */}
                {!isLive && (
                  <div className="p-4 bg-white/5 rounded-xl border border-white/10 space-y-2">
                    <p className="text-xs font-semibold text-white/60 mb-3">How it works</p>
                    {[
                      { icon: '🔗', text: 'Click a source above to go live instantly' },
                      { icon: '🔒', text: 'Peer-to-peer encrypted — no server stores your video' },
                      { icon: '📱', text: 'Viewers join via a private link on any device' },
                    ].map((item, i) => (
                      <div key={i} className="flex items-start gap-2.5">
                        <span className="text-sm">{item.icon}</span>
                        <p className="text-xs text-white/40 leading-relaxed">{item.text}</p>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* SETTINGS TAB */}
            {activeTab === 'settings' && (
              <>
                {videoDevices.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Camera</label>
                    <select
                      value={selectedVideoDevice}
                      onChange={e => setSelectedVideoDevice(e.target.value)}
                      className="w-full p-3 text-sm bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-white/30 transition-colors"
                    >
                      {videoDevices.map(d => <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">{d.label}</option>)}
                    </select>
                  </div>
                )}

                {audioDevices.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Microphone</label>
                    <select
                      value={selectedAudioDevice}
                      onChange={e => setSelectedAudioDevice(e.target.value)}
                      className="w-full p-3 text-sm bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-white/30 transition-colors"
                    >
                      {audioDevices.map(d => <option key={d.deviceId} value={d.deviceId} className="bg-[#1a1a1a]">{d.label}</option>)}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-white/40 uppercase tracking-wider mb-2">Resolution & Frame Rate</label>
                  <div className="grid grid-cols-1 gap-1.5">
                    {RESOLUTIONS.map(r => (
                      <button
                        key={r.label}
                        onClick={() => setSelectedResolution(r)}
                        className={`flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-colors ${
                          selectedResolution.label === r.label
                            ? 'bg-white text-black font-semibold'
                            : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
                        }`}
                      >
                        <span>{r.label}</span>
                        {(r.width >= 1280) && (
                          <span className={`text-xs px-1.5 py-0.5 rounded font-bold ${selectedResolution.label === r.label ? 'bg-blue-600 text-white' : 'bg-white/10 text-white/50'}`}>
                            HD
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
                  <p className="text-xs text-yellow-400">Changing settings takes effect on next stream start.</p>
                </div>
              </>
            )}

            {/* VIEWERS TAB */}
            {activeTab === 'viewers' && (
              <>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-white/40 uppercase tracking-wider">Connected Viewers</p>
                  <span className="text-xs font-bold bg-white/10 px-2 py-0.5 rounded-full text-white">{viewers.size}</span>
                </div>

                {viewers.size === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-white/5 flex items-center justify-center">
                      <svg className="w-6 h-6 text-white/20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z" />
                      </svg>
                    </div>
                    <p className="text-sm text-white/30 text-center">
                      {isLive ? 'No viewers yet — share your link!' : 'Start a stream to see viewers'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {Array.from(viewers.values()).map((viewer, i) => {
                      const connected = !viewer.connectionState || viewer.connectionState === 'connected';
                      const duration = Math.floor((Date.now() - viewer.joinedAt) / 1000);
                      return (
                        <div key={viewer.id} className="flex items-center gap-3 px-3 py-2.5 bg-white/5 rounded-xl border border-white/10">
                          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-white/20 to-white/5 flex items-center justify-center text-xs font-bold text-white/60">
                            {i + 1}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white font-medium">Viewer {i + 1}</p>
                            <p className="text-xs text-white/40 font-mono truncate">{viewer.id.slice(0, 16)}…</p>
                          </div>
                          <div className="text-right">
                            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-yellow-400'} mb-1`} />
                            <p className="text-xs text-white/30 font-mono">{formatDuration(duration)}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
