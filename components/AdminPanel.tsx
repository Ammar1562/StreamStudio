// AdminPanel.tsx
import React, { useState, useRef, useEffect } from 'react';
import { StreamMode, VideoDevice, AudioDevice, Resolution } from '../types';

const AI_TIPS = [
  'Lighting in front of you dramatically improves video clarity.',
  'A wired connection is more reliable than Wi-Fi for streaming.',
  'Test audio levels before going live — bad audio loses viewers fast.',
  'Keep your title concise and descriptive.',
];
const getRandomTip = () => AI_TIPS[Math.floor(Math.random() * AI_TIPS.length)];

const buildViewerUrl = (id: string) => {
  const base = window.location.origin + window.location.pathname;
  return `${base}#/viewer/${id}`;
};

const VIEWER_TIMEOUT = 12000;

const RESOLUTIONS: Resolution[] = [
  { width: 640, height: 480, label: '480p (SD)' },
  { width: 854, height: 480, label: '480p (16:9)' },
  { width: 960, height: 540, label: '540p' },
  { width: 1280, height: 720, label: '720p (HD)' },
  { width: 1920, height: 1080, label: '1080p (Full HD)' },
];

const AdminPanel: React.FC = () => {
  const [streamTitle, setStreamTitle] = useState('Title');
  const [mode, setMode] = useState<StreamMode>(StreamMode.IDLE);
  const [viewerMap, setViewerMap] = useState<Map<string, number>>(new Map());
  const [streamUrl, setStreamUrl] = useState('');
  const [streamId, setStreamId] = useState('');
  const [tip, setTip] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  // Device and resolution states
  const [videoDevices, setVideoDevices] = useState<VideoDevice[]>([]);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedVideoDevice, setSelectedVideoDevice] = useState('');
  const [selectedAudioDevice, setSelectedAudioDevice] = useState('');
  const [selectedResolution, setSelectedResolution] = useState<Resolution>(RESOLUTIONS[3]); // 720p default
  const [showDeviceMenu, setShowDeviceMenu] = useState(false);

  // Preview player controls
  const [isPlaying, setIsPlaying] = useState(true);
  const [previewVolume, setPreviewVolume] = useState(1);
  const [previewMuted, setPreviewMuted] = useState(true);
  const [showPreviewControls, setShowPreviewControls] = useState(false);
  const [isFileUploading, setIsFileUploading] = useState(false);

  const streamTitleRef = useRef(streamTitle);
  const modeRef = useRef(mode);
  const streamIdRef = useRef('');
  const viewerMapRef = useRef<Map<string, number>>(new Map());

  const videoRef = useRef<HTMLVideoElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const bc = useRef<BroadcastChannel | null>(null);
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const playPromiseRef = useRef<Promise<void> | null>(null);
  const previewPlayPromiseRef = useRef<Promise<void> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stalePruneTimer = useRef<number | null>(null);
  const fileStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  useEffect(() => { streamTitleRef.current = streamTitle; }, [streamTitle]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { streamIdRef.current = streamId; }, [streamId]);

  // Load available devices
  useEffect(() => {
    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        
        const videos = devices
          .filter(d => d.kind === 'videoinput')
          .map(d => ({ deviceId: d.deviceId, label: d.label || `Camera ${videoDevices.length + 1}` }));
        
        const audios = devices
          .filter(d => d.kind === 'audioinput')
          .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${audioDevices.length + 1}` }));

        setVideoDevices(videos);
        setAudioDevices(audios);

        if (videos.length > 0 && !selectedVideoDevice) setSelectedVideoDevice(videos[0].deviceId);
        if (audios.length > 0 && !selectedAudioDevice) setSelectedAudioDevice(audios[0].deviceId);
      } catch (err) {
        console.error('Error accessing media devices:', err);
      }
    };

    getDevices();

    navigator.mediaDevices.addEventListener('devicechange', getDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', getDevices);
  }, []);

  // Safe play function
  const safePlay = async (videoElement: HTMLVideoElement | null, promiseRef: React.MutableRefObject<Promise<void> | null>) => {
    if (!videoElement) return false;
    
    try {
      if (promiseRef.current) {
        await promiseRef.current.catch(() => {});
      }
      
      if (videoElement.paused) {
        promiseRef.current = videoElement.play();
        await promiseRef.current;
        return true;
      }
      return true;
    } catch (e: any) {
      if (e.name !== 'AbortError' && e.name !== 'NotAllowedError') {
        console.error('Play error:', e);
      }
      return false;
    } finally {
      promiseRef.current = null;
    }
  };

  const safePause = (videoElement: HTMLVideoElement | null) => {
    if (!videoElement) return;
    try {
      videoElement.pause();
    } catch (e) {
      console.error('Pause error:', e);
    }
  };

  const togglePreviewPlay = async () => {
    if (!previewVideoRef.current) return;
    
    if (isPlaying) {
      safePause(previewVideoRef.current);
      setIsPlaying(false);
    } else {
      const played = await safePlay(previewVideoRef.current, previewPlayPromiseRef);
      if (played) setIsPlaying(true);
    }
  };

  const togglePreviewMute = () => {
    if (!previewVideoRef.current) return;
    const newMuted = !previewMuted;
    previewVideoRef.current.muted = newMuted;
    setPreviewMuted(newMuted);
  };

  const changePreviewVolume = (val: number) => {
    if (!previewVideoRef.current) return;
    previewVideoRef.current.volume = val;
    setPreviewVolume(val);
    if (val === 0) {
      previewVideoRef.current.muted = true;
      setPreviewMuted(true);
    } else if (previewMuted) {
      previewVideoRef.current.muted = false;
      setPreviewMuted(false);
    }
  };

  // Prune stale viewers
  const pruneStaleViewers = () => {
    const now = Date.now();
    setViewerMap(prev => {
      const next = new Map(prev);
      let changed = false;
      next.forEach((ts, id) => {
        if (now - (ts as number) > VIEWER_TIMEOUT) {
          next.delete(id);
          peerConnections.current.get(id)?.close();
          peerConnections.current.delete(id);
          changed = true;
        }
      });
      if (changed) viewerMapRef.current = next;
      return changed ? next : prev;
    });
  };

  // BroadcastChannel
  useEffect(() => {
    bc.current = new BroadcastChannel('secure_stream_channel');

    bc.current.onmessage = async (event) => {
      const { type, payload } = event.data;
      const viewerId: string = payload?.viewerId;

      try {
        switch (type) {
          case 'VIEWER_JOIN':
          case 'VIEWER_HEARTBEAT': {
            if (!viewerId) break;
            const now = Date.now();
            setViewerMap(prev => {
              const next = new Map(prev);
              next.set(viewerId, now);
              viewerMapRef.current = next;
              return next;
            });
            if (type === 'VIEWER_JOIN' && streamRef.current) {
              const sid = streamIdRef.current;
              setTimeout(() => initiateWebRTC(viewerId, sid), 400);
            }
            break;
          }

          case 'VIEWER_LEAVE': {
            if (!viewerId) break;
            setViewerMap(prev => {
              const next = new Map(prev);
              next.delete(viewerId);
              viewerMapRef.current = next;
              return next;
            });
            peerConnections.current.get(viewerId)?.close();
            peerConnections.current.delete(viewerId);
            break;
          }

          case 'SIGNAL_ANSWER': {
            const pc = peerConnections.current.get(viewerId);
            if (pc && pc.signalingState !== 'stable' && payload.answer) {
              await pc.setRemoteDescription(new RTCSessionDescription(payload.answer)).catch(console.error);
            }
            break;
          }

          case 'SIGNAL_ICE': {
            const pc = peerConnections.current.get(viewerId);
            if (pc && payload.candidate) {
              await pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
            }
            break;
          }
        }
      } catch (err) {
        console.error('Broadcast message error:', err);
      }
    };

    stalePruneTimer.current = window.setInterval(pruneStaleViewers, 5000);

    return () => {
      stopStream();
      bc.current?.close();
      if (stalePruneTimer.current) clearInterval(stalePruneTimer.current);
    };
  }, []);

  // WebRTC
  const initiateWebRTC = async (targetId: string, currentStreamId: string) => {
    if (!streamRef.current || !currentStreamId) return;
    
    try {
      peerConnections.current.get(targetId)?.close();

      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      });
      
      peerConnections.current.set(targetId, pc);
      
      streamRef.current.getTracks().forEach(t => {
        if (streamRef.current) {
          pc.addTrack(t, streamRef.current);
        }
      });

      pc.onicecandidate = e => {
        if (e.candidate && bc.current) {
          bc.current.postMessage({ 
            type: 'SIGNAL_ICE_ADMIN', 
            payload: { viewerId: targetId, candidate: e.candidate.toJSON() } 
          });
        }
      };

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await pc.setLocalDescription(offer);
      
      if (bc.current) {
        bc.current.postMessage({
          type: 'SIGNAL_OFFER',
          payload: {
            viewerId: targetId,
            offer,
            streamId: currentStreamId,
            title: streamTitleRef.current,
            mode: modeRef.current,
            resolution: selectedResolution,
          },
        });
      }
    } catch (e) { 
      console.error('WebRTC Offer error:', e); 
    }
  };

  const generateUrl = (): string => {
    const newId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 8)}`;
    setStreamUrl(buildViewerUrl(newId));
    setStreamId(newId);
    streamIdRef.current = newId;
    return newId;
  };

  const setupStream = async (stream: MediaStream, newMode: StreamMode) => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => {
        t.stop();
        streamRef.current?.removeTrack(t);
      });
    }
    
    streamRef.current = stream;

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.muted = true;
      await safePlay(videoRef.current, playPromiseRef);
    }

    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = stream;
      previewVideoRef.current.muted = previewMuted;
      previewVideoRef.current.volume = previewVolume;
      await safePlay(previewVideoRef.current, previewPlayPromiseRef);
      setIsPlaying(true);
    }

    setMode(newMode);
    modeRef.current = newMode;
    const newId = generateUrl();

    if (bc.current) {
      bc.current.postMessage({
        type: 'STREAM_UPDATE',
        payload: { 
          title: streamTitleRef.current, 
          mode: newMode, 
          streamId: newId,
          resolution: selectedResolution 
        },
      });
    }

    peerConnections.current.forEach((_, id) => {
      peerConnections.current.get(id)?.close();
      initiateWebRTC(id, newId);
    });

    setTip(getRandomTip());
    setIsFileUploading(false);
  };

  const startCamera = async () => {
    try {
      setError('');
      
      const constraints: MediaStreamConstraints = {
        video: selectedVideoDevice ? {
          deviceId: { exact: selectedVideoDevice },
          width: { ideal: selectedResolution.width },
          height: { ideal: selectedResolution.height },
        } : {
          width: { ideal: selectedResolution.width },
          height: { ideal: selectedResolution.height },
        },
        audio: selectedAudioDevice ? {
          deviceId: { exact: selectedAudioDevice },
        } : true,
      };

      const s = await navigator.mediaDevices.getUserMedia(constraints);
      await setupStream(s, StreamMode.LIVE);
    } catch (e: any) {
      showError(e, 'Camera');
    }
  };

  const startScreen = async () => {
    try {
      setError('');
      
      const s = await navigator.mediaDevices.getDisplayMedia({ 
        video: true, 
        audio: true 
      });
      
      s.getVideoTracks()[0].addEventListener('ended', () => {
        stopStream();
      });
      
      await setupStream(s, StreamMode.LIVE);
    } catch (e: any) {
      if (e.name !== 'NotAllowedError' && e.name !== 'PermissionDeniedError') {
        showError(e, 'Screen');
      }
    }
  };

  // Fixed file upload handler
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsFileUploading(true);
    setError('');

    try {
      // Clean up previous streams
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }

      if (fileStreamRef.current) {
        fileStreamRef.current.getTracks().forEach(t => t.stop());
        fileStreamRef.current = null;
      }

      // Create video element for file playback
      const videoUrl = URL.createObjectURL(file);
      
      // Setup video elements
      if (videoRef.current) {
        videoRef.current.srcObject = null;
        videoRef.current.src = videoUrl;
        videoRef.current.loop = true;
        videoRef.current.muted = true;
        videoRef.current.crossOrigin = 'anonymous';
      }

      if (previewVideoRef.current) {
        previewVideoRef.current.srcObject = null;
        previewVideoRef.current.src = videoUrl;
        previewVideoRef.current.loop = true;
        previewVideoRef.current.muted = previewMuted;
        previewVideoRef.current.volume = previewVolume;
        previewVideoRef.current.crossOrigin = 'anonymous';
      }

      // Wait for video metadata to load
      await Promise.all([
        new Promise((resolve) => {
          if (videoRef.current) {
            if (videoRef.current.readyState >= 1) {
              resolve(true);
            } else {
              videoRef.current.onloadedmetadata = resolve;
            }
          }
        }),
        new Promise((resolve) => {
          if (previewVideoRef.current) {
            if (previewVideoRef.current.readyState >= 1) {
              resolve(true);
            } else {
              previewVideoRef.current.onloadedmetadata = resolve;
            }
          }
        })
      ]);

      // Start playing
      await Promise.all([
        safePlay(videoRef.current, playPromiseRef),
        safePlay(previewVideoRef.current, previewPlayPromiseRef)
      ]);

      setIsPlaying(true);

      // For file upload, we need to use MediaRecorder to create a real-time stream
      // This simulates a live stream from a file
      if (videoRef.current) {
        // Create a canvas to capture video frames
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const video = videoRef.current;
        
        canvas.width = selectedResolution.width;
        canvas.height = selectedResolution.height;
        
        // Create a MediaStream from the canvas
        const canvasStream = canvas.captureStream(30); // 30 FPS
        
        // Add audio track if available (simulated - no audio from canvas)
        // For audio, we'll create a silent audio track
        const audioContext = new AudioContext();
        const destination = audioContext.createMediaStreamDestination();
        const silentGain = audioContext.createGain();
        silentGain.gain.value = 0;
        silentGain.connect(destination);
        
        // Combine video and audio streams
        const tracks = [...canvasStream.getVideoTracks()];
        if (destination.stream.getAudioTracks().length > 0) {
          tracks.push(destination.stream.getAudioTracks()[0]);
        }
        
        const finalStream = new MediaStream(tracks);
        fileStreamRef.current = finalStream;
        
        // Start drawing video frames to canvas
        const drawFrame = () => {
          if (!video.paused && !video.ended && video.readyState >= 2) {
            ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
          }
          requestAnimationFrame(drawFrame);
        };
        drawFrame();
        
        // Use this stream for WebRTC
        streamRef.current = finalStream;
        
        setMode(StreamMode.FILE_UPLOAD);
        modeRef.current = StreamMode.FILE_UPLOAD;
        
        const newId = generateUrl();
        
        if (bc.current) {
          bc.current.postMessage({
            type: 'STREAM_UPDATE',
            payload: { 
              title: streamTitleRef.current, 
              mode: StreamMode.FILE_UPLOAD, 
              streamId: newId,
              resolution: selectedResolution 
            },
          });
        }

        peerConnections.current.forEach((_, id) => {
          peerConnections.current.get(id)?.close();
          initiateWebRTC(id, newId);
        });

        setTip(getRandomTip());
      } else {
        throw new Error('Could not initialize video element');
      }
    } catch (err: any) {
      console.error('File upload error:', err);
      setError(`File upload failed: ${err.message}`);
      stopStream();
    } finally {
      setIsFileUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const stopStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => {
        t.stop();
        streamRef.current?.removeTrack(t);
      });
      streamRef.current = null;
    }

    if (fileStreamRef.current) {
      fileStreamRef.current.getTracks().forEach(t => {
        t.stop();
        fileStreamRef.current?.removeTrack(t);
      });
      fileStreamRef.current = null;
    }
    
    [videoRef.current, previewVideoRef.current].forEach(v => {
      if (v) {
        safePause(v);
        v.srcObject = null;
        v.src = '';
        v.load();
      }
    });
    
    peerConnections.current.forEach(pc => {
      try { pc.close(); } catch (e) { console.error('Error closing peer connection:', e); }
    });
    peerConnections.current.clear();
    
    setViewerMap(new Map());
    viewerMapRef.current = new Map();
    setMode(StreamMode.IDLE);
    modeRef.current = StreamMode.IDLE;
    setStreamUrl('');
    setStreamId('');
    streamIdRef.current = '';
    setTip('');
    setIsPlaying(true);
    setPreviewMuted(true);
    
    if (bc.current) {
      bc.current.postMessage({ type: 'STOP_STREAM', payload: {} });
    }
  };

  const showError = (e: any, type: string) => {
    const msgs: Record<string, string> = {
      NotAllowedError: `${type} permission denied. Please grant access to continue.`,
      NotFoundError: `No ${type.toLowerCase()} device found. Please connect a device and try again.`,
      NotReadableError: `${type} is already in use by another application.`,
      OverconstrainedError: `The selected ${type.toLowerCase()} doesn't support the chosen resolution.`,
    };
    setError(msgs[e.name] || `${type}: ${e.message}`);
    setTimeout(() => setError(''), 5000);
  };

  const handleCopy = async () => {
    try { 
      await navigator.clipboard.writeText(streamUrl); 
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { 
      const textarea = document.createElement('textarea');
      textarea.value = streamUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isLive = mode !== StreamMode.IDLE;
  const viewerCount = viewerMap.size;
  const viewerIds = Array.from(viewerMap.keys());

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-900">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-4 sm:px-8 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-black rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </div>
          <span className="font-bold text-base tracking-tight hidden sm:inline">StreamStudio</span>
          {isLive && (
            <div className="flex items-center gap-2 ml-2">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              <span className="text-sm font-semibold text-gray-700 hidden sm:inline">
                {viewerCount} {viewerCount === 1 ? 'viewer' : 'viewers'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {isLive && (
            <button
              onClick={stopStream}
              className="px-3 sm:px-4 py-2 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors"
            >
              End Stream
            </button>
          )}
          <button
            onClick={() => (window.location.hash = '#/')}
            className="px-3 sm:px-4 py-2 text-sm font-medium text-gray-500 hover:text-gray-900 transition-colors"
          >
            Home
          </button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-4 sm:py-8 grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-8">
        {/* Left sidebar */}
        <div className="space-y-4 sm:space-y-5">
          {/* Stream title */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5">
            <label className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Stream Title
            </label>
            <input
              type="text"
              value={streamTitle}
              onChange={e => setStreamTitle(e.target.value)}
              className="w-full text-lg font-semibold text-gray-900 border-none outline-none bg-transparent placeholder-gray-300"
              placeholder="Enter title..."
            />
            <div className="mt-3 pt-3 border-t border-gray-100 flex items-center gap-2 flex-wrap">
              {isLive ? (
                <>
                  <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                  <span className="text-xs font-semibold text-red-500">Live</span>
                  <span className="text-xs text-gray-400">
                    · {viewerCount} watching
                  </span>
                </>
              ) : (
                <>
                  <span className="w-2 h-2 bg-gray-300 rounded-full" />
                  <span className="text-xs text-gray-400">Offline</span>
                </>
              )}
            </div>
          </div>

          {/* Device Selection */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5">
            <button
              onClick={() => setShowDeviceMenu(!showDeviceMenu)}
              className="w-full flex items-center justify-between text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3"
            >
              <span>Device Settings</span>
              <svg className={`w-4 h-4 transition-transform ${showDeviceMenu ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showDeviceMenu && (
              <div className="space-y-4">
                {videoDevices.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Camera</label>
                    <select
                      value={selectedVideoDevice}
                      onChange={(e) => setSelectedVideoDevice(e.target.value)}
                      className="w-full p-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      {videoDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                {audioDevices.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Microphone</label>
                    <select
                      value={selectedAudioDevice}
                      onChange={(e) => setSelectedAudioDevice(e.target.value)}
                      className="w-full p-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      {audioDevices.map(d => (
                        <option key={d.deviceId} value={d.deviceId}>{d.label}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-gray-500 mb-1">Resolution</label>
                  <select
                    value={selectedResolution.width}
                    onChange={(e) => {
                      const res = RESOLUTIONS.find(r => r.width === parseInt(e.target.value));
                      if (res) setSelectedResolution(res);
                    }}
                    className="w-full p-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-black"
                  >
                    {RESOLUTIONS.map(r => (
                      <option key={r.width} value={r.width}>{r.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* Sources */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5 space-y-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Broadcast Source
            </p>

            <button
              onClick={startCamera}
              disabled={isFileUploading}
              className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-all group disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center group-hover:bg-blue-100 transition-colors flex-shrink-0">
                <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="text-left">
                <div className="text-sm font-semibold text-gray-900">Webcam</div>
                <div className="text-xs text-gray-400">Camera + microphone</div>
              </div>
            </button>

            <button
              onClick={startScreen}
              disabled={isFileUploading}
              className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-gray-100 hover:border-green-200 hover:bg-green-50 transition-all group disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center group-hover:bg-green-100 transition-colors flex-shrink-0">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div className="text-left">
                <div className="text-sm font-semibold text-gray-900">Screen Share</div>
                <div className="text-xs text-gray-400">Capture your display</div>
              </div>
            </button>

            <label className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-gray-100 hover:border-purple-200 hover:bg-purple-50 transition-all group cursor-pointer disabled:opacity-50">
              <div className="w-9 h-9 bg-purple-50 rounded-lg flex items-center justify-center group-hover:bg-purple-100 transition-colors flex-shrink-0">
                <svg className="w-4 h-4 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <div className="text-left">
                <div className="text-sm font-semibold text-gray-900">Upload Video</div>
                <div className="text-xs text-gray-400">Stream a local file</div>
              </div>
              <input 
                ref={fileInputRef} 
                type="file" 
                accept="video/*" 
                className="hidden" 
                onChange={handleFile}
                disabled={isFileUploading}
              />
            </label>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-600">{error}</div>
          )}

          {tip && (
            <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4">
              <p className="text-xs font-semibold text-amber-600 uppercase tracking-wider mb-1.5">💡 Tip</p>
              <p className="text-sm text-amber-900 leading-relaxed">{tip}</p>
            </div>
          )}
        </div>

        {/* Main */}
        <div className="lg:col-span-2 space-y-4 sm:space-y-5">
          {/* Main Stream Video */}
          <div className="bg-black rounded-2xl overflow-hidden aspect-video relative shadow-sm">
            <video 
              ref={videoRef} 
              autoPlay 
              playsInline 
              muted 
              className="w-full h-full object-contain" 
            />

            {!isLive && !isFileUploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <div className="w-14 h-14 border border-white/10 rounded-full flex items-center justify-center">
                  <div className="w-3 h-3 bg-white/20 rounded-full" />
                </div>
                <p className="text-white/30 text-sm">Select a source to start streaming</p>
              </div>
            )}

            {isFileUploading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80">
                <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                <p className="text-white/50 text-sm">Preparing video stream...</p>
              </div>
            )}

            {isLive && (
              <>
                <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 bg-red-500 rounded-lg shadow z-10">
                  <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
                  <span className="text-white text-xs font-bold tracking-wide">LIVE</span>
                </div>
                
                {streamTitle && (
                  <div className="absolute bottom-4 left-4 right-4 z-10">
                    <p className="text-white text-sm font-semibold drop-shadow-lg truncate">{streamTitle}</p>
                  </div>
                )}

                <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2.5 py-1.5 bg-black/50 backdrop-blur-sm rounded-lg z-10">
                  <svg className="w-3.5 h-3.5 text-white/70" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                  </svg>
                  <span className="text-white text-xs font-semibold">{viewerCount}</span>
                </div>
              </>
            )}
          </div>

          {/* Local Preview */}
          {isLive && (
            <div 
              className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5"
              onMouseEnter={() => setShowPreviewControls(true)}
              onMouseLeave={() => setShowPreviewControls(false)}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Local Preview</p>
                <span className="text-xs text-gray-500">Use to check latency</span>
              </div>
              
              <div className="relative bg-black rounded-xl overflow-hidden aspect-video">
                <video
                  ref={previewVideoRef}
                  autoPlay
                  playsInline
                  className="w-full h-full object-contain"
                />

                {/* Preview Controls Overlay */}
                <div className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent transition-opacity duration-300 ${showPreviewControls ? 'opacity-100' : 'opacity-0'}`}>
                  <div className="absolute bottom-0 left-0 right-0 p-3">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={togglePreviewPlay}
                        className="p-2 text-white hover:text-white/70 transition-colors rounded-lg hover:bg-white/10"
                      >
                        {isPlaying ? (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <rect x="6" y="4" width="4" height="16" rx="1" />
                            <rect x="14" y="4" width="4" height="16" rx="1" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>

                      <button
                        onClick={togglePreviewMute}
                        className="p-2 text-white hover:text-white/70 transition-colors rounded-lg hover:bg-white/10"
                      >
                        {previewMuted ? (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                          </svg>
                        )}
                      </button>

                      {!previewMuted && (
                        <div className="flex-1 max-w-[100px]">
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.02}
                            value={previewVolume}
                            onChange={(e) => changePreviewVolume(parseFloat(e.target.value))}
                            className="w-full h-1 bg-white/30 rounded-lg appearance-none cursor-pointer"
                            style={{
                              background: `linear-gradient(to right, white ${previewVolume * 100}%, rgba(255,255,255,0.3) ${previewVolume * 100}%)`
                            }}
                          />
                        </div>
                      )}

                      <span className="text-white/50 text-xs ml-auto">
                        {previewMuted ? '🔇' : `🔊 ${Math.round(previewVolume * 100)}%`}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Viewer URL */}
          <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-4">Viewer Link</p>

            {streamUrl ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 bg-gray-50 rounded-xl border border-gray-200 px-4 py-3">
                  <span className="flex-1 text-sm text-gray-600 font-mono truncate">{streamUrl}</span>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={handleCopy}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold border transition-all ${
                      copied
                        ? 'bg-green-50 border-green-200 text-green-700'
                        : 'bg-white border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {copied ? (
                      <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Copied!</>
                    ) : (
                      <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>Copy Link</>
                    )}
                  </button>
                  <button
                    onClick={() => window.open(buildViewerUrl(streamId), '_blank', 'noopener')}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold bg-black text-white hover:bg-gray-800 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                    Open Viewer
                  </button>
                  <button
                    onClick={() => streamId && (window.location.hash = `#/viewer/${streamId}`)}
                    className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
                  >
                    Test
                  </button>
                </div>
                <p className="text-xs text-gray-400">Share this link with your viewers. Each session has a unique URL.</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-20 border-2 border-dashed border-gray-100 rounded-xl">
                <p className="text-sm text-gray-400">Start a broadcast to generate your viewer link</p>
              </div>
            )}
          </div>

          {/* Connected viewers */}
          {isLive && (
            <div className="bg-white rounded-2xl border border-gray-200 p-4 sm:p-5">
              <div className="flex items-center justify-between mb-4">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Live Viewers</p>
                <span className="text-xs font-bold text-gray-900 bg-gray-100 px-2.5 py-1 rounded-full">
                  {viewerCount}
                </span>
              </div>
              {viewerCount === 0 ? (
                <p className="text-sm text-gray-400">No viewers yet — share your link!</p>
              ) : (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {viewerIds.map((id, i) => (
                    <div key={id} className="flex items-center gap-3 py-2 px-3 bg-gray-50 rounded-lg">
                      <span className="w-2 h-2 bg-green-400 rounded-full flex-shrink-0" />
                      <span className="text-sm text-gray-600 font-medium">Viewer {i + 1}</span>
                      <span className="text-xs text-gray-300 font-mono ml-auto">{(id as string).slice(0, 14)}…</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminPanel;
