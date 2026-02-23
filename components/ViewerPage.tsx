import React, { useEffect, useState, useRef, useCallback } from 'react';

declare const Peer: any;

interface ViewerPageProps {
  streamId: string;
}

const PEER_PREFIX = 'ss-';
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'turn:a.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:a.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

const ViewerPage: React.FC<ViewerPageProps> = ({ streamId }) => {
  const [status, setStatus] = useState<'connecting' | 'live' | 'ended'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [connectionAttempts, setConnectionAttempts] = useState(0);

  // Player state
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [showVolume, setShowVolume] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isLiveStream, setIsLiveStream] = useState(true);
  const [hasVideo, setHasVideo] = useState(false);
  const [hasAudio, setHasAudio] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [stats, setStats] = useState({ resolution: 'Loading...', bitrate: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const peerRef = useRef<any>(null);
  const callRef = useRef<any>(null);
  const controlsTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const isConnectingRef = useRef(false);
  const mountedRef = useRef(true);

  const adminPeerId = `${PEER_PREFIX}${streamId}`;

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return h > 0 
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const formatBitrate = (bps: number) => {
    if (bps < 1000) return `${bps} bps`;
    if (bps < 1000000) return `${(bps / 1000).toFixed(1)} Kbps`;
    return `${(bps / 1000000).toFixed(1)} Mbps`;
  };

  const safePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return false;
    
    try {
      if (video.paused) {
        await video.play();
        setPlaying(true);
        return true;
      }
      return true;
    } catch (e) {
      console.warn('[Viewer] Play failed:', e);
      return false;
    }
  }, []);

  const togglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    
    if (video.paused) {
      await safePlay();
    } else {
      video.pause();
      setPlaying(false);
    }
  }, [safePlay]);

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

  const seek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (videoRef.current && !isLiveStream) {
      videoRef.current.currentTime = parseFloat(e.target.value);
    }
  }, [isLiveStream]);

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

  // Destroy peer connection
  const destroyPeer = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    if (callRef.current) {
      try { callRef.current.close(); } catch {}
      callRef.current = null;
    }
    if (peerRef.current) {
      try { peerRef.current.destroy(); } catch {}
      peerRef.current = null;
    }
    isConnectingRef.current = false;
  }, []);

  // Connect to broadcaster
  const connectToBroadcaster = useCallback(() => {
    if (!mountedRef.current || isConnectingRef.current) return;
    isConnectingRef.current = true;
    
    destroyPeer();

    const viewerId = `v-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
    
    try {
      const peer = new Peer(viewerId, { config: { iceServers: ICE_SERVERS } });
      peerRef.current = peer;

      peer.on('open', () => {
        console.log('[Viewer] Connected to signaling');
        isConnectingRef.current = false;
        
        // Create dummy stream for call
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const dummyStream = canvas.captureStream(1);
        
        const call = peer.call(adminPeerId, dummyStream);
        callRef.current = call;

        call.on('stream', (remoteStream: MediaStream) => {
          if (!mountedRef.current) return;
          
          console.log('[Viewer] Received stream');
          console.log('[Viewer] Stream tracks:', remoteStream.getTracks().map(t => `${t.kind}:${t.enabled}`));
          
          const video = videoRef.current;
          if (video) {
            // Ensure video is not muted by default
            video.muted = false;
            video.volume = 1;
            
            video.srcObject = remoteStream;
            
            // Check for audio tracks
            const audioTracks = remoteStream.getAudioTracks();
            setHasAudio(audioTracks.length > 0);
            
            if (audioTracks.length > 0) {
              console.log('[Viewer] Audio tracks found:', audioTracks.length);
              // Ensure audio tracks are enabled
              audioTracks.forEach(track => {
                track.enabled = true;
              });
            } else {
              console.warn('[Viewer] No audio tracks in stream');
            }
            
            setHasVideo(true);
            setStatus('live');
            setIsBuffering(false);
            
            // Small delay to ensure stream is properly attached
            setTimeout(() => {
              safePlay();
            }, 100);

            // Update stream info
            const videoTrack = remoteStream.getVideoTracks()[0];
            if (videoTrack) {
              const settings = videoTrack.getSettings();
              setStats({
                resolution: settings.width && settings.height 
                  ? `${settings.width}x${settings.height}`
                  : 'Unknown',
                bitrate: 0
              });
            }
          }
        });

        call.on('close', () => {
          if (!mountedRef.current) return;
          setStatus('ended');
          setErrorMsg('The broadcast has ended');
          if (videoRef.current) videoRef.current.srcObject = null;
        });

        call.on('error', (err: any) => {
          console.warn('[Viewer] Call error:', err);
          setConnectionAttempts(prev => prev + 1);
        });
      });

      peer.on('error', (err: any) => {
        console.log('[Viewer] Peer error:', err.type);
        if (!mountedRef.current) return;
        isConnectingRef.current = false;

        if (err.type === 'peer-unavailable') {
          // Admin not live, retry
          setConnectionAttempts(prev => prev + 1);
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => {
            if (mountedRef.current) connectToBroadcaster();
          }, 3000);
        } else if (err.type === 'unavailable-id' || err.type === 'network' || err.type === 'server-error') {
          // Retry with new connection
          if (retryTimer.current) clearTimeout(retryTimer.current);
          retryTimer.current = window.setTimeout(() => {
            if (mountedRef.current) connectToBroadcaster();
          }, 2000);
        }
      });

      peer.on('disconnected', () => {
        console.log('[Viewer] Disconnected from signaling');
        if (!mountedRef.current) return;
        
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = window.setTimeout(() => {
          if (mountedRef.current) connectToBroadcaster();
        }, 3000);
      });

    } catch (err) {
      console.error('[Viewer] Failed to create peer:', err);
      isConnectingRef.current = false;
    }
  }, [adminPeerId, destroyPeer, safePlay]);

  // Initialize connection
  useEffect(() => {
    mountedRef.current = true;
    connectToBroadcaster();
    resetControls();

    const onFullscreenChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    return () => {
      mountedRef.current = false;
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (controlsTimer.current) clearTimeout(controlsTimer.current);
      destroyPeer();
    };
  }, [connectToBroadcaster, resetControls, destroyPeer]);

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onLoadedMetadata = () => {
      const dur = video.duration || 0;
      setDuration(dur);
      setIsLiveStream(!isFinite(dur) || dur > 86400);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onVolumeChange = () => {
      setMuted(video.muted);
      setVolume(video.volume);
    };
    const onProgress = () => {
      if (video.buffered.length > 0) {
        setBuffered(video.buffered.end(video.buffered.length - 1));
      }
    };
    const onWaiting = () => setIsBuffering(true);
    const onPlaying = () => setIsBuffering(false);

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('progress', onProgress);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('progress', onProgress);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
    };
  }, []);

  // Handle ended state
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
            <h2 className="text-2xl font-bold text-gray-900">No Live Stream</h2>
            <p className="text-gray-500 mt-2">
              This stream has ended or doesn't exist. Each broadcast has a unique link.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const volumePercent = (muted ? 0 : volume) * 100;
  const seekPercent = duration ? (currentTime / duration) * 100 : 0;
  const bufferedPercent = duration ? (buffered / duration) * 100 : 0;

  return (
    <div className="min-h-screen bg-white">
      {/* Player Container */}
      <div
        ref={containerRef}
        className={`relative bg-black ${fullscreen ? 'fixed inset-0 z-50' : 'w-full'}`}
        style={!fullscreen ? { aspectRatio: '16/9' } : {}}
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
          autoPlay={false} // We'll control playback manually
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
        />

        {/* Connecting Overlay */}
        {status === 'connecting' && !hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="text-center">
              <div className="w-12 h-12 border-3 border-gray-600 border-t-white rounded-full spin mx-auto mb-4" />
              <p className="text-white/90 text-sm font-medium">Connecting to stream...</p>
              <p className="text-white/50 text-xs mt-2 font-mono">{streamId.slice(0, 12)}…</p>
              
              {connectionAttempts > 2 && (
                <button
                  onClick={connectToBroadcaster}
                  className="mt-4 px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white text-sm transition-colors"
                >
                  Retry Connection
                </button>
              )}
            </div>
          </div>
        )}

        {/* Audio Status Indicator (for debugging) */}
        {hasVideo && !hasAudio && (
          <div className="absolute top-3 left-3 px-2 py-1 bg-yellow-500/80 rounded-md text-xs text-white">
            No Audio
          </div>
        )}

        {/* Buffering Spinner */}
        {isBuffering && hasVideo && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-10 h-10 border-2 border-white/20 border-t-white rounded-full spin" />
          </div>
        )}

        {/* Play Overlay (when paused) */}
        {hasVideo && !playing && !isBuffering && (
          <div
            className="absolute inset-0 flex items-center justify-center cursor-pointer bg-black/20"
            onClick={togglePlay}
          >
            <div className="w-16 h-16 bg-white/90 rounded-full flex items-center justify-center hover:bg-white transition-colors">
              <svg className="w-8 h-8 text-gray-900 ml-1" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}

        {/* Controls Overlay */}
        <div
          className={`absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/40 transition-opacity duration-300 ${
            showControls || !playing ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >

          {/* Bottom Controls */}
          <div className="absolute bottom-0 left-0 right-0 p-4 space-y-2">
            {/* Progress Bar */}
            <div className="relative group">
              <div className="relative h-1 bg-white/30 rounded-full overflow-hidden">
                <div
                  className="absolute h-full bg-white/50 rounded-full"
                  style={{ width: `${bufferedPercent}%` }}
                />
                <div
                  className="absolute h-full bg-red-600 rounded-full"
                  style={{ width: isLiveStream ? '100%' : `${seekPercent}%` }}
                />
              </div>
              
              {!isLiveStream && duration > 0 && (
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={0.1}
                  value={currentTime}
                  onChange={seek}
                  className="seek-bar absolute inset-0 w-full h-4 -top-1.5 opacity-0 group-hover:opacity-100 cursor-pointer"
                />
              )}
            </div>

            {/* Control Buttons */}
            <div className="flex items-center gap-2">
              {/* Play/Pause */}
              <button
                onClick={togglePlay}
                className="text-white hover:text-white/80 transition-colors"
              >
                {playing ? (
                  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor">
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
                  className="text-white hover:text-white/80 transition-colors p-1"
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

              {/* Time */}
              <div className="text-white text-sm font-mono ml-2">
                {isLiveStream ? (
                  <span className="text-red-500 font-medium">LIVE</span>
                ) : (
                  <span>
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                )}
              </div>

              <div className="flex-1" />

              {/* Settings */}
              <div className="relative">
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="text-white/80 hover:text-white transition-colors p-1"
                >
                  <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
                  </svg>
                </button>

                {showSettings && (
                  <div className="absolute bottom-full right-0 mb-2 w-40 bg-white rounded-lg shadow-xl border border-gray-200 py-2">
                    <div className="px-3 py-1.5 text-xs font-medium text-gray-500">Playback Speed</div>
                    {[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => (
                      <button
                        key={rate}
                        onClick={() => changePlaybackRate(rate)}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 transition-colors ${
                          playbackRate === rate ? 'text-red-600 font-medium' : 'text-gray-700'
                        }`}
                      >
                        {rate === 1 ? 'Normal' : `${rate}x`}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Fullscreen */}
              <button
                onClick={toggleFullscreen}
                className="text-white/80 hover:text-white transition-colors p-1"
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
