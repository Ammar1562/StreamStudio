import React, { useEffect, useState, useRef, useCallback } from 'react';

declare const Peer: any;

interface ViewerPageProps {
  streamId: string;
}

interface QualityLevel {
  label: string;
  height: number;
  bitrate: number;
  isHD?: boolean;
}

const PEER_PREFIX = 'ss-';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
];

const QUALITY_LEVELS: QualityLevel[] = [
  { label: 'Auto', height: 0, bitrate: 0 },
  { label: '1080p', height: 1080, bitrate: 4500, isHD: true },
  { label: '720p', height: 720, bitrate: 2500, isHD: true },
  { label: '480p', height: 480, bitrate: 1200 },
  { label: '360p', height: 360, bitrate: 800 },
  { label: '240p', height: 240, bitrate: 400 },
];

const ViewerPage: React.FC<ViewerPageProps> = ({ streamId }) => {
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [connectionTime, setConnectionTime] = useState(0);
  
  // Player state
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [hasVideo, setHasVideo] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isBuffering, setIsBuffering] = useState(false);
  const [selectedQuality, setSelectedQuality] = useState<QualityLevel>(QUALITY_LEVELS[0]);
  const [networkQuality, setNetworkQuality] = useState<'good' | 'fair' | 'poor'>('good');
  const [stats, setStats] = useState({ 
    resolution: 'Loading...', 
    bitrate: 0,
    fps: 0,
    latency: 0
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const controlsTimer = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const connectionStartTime = useRef(Date.now());
  const statsInterval = useRef<number | null>(null);
  const reconnectAttempts = useRef(0);

  const adminPeerId = `${PEER_PREFIX}${streamId}`;

  // Format time for display
  const formatTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  // Monitor connection quality
  const updateStats = useCallback(() => {
    if (!videoRef.current || status !== 'live') return;

    const video = videoRef.current;
    
    // Check buffering
    if (video.buffered.length > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      const currentTime = video.currentTime;
      const bufferedAhead = bufferedEnd - currentTime;
      
      if (bufferedAhead < 1) {
        setNetworkQuality('poor');
      } else if (bufferedAhead < 3) {
        setNetworkQuality('fair');
      } else {
        setNetworkQuality('good');
      }
    }

    // Get video stats
    if (video.videoWidth && video.videoHeight) {
      setStats(prev => ({
        ...prev,
        resolution: `${video.videoWidth}x${video.videoHeight}`,
        fps: 30 // Estimated
      }));
    }

    // Calculate latency (time since last frame)
    if (video.srcObject) {
      const videoTracks = (video.srcObject as MediaStream).getVideoTracks();
      if (videoTracks.length > 0) {
        const settings = videoTracks[0].getSettings();
        if (settings.frameRate) {
          setStats(prev => ({ ...prev, fps: Math.round(settings.frameRate || 30) }));
        }
      }
    }
  }, [status]);

  // Clean up
  const cleanup = useCallback(() => {
    if (statsInterval.current) {
      clearInterval(statsInterval.current);
      statsInterval.current = null;
    }

    if (callRef.current) {
      try { callRef.current.close(); } catch {}
      callRef.current = null;
    }
    
    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch {}
      peerRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setHasVideo(false);
    setHasAudio(false);
  }, []);

  // Connect to broadcaster
  const connectToBroadcaster = useCallback(async () => {
    if (!mountedRef.current) return;

    cleanup();
    setStatus('connecting');
    setErrorMsg('');
    connectionStartTime.current = Date.now();
    reconnectAttempts.current++;

    // Generate unique viewer ID
    const viewerId = `v-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;

    try {
      // Create peer with optimized settings for fast connection
      const peer = new Peer(viewerId, { 
        config: { 
          iceServers: ICE_SERVERS,
          iceTransportPolicy: 'all',
          iceCandidatePoolSize: 10 // Faster connection
        },
        debug: 0
      });
      
      peerRef.current = peer;

      // Set timeout for connection
      const connectionTimeout = setTimeout(() => {
        if (status === 'connecting' && mountedRef.current) {
          if (reconnectAttempts.current < 3) {
            connectToBroadcaster();
          } else {
            setStatus('ended');
            setErrorMsg('Connection timeout');
          }
        }
      }, 10000);

      peer.on('open', () => {
        clearTimeout(connectionTimeout);
        
        if (!mountedRef.current) return;
        
        console.log('[Viewer] Connected to signaling');
        
        // Call broadcaster with empty stream
        const call = peer.call(adminPeerId, new MediaStream());
        callRef.current = call;

        // Set call timeout
        const callTimeout = setTimeout(() => {
          if (status === 'connecting' && mountedRef.current) {
            call.close();
            if (reconnectAttempts.current < 3) {
              connectToBroadcaster();
            }
          }
        }, 5000);

        call.on('stream', (remoteStream: MediaStream) => {
          clearTimeout(callTimeout);
          
          if (!mountedRef.current) return;
          
          console.log('[Viewer] Stream received in', Date.now() - connectionStartTime.current, 'ms');
          setConnectionTime(Date.now() - connectionStartTime.current);
          
          const videoTracks = remoteStream.getVideoTracks();
          const audioTracks = remoteStream.getAudioTracks();
          
          setHasVideo(videoTracks.length > 0);
          setHasAudio(audioTracks.length > 0);
          
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;
            
            // Start playing immediately
            videoRef.current.play()
              .then(() => {
                setPlaying(true);
                setStatus('live');
                reconnectAttempts.current = 0;
              })
              .catch(err => {
                console.warn('[Viewer] Autoplay failed:', err);
                setPlaying(false);
                setStatus('live'); // Still live, just need user interaction
              });
          }

          // Start stats monitoring
          if (!statsInterval.current) {
            statsInterval.current = window.setInterval(updateStats, 2000);
          }
        });

        call.on('close', () => {
          clearTimeout(callTimeout);
          if (mountedRef.current && status === 'live') {
            setStatus('ended');
            setErrorMsg('Broadcast ended');
          }
        });

        call.on('error', (err: any) => {
          clearTimeout(callTimeout);
          console.warn('[Viewer] Call error:', err);
          
          if (mountedRef.current && status === 'live') {
            setStatus('ended');
            setErrorMsg('Connection lost');
          }
        });
      });

      peer.on('error', (err: any) => {
        clearTimeout(connectionTimeout);
        console.warn('[Viewer] Peer error:', err.type);
        
        if (!mountedRef.current) return;

        if (err.type === 'peer-unavailable') {
          setStatus('ended');
          setErrorMsg('Stream is not live');
        } else if (reconnectAttempts.current < 3) {
          // Retry with backoff
          setTimeout(connectToBroadcaster, 1000 * reconnectAttempts.current);
        } else {
          setStatus('ended');
          setErrorMsg('Connection failed');
        }
      });

    } catch (err) {
      console.error('[Viewer] Failed to create peer:', err);
      
      if (mountedRef.current) {
        setStatus('ended');
        setErrorMsg('Failed to initialize');
      }
    }
  }, [adminPeerId, cleanup, updateStats, status]);

  // Initialize connection
  useEffect(() => {
    mountedRef.current = true;
    reconnectAttempts.current = 0;
    
    connectToBroadcaster();

    const onFullscreenChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      cleanup();
    };
  }, [connectToBroadcaster, cleanup]);

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolumeChange = () => {
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => {
      setIsBuffering(false);
      setStatus('live');
    };
    const onError = () => {
      if (status === 'live') {
        setStatus('ended');
        setErrorMsg('Playback error');
      }
    };

    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('error', onError);
    };
  }, [status]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.muted = !videoRef.current.muted;
      setMuted(videoRef.current.muted);
    }
  }, []);

  const changeVolume = useCallback((val: number) => {
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setVolume(val);
      setMuted(val === 0);
    }
  }, []);

  const changePlaybackRate = useCallback((rate: number) => {
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
      setPlaybackRate(rate);
      setShowSettings(false);
    }
  }, []);

  const applyQuality = useCallback((quality: QualityLevel) => {
    setSelectedQuality(quality);
    setShowSettings(false);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    
    try {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen error:', err);
    }
  }, []);

  const resetControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimer.current) clearTimeout(controlsTimer.current);
    controlsTimer.current = window.setTimeout(() => {
      if (playing) {
        setShowControls(false);
        setShowVolume(false);
        setShowSettings(false);
      }
    }, 3000);
  }, [playing]);

  // Render ended state
  if (status === 'ended') {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center space-y-6">
          <div className="w-20 h-20 mx-auto bg-gray-100 rounded-2xl flex items-center justify-center">
            <svg className="w-10 h-10 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Stream Ended</h2>
            <p className="text-gray-500 mt-2">{errorMsg || 'The broadcast has ended'}</p>
          </div>
          <button
            onClick={() => window.location.hash = '#/'}
            className="px-6 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
          >
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const volumePercent = (muted ? 0 : volume) * 100;

  return (
    <div className="min-h-screen bg-black">
      {/* Player Container */}
      <div
        ref={containerRef}
        className={`relative bg-black ${fullscreen ? 'fixed inset-0 z-50' : 'w-full h-screen'}`}
        onMouseMove={resetControls}
        onMouseLeave={() => {
          if (controlsTimer.current) clearTimeout(controlsTimer.current);
          controlsTimer.current = window.setTimeout(() => {
            setShowControls(false);
            setShowVolume(false);
            setShowSettings(false);
          }, 1000);
        }}
      >
        {/* Video Element */}
        <video
          ref={videoRef}
          className="w-full h-full object-contain bg-black"
          playsInline
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
        />

        {/* Connecting Overlay - With progress indicator */}
        {status === 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="text-center">
              <div className="w-16 h-16 border-4 border-gray-700 border-t-white rounded-full spin mx-auto mb-4" />
              <p className="text-white text-lg font-medium">Connecting to stream...</p>
              <p className="text-gray-400 text-sm mt-2">
                {connectionTime > 0 ? formatTime(connectionTime) : 'Establishing connection'}
              </p>
              <p className="text-gray-600 text-xs mt-4 font-mono">
                {streamId.slice(0, 8)}…{streamId.slice(-4)}
              </p>
              
              {connectionTime > 5000 && (
                <button
                  onClick={connectToBroadcaster}
                  className="mt-6 px-6 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white text-sm transition-colors"
                >
                  Retry Connection
                </button>
              )}
            </div>
          </div>
        )}

        {/* Network Quality Indicator */}
        {status === 'live' && networkQuality !== 'good' && (
          <div className="absolute top-4 right-4 px-3 py-1.5 bg-yellow-500/90 rounded-full text-xs text-white font-medium backdrop-blur-sm">
            {networkQuality === 'poor' ? 'Poor Network' : 'Fair Network'}
          </div>
        )}

        {/* Connection Time Badge */}
        {status === 'live' && connectionTime > 0 && (
          <div className="absolute top-4 left-4 px-3 py-1.5 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white">
            Connected in {formatTime(connectionTime)}
          </div>
        )}

        {/* Audio Status */}
        {hasVideo && !hasAudio && (
          <div className="absolute top-4 left-4 px-3 py-1.5 bg-yellow-500/90 rounded-full text-xs text-white backdrop-blur-sm">
            No Audio
          </div>
        )}

        {/* Buffering Spinner */}
        {isBuffering && status === 'live' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-black/20">
            <div className="w-12 h-12 border-3 border-white/30 border-t-white rounded-full spin" />
          </div>
        )}

        {/* Play Overlay */}
        {hasVideo && !playing && !isBuffering && status === 'live' && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer bg-black/40"
            onClick={togglePlay}
          >
            <div className="w-20 h-20 bg-white/90 rounded-full flex items-center justify-center hover:bg-white transition-colors transform hover:scale-105">
              <svg className="w-10 h-10 text-gray-900 ml-1" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Controls Overlay */}
        <div
          className={`absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/40 transition-opacity duration-300 ${
            showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Top Controls - Stats */}
          <div className="absolute top-0 left-0 right-0 p-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              {status === 'live' && (
                <span className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 rounded-full">
                  <span className="w-2 h-2 bg-white rounded-full animate-pulse" />
                  <span className="text-white text-xs font-medium">LIVE</span>
                </span>
              )}
              <span className="px-3 py-1.5 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white">
                {stats.resolution}
              </span>
              {stats.bitrate > 0 && (
                <span className="hidden sm:block px-3 py-1.5 bg-black/50 backdrop-blur-sm rounded-full text-xs text-white">
                  {Math.round(stats.bitrate / 1000)} Kbps
                </span>
              )}
            </div>
          </div>

          {/* Bottom Controls */}
          <div className="absolute bottom-0 left-0 right-0 p-4">
            {/* Control Buttons */}
            <div className="flex items-center gap-3">
              {/* Play/Pause */}
              <button
                onClick={togglePlay}
                className="text-white hover:text-white/80 transition-colors"
              >
                {playing ? (
                  <svg className="w-10 h-10" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg className="w-10 h-10" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* Volume */}
              <div
                className="relative flex items-center"
                onMouseEnter={() => setShowVolume(true)}
                onMouseLeave={() => setShowVolume(false)}
              >
                <button
                  onClick={toggleMute}
                  className="text-white hover:text-white/80 transition-colors p-2"
                >
                  {muted || volume === 0 ? (
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.99 8.99 0 0017.73 19.73L19 21 20.27 19.73 5.54 5 4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                    </svg>
                  ) : volume < 0.5 ? (
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18.5 12A4.5 4.5 0 0016 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z" />
                    </svg>
                  ) : (
                    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                    </svg>
                  )}
                </button>

                {showVolume && (
                  <div className="flex items-center w-24 ml-2">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={muted ? 0 : volume}
                      onChange={e => changeVolume(parseFloat(e.target.value))}
                      className="volume-slider w-full"
                      style={{
                        background: `linear-gradient(to right, white ${volumePercent}%, rgba(255,255,255,0.3) ${volumePercent}%)`
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Audio Level Indicator */}
              {hasAudio && playing && (
                <div className="flex items-center gap-1 ml-2">
                  <div className={`w-1.5 h-4 ${audioLevel > 0.1 ? 'bg-green-500' : 'bg-white/30'} rounded-full transition-all`} />
                  <div className={`w-1.5 h-6 ${audioLevel > 0.3 ? 'bg-green-500' : 'bg-white/30'} rounded-full transition-all`} />
                  <div className={`w-1.5 h-8 ${audioLevel > 0.5 ? 'bg-green-500' : 'bg-white/30'} rounded-full transition-all`} />
                  <div className={`w-1.5 h-6 ${audioLevel > 0.7 ? 'bg-green-500' : 'bg-white/30'} rounded-full transition-all`} />
                  <div className={`w-1.5 h-4 ${audioLevel > 0.9 ? 'bg-green-500' : 'bg-white/30'} rounded-full transition-all`} />
                </div>
              )}

              <div className="flex-1" />

              {/* Settings */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="text-white/80 hover:text-white transition-colors p-2"
                >
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                  </svg>
                </button>

                {showSettings && (
                  <div className="absolute bottom-full right-0 mb-2 w-64 bg-white rounded-xl shadow-2xl border border-gray-200 py-2">
                    <div className="px-4 py-2 text-xs font-medium text-gray-500 border-b border-gray-100">
                      Playback Speed
                    </div>
                    <div className="grid grid-cols-3 gap-1 p-3">
                      {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                        <button
                          key={rate}
                          onClick={() => changePlaybackRate(rate)}
                          className={`px-3 py-2 text-sm rounded-lg transition-colors ${
                            playbackRate === rate 
                              ? 'bg-red-500 text-white' 
                              : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          {rate === 1 ? 'Normal' : `${rate}x`}
                        </button>
                      ))}
                    </div>

                    <div className="px-4 py-2 text-xs font-medium text-gray-500 border-t border-gray-100">
                      Video Quality
                    </div>
                    <div className="p-3 space-y-1">
                      {QUALITY_LEVELS.map(quality => (
                        <button
                          key={quality.label}
                          onClick={() => applyQuality(quality)}
                          className={`w-full flex items-center justify-between px-3 py-2.5 text-sm rounded-lg transition-colors ${
                            selectedQuality.label === quality.label 
                              ? 'bg-red-500 text-white' 
                              : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          <span>{quality.label}</span>
                          {quality.isHD && (
                            <span className="text-xs bg-yellow-500 text-white px-2 py-0.5 rounded-full">
                              HD
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="text-white/80 hover:text-white transition-colors p-2"
              >
                {fullscreen ? (
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 9V4.5M9 9H4.5M9 9L3.75 3.75M15 9h4.5M15 9V4.5M15 9l5.25-5.25M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 15h4.5M15 15v4.5m0-4.5l5.25 5.25" />
                  </svg>
                ) : (
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ViewerPage;
