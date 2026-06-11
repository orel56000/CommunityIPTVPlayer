import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import mpegts from "mpegts.js";
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
const SOURCE_STARTUP_TIMEOUT_MS = 12000;
const MPEGTS_STARTUP_TIMEOUT_MS = 25000;
const ENABLE_STREAM_PROXY = false;

const isTransportStreamUrl = (url: string): boolean => {
  const lower = url.toLowerCase();
  return /\.ts(\?|$)/i.test(url) || /[?&]output=ts(?:&|$)/i.test(url) || lower.includes("output=ts");
};

const toHlsVariantUrl = (url: string): string | null => {
  let next = url;
  let changed = false;
  if (/\.ts(\?|$)/i.test(next)) {
    next = next.replace(/\.ts(\?|$)/i, ".m3u8$1");
    changed = true;
  }
  if (/[?&]output=ts(?:&|$)/i.test(next)) {
    next = next.replace(/([?&]output=)ts(&|$)/i, "$1m3u8$2");
    changed = true;
  }
  return changed && next !== url ? next : null;
};

const toOutputM3u8Url = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.get("output")?.toLowerCase() === "m3u8") return null;
    parsed.searchParams.set("output", "m3u8");
    const next = parsed.toString();
    return next !== url ? next : null;
  } catch {
    return null;
  }
};

const toPathM3u8Url = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (/\.(m3u8|mp4|m4v|webm|mov|avi|mkv|mpg|mpeg|ts)$/i.test(parsed.pathname)) return null;
    const nextPath = parsed.pathname.endsWith("/") ? `${parsed.pathname}index.m3u8` : `${parsed.pathname}.m3u8`;
    parsed.pathname = nextPath;
    const next = parsed.toString();
    return next !== url ? next : null;
  } catch {
    return null;
  }
};

const toPathTsUrl = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    if (/\.(ts|m3u8|mp4|m4v|webm|mov|avi|mkv|mpg|mpeg)$/i.test(parsed.pathname)) return null;
    const nextPath = parsed.pathname.endsWith("/") ? `${parsed.pathname}index.ts` : `${parsed.pathname}.ts`;
    parsed.pathname = nextPath;
    const next = parsed.toString();
    return next !== url ? next : null;
  } catch {
    return null;
  }
};

const shouldUseHlsEngine = (url: string): boolean => {
  if (!Hls.isSupported()) return false;
  const lower = url.toLowerCase();
  return isHlsUrl(url) || lower.includes("output=m3u8") || lower.includes("format=m3u8");
};

const canUseMpegTsEngine = (): boolean => mpegts.isSupported() && Boolean(mpegts.getFeatureList().mseLivePlayback);

const isKnownNativeVideoUrl = (url: string): boolean =>
  /\.(mp4|m4v|webm|mov|avi|mkv|mpg|mpeg)(\?|$)/i.test(url.toLowerCase());

const shouldPreferHlsEngine = (url: string, section: PlaylistItem["section"]): boolean => {
  if (!Hls.isSupported()) return false;
  if (shouldUseHlsEngine(url)) return true;
  // For ambiguous live URLs, prefer MPEG-TS probing first.
  if (section === "live" && !isKnownNativeVideoUrl(url)) return false;
  return false;
};

const shouldTryMpegTsEngine = (url: string, section: PlaylistItem["section"]): boolean => {
  if (!canUseMpegTsEngine()) return false;
  if (isTransportStreamUrl(url)) return true;
  if (section === "live" && !isKnownNativeVideoUrl(url) && !shouldUseHlsEngine(url)) return true;
  return false;
};

const mediaErrorName = (code?: number): string => {
  switch (code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "MEDIA_ERR_ABORTED";
    case MediaError.MEDIA_ERR_NETWORK:
      return "MEDIA_ERR_NETWORK";
    case MediaError.MEDIA_ERR_DECODE:
      return "MEDIA_ERR_DECODE";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "MEDIA_ERR_SRC_NOT_SUPPORTED";
    default:
      return "UNKNOWN_MEDIA_ERROR";
  }
};

const isAbortLikeError = (error: unknown): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (error instanceof Error && /abort/i.test(error.name));

const shouldUseStreamProxy = (mode: "hls" | "mpegts" | "native"): boolean => ENABLE_STREAM_PROXY && mode !== "hls";

const toStreamProxyUrl = (url: string): string => `/api/stream?url=${encodeURIComponent(url)}`;

