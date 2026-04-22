import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import type { PlaylistItem } from "../../types/models";
import { useChromecast } from "../../hooks/useChromecast";
import { downloadMediaFile, isHlsUrl } from "../../utils/downloadStream";
import { PlayerOverlay } from "./PlayerOverlay";

interface VideoPlayerProps {
  item: PlaylistItem | null;
  autoplay: boolean;
  volume: number;
  muted: boolean;
  volumePercentMode: boolean;
  onVolume: (volume: number) => void;
  onMuted: (muted: boolean) => void;
  onError: (message: string | null) => void;
  onPlayingState: (isPlaying: boolean) => void;
  onProgress: (positionSec: number, durationSec: number) => void;
  onEnded: () => void;
  resumeFrom: number;
}

const CONTROLS_HIDE_MS = 2400;

export const VideoPlayer = ({
  item,
  autoplay,
  volume,
  muted,
  volumePercentMode,
  onVolume,
  onMuted,
  onError,
  onPlayingState,
  onProgress,
  onEnded,
  resumeFrom,
}: VideoPlayerProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const hasAppliedResumeRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);

  const onProgressRef = useRef(onProgress);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const onPlayingStateRef = useRef(onPlayingState);
  const resumeFromRef = useRef(resumeFrom);

  const [loading, setLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadHint, setDownloadHint] = useState<string | null>(null);

  useEffect(() => {
    onProgressRef.current = onProgress;
  }, [onProgress]);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  useEffect(() => {
    onPlayingStateRef.current = onPlayingState;
  }, [onPlayingState]);
  useEffect(() => {
    resumeFromRef.current = resumeFrom;
  }, [resumeFrom]);

  const onCastProgress = useCallback((positionSec: number, durationSec: number) => {
    onProgressRef.current(positionSec, durationSec);
  }, []);

  const {
    clearCastMessage,
    isCasting,
    mirror,
    deviceName,
    castMessage,
    requestCastSession,
    stopCasting,
    castPlayPause,
    castSeekTo,
    castSetVolumeLevel,
    castMuteToggle,
    canCast,
  } = useChromecast(item, onCastProgress);

  useEffect(() => {
    setDownloadHint(null);
    setDownloadBusy(false);
    clearCastMessage();
  }, [item?.id, clearCastMessage]);

  useEffect(() => {
    if (!isCasting) return;
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.muted = true;
  }, [isCasting, item?.id]);

  useEffect(() => {
    if (!isCasting) return;
    onPlayingStateRef.current(!mirror.isPaused);
  }, [isCasting, mirror.isPaused]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [volume, muted]);

  const mirrorRef = useRef(mirror);
  useEffect(() => {
    mirrorRef.current = mirror;
  }, [mirror]);

  const displayTime = isCasting ? mirror.currentTime : currentTime;
  const displayDuration = isCasting ? mirror.duration : duration;
  const displayPlaying = isCasting ? !mirror.isPaused : isPlaying;
  const displayLoading = isCasting ? !mirror.isMediaLoaded : loading;
  const displayBuffered = isCasting ? displayTime : buffered;

  const isLive = useMemo(
    () => !Number.isFinite(displayDuration) || displayDuration <= 0,
    [displayDuration],
  );

  const showControls = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, CONTROLS_HIDE_MS);
  }, []);

  const bumpControls = useCallback(() => {
    showControls();
    scheduleHide();
  }, [showControls, scheduleHide]);

  useEffect(() => {
    if (!displayPlaying || displayLoading || localError) {
      showControls();
      return;
    }
    scheduleHide();
    return () => {
      if (hideTimerRef.current != null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [displayPlaying, displayLoading, localError, showControls, scheduleHide]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !item) return;
    hasAppliedResumeRef.current = false;
    setLoading(true);
    setLocalError(null);
    onErrorRef.current(null);
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }

    const onLoadedMetadata = () => {
      const resumePoint = resumeFromRef.current;
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (hasAppliedResumeRef.current) return;
      if (resumePoint > 3 && Number.isFinite(video.duration) && resumePoint < video.duration) {
        video.currentTime = resumePoint;
      }
      hasAppliedResumeRef.current = true;
    };
    const onLoadedData = () => setLoading(false);
    const onDurationChange = () => setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    const onPlay = () => {
      setIsPlaying(true);
      onPlayingStateRef.current(true);
    };
    const onPause = () => {
      setIsPlaying(false);
      onPlayingStateRef.current(false);
    };
    const onWaiting = () => setLoading(true);
    const onPlaying = () => setLoading(false);
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
      onProgressRef.current(video.currentTime, Number.isFinite(video.duration) ? video.duration : 0);
    };
    const onProgressEvent = () => {
      if (video.buffered.length > 0) setBuffered(video.buffered.end(video.buffered.length - 1));
    };
    const onEndedInternal = () => {
      onProgressRef.current(video.duration, video.duration);
      onEndedRef.current();
    };
    const onErrorEvent = () => {
      const message = "Playback failed. Stream may be unavailable or blocked.";
      setLocalError(message);
      onErrorRef.current(message);
      setLoading(false);
    };
    const onRateChange = () => setPlaybackRate(video.playbackRate);

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("loadeddata", onLoadedData);
    video.addEventListener("durationchange", onDurationChange);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("progress", onProgressEvent);
    video.addEventListener("ended", onEndedInternal);
    video.addEventListener("error", onErrorEvent);
    video.addEventListener("ratechange", onRateChange);

    if (Hls.isSupported() && item.streamUrl.includes(".m3u8")) {
      const hls = new Hls();
      hlsRef.current = hls;
      hls.loadSource(item.streamUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) return;
        const message = "HLS playback error. Try retrying this stream.";
        setLocalError(message);
        onErrorRef.current(message);
        setLoading(false);
      });
    } else {
      video.src = item.streamUrl;
    }

    if (autoplay) {
      void video.play().catch(() => {
        onErrorRef.current("Autoplay is blocked by browser policy. Press play to start.");
      });
    }

    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("loadeddata", onLoadedData);
      video.removeEventListener("durationchange", onDurationChange);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("progress", onProgressEvent);
      video.removeEventListener("ended", onEndedInternal);
      video.removeEventListener("error", onErrorEvent);
      video.removeEventListener("ratechange", onRateChange);
      video.pause();
      video.removeAttribute("src");
      video.load();
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [item, autoplay]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  const title = useMemo(() => item?.title ?? "No stream selected", [item]);

  const togglePlay = useCallback(() => {
    if (!item) return;
    if (isCasting) {
      castPlayPause();
      return;
    }
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, [item, isCasting, castPlayPause]);

  const seekTo = useCallback(
    (seconds: number) => {
      if (isCasting) {
        castSeekTo(seconds);
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      const target = Math.max(0, Number.isFinite(video.duration) ? Math.min(seconds, video.duration) : seconds);
      video.currentTime = target;
      setCurrentTime(target);
    },
    [isCasting, castSeekTo],
  );

  const skipBy = useCallback(
    (delta: number) => {
      if (isCasting) {
        castSeekTo((mirrorRef.current.currentTime || 0) + delta);
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      seekTo((video.currentTime || 0) + delta);
    },
    [isCasting, castSeekTo, seekTo],
  );

  const toggleMute = useCallback(() => {
    if (isCasting) {
      castMuteToggle();
      return;
    }
    onMuted(!muted);
  }, [muted, onMuted, isCasting, castMuteToggle]);

  const handleOverlayVolume = useCallback(
    (value: number) => {
      onVolume(value);
      if (isCasting) castSetVolumeLevel(value);
    },
    [onVolume, isCasting, castSetVolumeLevel],
  );

  const handleCastClick = useCallback(() => {
    if (isCasting) stopCasting();
    else void requestCastSession();
  }, [isCasting, stopCasting, requestCastSession]);

  const toggleFullscreen = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await container.requestFullscreen();
      }
    } catch {
      /* user-gesture or permission issue — silently ignore */
    }
  }, []);

  const togglePip = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (!("pictureInPictureEnabled" in document)) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch {
      /* pip disallowed */
    }
  }, []);

  const setRate = useCallback((rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = rate;
    setPlaybackRate(rate);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const withinPlayer = el.contains(target);
      if (!withinPlayer && !isFullscreen) return;
      switch (event.key.toLowerCase()) {
        case " ":
        case "k":
          event.preventDefault();
          togglePlay();
          bumpControls();
          break;
        case "arrowleft":
          event.preventDefault();
          skipBy(event.shiftKey ? -30 : -5);
          bumpControls();
          break;
        case "arrowright":
          event.preventDefault();
          skipBy(event.shiftKey ? 30 : 5);
          bumpControls();
          break;
        case "j":
          event.preventDefault();
          skipBy(-10);
          bumpControls();
          break;
        case "l":
          event.preventDefault();
          skipBy(10);
          bumpControls();
          break;
        case "arrowup":
          event.preventDefault();
          handleOverlayVolume(Math.min(1, (volume || 0) + 0.05));
          bumpControls();
          break;
        case "arrowdown":
          event.preventDefault();
          handleOverlayVolume(Math.max(0, (volume || 0) - 0.05));
          bumpControls();
          break;
        case "m":
          event.preventDefault();
          toggleMute();
          bumpControls();
          break;
        case "f":
          event.preventDefault();
          void toggleFullscreen();
          break;
        case "p":
          event.preventDefault();
          void togglePip();
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [
    bumpControls,
    handleOverlayVolume,
    isFullscreen,
    skipBy,
    toggleFullscreen,
    toggleMute,
    togglePip,
    togglePlay,
    volume,
  ]);

  const canPip = typeof document !== "undefined" && "pictureInPictureEnabled" in document;

  const handleDownload = useCallback(async () => {
    if (!item) return;
    setDownloadBusy(true);
    setDownloadHint(null);
    const result = await downloadMediaFile({
      streamUrl: item.streamUrl,
      title: item.title,
      video: videoRef.current,
    });
    setDownloadBusy(false);
    if (result.ok) {
      setDownloadHint("Saved to your downloads folder.");
      window.setTimeout(() => setDownloadHint(null), 4000);
    } else {
      setDownloadHint(result.message);
    }
  }, [item]);

  return (
    <div className="panel overflow-hidden">
      <div
        ref={containerRef}
        className="group/player relative aspect-video w-full bg-black"
        onPointerMove={bumpControls}
        onPointerLeave={() => {
          if (displayPlaying && !displayLoading && !localError) setControlsVisible(false);
        }}
        onFocus={showControls}
        tabIndex={0}
      >
        <video
          ref={videoRef}
          className="h-full w-full"
          controls={false}
          playsInline
          onClick={togglePlay}
          onDoubleClick={() => void toggleFullscreen()}
        />
        <PlayerOverlay
          title={title}
          loading={displayLoading}
          error={localError}
          isPlaying={displayPlaying}
          isLive={isLive}
          isFullscreen={isFullscreen}
          canPip={canPip}
          canCast={canCast}
          castActive={isCasting}
          castDeviceLabel={deviceName}
          castHint={castMessage}
          muted={muted}
          volume={volume}
          volumePercentMode={volumePercentMode}
          currentTime={displayTime}
          duration={displayDuration}
          buffered={displayBuffered}
          playbackRate={playbackRate}
          controlsVisible={controlsVisible}
          onTogglePlay={togglePlay}
          onSeekTo={seekTo}
          onSkip={skipBy}
          onToggleMute={toggleMute}
          onVolume={handleOverlayVolume}
          onTogglePip={() => void togglePip()}
          onToggleFullscreen={() => void toggleFullscreen()}
          onCast={handleCastClick}
          onChangePlaybackRate={setRate}
          canDownload={Boolean(item)}
          downloadBusy={downloadBusy}
          downloadHint={downloadHint}
          isHlsStream={item ? isHlsUrl(item.streamUrl) : false}
          onDownload={() => void handleDownload()}
        />
      </div>
    </div>
  );
};