const isCrossOriginStream = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
};

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
  const mpegtsRef = useRef<ReturnType<typeof mpegts.createPlayer> | null>(null);
  const switchingSourceRef = useRef(false);
  const hasAppliedResumeRef = useRef(false);
  const hideTimerRef = useRef<number | null>(null);
  const startupTimerRef = useRef<number | null>(null);

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
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      if (!(reason instanceof Error || reason instanceof DOMException)) return;
      const message = `${reason.name} ${reason.message}`.toLowerCase();
      if (message.includes("aborterror") && message.includes("bodystreambuffer was aborted")) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => window.removeEventListener("unhandledrejection", onUnhandledRejection);
  }, []);

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

  const clearStartupTimer = useCallback(() => {
    if (startupTimerRef.current != null) {
      window.clearTimeout(startupTimerRef.current);
      startupTimerRef.current = null;
    }
  }, []);

  const destroyMpegTsPlayer = useCallback(() => {
    if (!mpegtsRef.current) return;
    const player = mpegtsRef.current;
    mpegtsRef.current = null;
    try {
      player.pause();
    } catch {
      // no-op
    }
    try {
      player.detachMediaElement();
    } catch {
      // no-op
    }
    try {
      player.destroy();
    } catch {
      // no-op
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
    destroyMpegTsPlayer();

    const onLoadedMetadata = () => {
      const resumePoint = resumeFromRef.current;
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      if (hasAppliedResumeRef.current) return;
      if (resumePoint > 3 && Number.isFinite(video.duration) && resumePoint < video.duration) {
        video.currentTime = resumePoint;
      }
      hasAppliedResumeRef.current = true;
    };
    const onLoadedData = () => {
      clearStartupTimer();
      setLoading(false);
    };
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
    const onPlaying = () => {
      clearStartupTimer();
      setLoading(false);
    };
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
    type PlaybackMode = "hls" | "mpegts" | "native";
    const modeLabel = (mode: PlaybackMode): "hls.js" | "mpegts.js" | "native-video" =>
      mode === "hls" ? "hls.js" : mode === "mpegts" ? "mpegts.js" : "native-video";
    let attemptIndex = 0;
    const tsVariantCandidate = toPathTsUrl(item.streamUrl);
    const fallbackCandidates = [tsVariantCandidate, toHlsVariantUrl(item.streamUrl), toOutputM3u8Url(item.streamUrl), toPathM3u8Url(item.streamUrl)]
      .filter((value, index, arr): value is string => Boolean(value) && arr.indexOf(value) === index);
    const isTsFallbackCase = isTransportStreamUrl(item.streamUrl) && fallbackCandidates.length > 0;
    const playbackAttempts: Array<{ url: string; mode: PlaybackMode; viaProxy: boolean; reason: string }> = [];
    const pushAttempt = (url: string, mode: PlaybackMode, viaProxy: boolean, reason: string) => {
      if (playbackAttempts.some((attempt) => attempt.url === url && attempt.mode === mode && attempt.viaProxy === viaProxy)) return;
      playbackAttempts.push({ url, mode, viaProxy, reason });
    };
    const pushModeAttempts = (url: string, mode: PlaybackMode, reason: string) => {
      const allowProxy = shouldUseStreamProxy(mode);
      const proxyFirst = allowProxy && isCrossOriginStream(url);
      if (proxyFirst) {
        pushAttempt(url, mode, true, `${reason}-via-proxy`);
        pushAttempt(url, mode, false, reason);
        return;
      }
      pushAttempt(url, mode, false, reason);
      if (allowProxy) pushAttempt(url, mode, true, `${reason}-via-proxy`);
    };
    const primaryMode: PlaybackMode =
      item.section === "live" && !isKnownNativeVideoUrl(item.streamUrl) && shouldTryMpegTsEngine(item.streamUrl, item.section)
        ? "mpegts"
        : shouldPreferHlsEngine(item.streamUrl, item.section)
          ? "hls"
          : shouldTryMpegTsEngine(item.streamUrl, item.section)
            ? "mpegts"
            : "native";
    pushModeAttempts(item.streamUrl, primaryMode, "primary");
    if (primaryMode !== "hls") pushModeAttempts(item.streamUrl, "hls", "hls-fallback-same-url");
    if (primaryMode !== "mpegts") pushModeAttempts(item.streamUrl, "mpegts", "mpegts-fallback-same-url");
    pushModeAttempts(item.streamUrl, "native", "native-fallback-same-url");
    for (const fallbackCandidate of fallbackCandidates) {
      if (/\.ts(\?|$)/i.test(fallbackCandidate)) {
        pushModeAttempts(fallbackCandidate, "mpegts", "derived-ts-url");
        pushModeAttempts(fallbackCandidate, "native", "native-fallback-derived-ts-url");
        continue;
      }
      pushModeAttempts(fallbackCandidate, "hls", "derived-hls-url");
      pushModeAttempts(fallbackCandidate, "mpegts", "mpegts-fallback-derived-url");
      pushModeAttempts(fallbackCandidate, "native", "native-fallback-derived-url");
    }
    const playbackDebugContext = {
      itemId: item.id,
      title: item.title,
      section: item.section,
      streamCandidates: playbackAttempts.map((attempt) => `${attempt.mode}${attempt.viaProxy ? "+proxy" : ""}:${attempt.url}`),
      autoplay,
      hlsSupported: Hls.isSupported(),
      mpegtsSupported: canUseMpegTsEngine(),
    };

    console.info("[IPTV][Player] Starting stream playback", playbackDebugContext);

    const tryNextAttempt = (reason: string): boolean => {
      const nextIndex = attemptIndex + 1;
      if (nextIndex >= playbackAttempts.length) return false;
      console.warn("[IPTV][Player] Switching to fallback source", {
        ...playbackDebugContext,
        reason,
        fromUrl: playbackAttempts[attemptIndex].url,
        fromMode: `${modeLabel(playbackAttempts[attemptIndex].mode)}${playbackAttempts[attemptIndex].viaProxy ? "+proxy" : ""}`,
        toUrl: playbackAttempts[nextIndex].url,
        toMode: `${modeLabel(playbackAttempts[nextIndex].mode)}${playbackAttempts[nextIndex].viaProxy ? "+proxy" : ""}`,
        fromAttempt: attemptIndex,
        toAttempt: nextIndex,
      });
      attemptIndex = nextIndex;
      startCandidate(playbackAttempts[nextIndex]);
      return true;
    };

    const finalizeError = (message: string) => {
      clearStartupTimer();
      console.error("[IPTV][Player] Playback failed", {
        ...playbackDebugContext,
        message,
        activeAttempt: attemptIndex,
        activeUrl: playbackAttempts[attemptIndex]?.url,
        activeMode: playbackAttempts[attemptIndex]
          ? `${modeLabel(playbackAttempts[attemptIndex].mode)}${playbackAttempts[attemptIndex].viaProxy ? "+proxy" : ""}`
          : "native-video",
      });
      setLocalError(message);
      onErrorRef.current(message);
      setLoading(false);
    };

    const playCurrent = () => {
      if (!autoplay) return;
      void video.play().catch(() => {
        onErrorRef.current("Autoplay is blocked by browser policy. Press play to start.");
      });
    };

    const startCandidate = (attempt: { url: string; mode: PlaybackMode; viaProxy: boolean; reason: string }) => {
      const { url: sourceUrl, mode, viaProxy, reason } = attempt;
      const requestUrl = viaProxy ? toStreamProxyUrl(sourceUrl) : sourceUrl;
      const timeoutMs = mode === "mpegts" ? MPEGTS_STARTUP_TIMEOUT_MS : SOURCE_STARTUP_TIMEOUT_MS;
      const armStartupTimeout = () => {
        clearStartupTimer();
        startupTimerRef.current = window.setTimeout(() => {
          console.error("[IPTV][Player] Source startup timeout", {
            ...playbackDebugContext,
            attempt: attemptIndex,
            sourceUrl,
            requestUrl,
            sourceMode: `${modeLabel(mode)}${viaProxy ? "+proxy" : ""}`,
            timeoutMs,
            readyState: video.readyState,
            networkState: video.networkState,
          });
          if (!tryNextAttempt("startup-timeout")) {
            const message = "Stream is taking too long to start. Provider may be blocking browser playback.";
            finalizeError(message);
          }
        }, timeoutMs);
      };
      switchingSourceRef.current = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      destroyMpegTsPlayer();
      video.pause();
      video.removeAttribute("src");
      video.load();
      setLoading(true);
      setLocalError(null);
      onErrorRef.current(null);
      if (autoplay) {
        armStartupTimeout();
      }
      console.info("[IPTV][Player] Trying source", {
        ...playbackDebugContext,
        sourceUrl,
        requestUrl,
        attempt: attemptIndex,
        attemptReason: reason,
        mode: `${modeLabel(mode)}${viaProxy ? "+proxy" : ""}`,
      });
      if (mode === "hls") {
        const hls = new Hls();
        hlsRef.current = hls;
        hls.loadSource(requestUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.info("[IPTV][Player] HLS manifest parsed", {
            ...playbackDebugContext,
            sourceUrl,
            requestUrl,
            attempt: attemptIndex,
          });
        });
        hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
          console.info("[IPTV][Player] HLS level loaded", {
            ...playbackDebugContext,
            sourceUrl,
            requestUrl,
            attempt: attemptIndex,
            level: data.level,
            totalDuration: data.details?.totalduration,
            live: data.details?.live,
          });
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal) return;
          console.error("[IPTV][Player] Fatal HLS error", {
            ...playbackDebugContext,
            sourceUrl,
            requestUrl,
            attempt: attemptIndex,
            hlsErrorType: data.type,
            hlsErrorDetails: data.details,
            hlsErrorFatal: data.fatal,
            hlsErrorResponseCode: data.response?.code,
            hlsErrorResponseText: data.response?.text,
          });
          if (tryNextAttempt("fatal-hls-error")) return;
          const message = isTsFallbackCase
            ? "This provider appears to use MPEG-TS. Browser playback usually requires an HLS (.m3u8) stream."
            : "HLS playback error. Try retrying this stream.";
          finalizeError(message);
        });
      } else if (mode === "mpegts") {
        const player = mpegts.createPlayer(
          {
            type: "mpegts",
            url: requestUrl,
            isLive: item.section === "live",
            cors: true,
            withCredentials: false,
          },
          {
            isLive: item.section === "live",
            // Favor progressive live playback over large prebuffering.
            enableStashBuffer: false,
            stashInitialSize: 128 * 1024,
            lazyLoad: false,
            deferLoadAfterSourceOpen: false,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 1.0,
            liveBufferLatencyMinRemain: 0.2,
            liveSync: item.section === "live",
            liveSyncMaxLatency: 1.0,
            liveSyncTargetLatency: 0.4,
            liveSyncPlaybackRate: 1.2,
          },
        );
        mpegtsRef.current = player;
        player.attachMediaElement(video);
        player.load();
        player.on(mpegts.Events.STATISTICS_INFO, (info: unknown) => {
          const speed = (info as { speed?: number } | null)?.speed ?? 0;
          if (autoplay && speed > 0) {
            // Keep trying while data is actively flowing to MSE.
            armStartupTimeout();
          }
        });
        if (autoplay) {
          const started = player.play();
          if (started && typeof (started as Promise<void>).catch === "function") {
            void (started as Promise<void>).catch((error: unknown) => {
              if (isAbortLikeError(error)) return;
              onErrorRef.current("Autoplay is blocked by browser policy. Press play to start.");
            });
          }
        }
        player.on(mpegts.Events.ERROR, (errorType: unknown, errorDetails: unknown, errorInfo: unknown) => {
          console.error("[IPTV][Player] MPEGTS error", {
            ...playbackDebugContext,
            sourceUrl,
            requestUrl,
            attempt: attemptIndex,
            errorType,
            errorDetails,
            errorInfo,
          });
          if (tryNextAttempt("mpegts-error")) return;
          finalizeError("MPEG-TS playback error. Stream may require provider-specific headers or token handling.");
        });
      } else {
        video.src = requestUrl;
      }
      switchingSourceRef.current = false;
      playCurrent();
      if (!autoplay) {
        setLoading(false);
      }
    };

    const onErrorEvent = () => {
      if (switchingSourceRef.current) return;
      const mediaErr = video.error;
      console.error("[IPTV][Player] Native video error event", {
        ...playbackDebugContext,
        attempt: attemptIndex,
        sourceUrl: playbackAttempts[attemptIndex]?.url,
        sourceMode: playbackAttempts[attemptIndex]
          ? `${modeLabel(playbackAttempts[attemptIndex].mode)}${playbackAttempts[attemptIndex].viaProxy ? "+proxy" : ""}`
          : "native-video",
        currentSrc: video.currentSrc,
        networkState: video.networkState,
        readyState: video.readyState,
        mediaErrorCode: mediaErr?.code,
        mediaErrorName: mediaErrorName(mediaErr?.code),
        mediaErrorMessage: mediaErr?.message,
      });
      if (tryNextAttempt("native-video-error")) return;
      const message = isTsFallbackCase
        ? "This stream looks like MPEG-TS and may download instead of playing in browser. Try an HLS (.m3u8) variant from your provider."
        : "Playback failed. Stream may be unavailable or blocked.";
      finalizeError(message);
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

    startCandidate(playbackAttempts[attemptIndex]);

    return () => {
      clearStartupTimer();
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
      destroyMpegTsPlayer();
    };
  }, [item, autoplay, clearStartupTimer, destroyMpegTsPlayer]);

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
