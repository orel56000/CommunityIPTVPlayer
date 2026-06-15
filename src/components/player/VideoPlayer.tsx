import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import type { PlaylistItem } from "../../types/models";
import { useChromecast } from "../../hooks/useChromecast";
import { downloadMediaFile, isHlsUrl } from "../../utils/downloadStream";
import { buildLivePlaybackAttempts, toXtreamTsUrl } from "../../utils/xtreamStreamUrl";
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
  className?: string;
}

const CONTROLS_HIDE_MS = 2400;
const SOURCE_STARTUP_TIMEOUT_MS = 12000;
const MPEGTS_STARTUP_TIMEOUT_MS = 25000;

const isTransportStreamUrl = (url: string): boolean => {
  const lower = url.toLowerCase();
  return /\.ts(\?|$)/i.test(url) || /[?&]output=ts(?:&|$)/i.test(url) || lower.includes("output=ts");
};

const shouldUseHlsEngine = (url: string): boolean => {
  if (!Hls.isSupported()) return false;
  const lower = url.toLowerCase();
  return isHlsUrl(url) || lower.includes("output=m3u8") || lower.includes("format=m3u8");
};

const canUseMpegTsEngine = (): boolean => mpegts.isSupported() && Boolean(mpegts.getFeatureList().mseLivePlayback);

const isKnownNativeVideoUrl = (url: string): boolean =>
  /\.(mp4|m4v|webm|mov|avi|mkv|mpg|mpeg)(\?|$)/i.test(url.toLowerCase());

type PlaybackMode = "hls" | "mpegts" | "native";

const resolvePlaybackMode = (url: string, section: PlaylistItem["section"]): PlaybackMode => {
  if (section === "live") return "hls";
  if (shouldUseHlsEngine(url)) return "hls";
  if (isTransportStreamUrl(url) && canUseMpegTsEngine()) return "mpegts";
  if (isKnownNativeVideoUrl(url)) return "native";
  return "native";
};

const modeLabel = (mode: PlaybackMode): string =>
  mode === "hls" ? "hls.js" : mode === "mpegts" ? "mpegts.js" : "native-video";

/** hls.js tuning for live TV — prioritize smooth playback over minimum latency. */
const createLiveHls = (viaRestream: boolean): Hls =>
  new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 60,
    maxBufferLength: viaRestream ? 90 : 60,
    maxMaxBufferLength: 120,
    // Stay a few segments behind the live edge so the buffer does not run dry.
    liveSyncDurationCount: viaRestream ? 6 : 4,
    liveMaxLatencyDurationCount: viaRestream ? 18 : 12,
    maxLiveSyncPlaybackRate: 1.15,
    liveDurationInfinity: true,
    manifestLoadingTimeOut: 20_000,
    manifestLoadingMaxRetry: 6,
    levelLoadingTimeOut: 20_000,
    fragLoadingTimeOut: 30_000,
    fragLoadingMaxRetry: 8,
  });

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

const isCrossOriginStream = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.origin !== window.location.origin;
  } catch {
    return false;
  }
};

const hasMpegTsSyncByte = (bytes: Uint8Array): boolean => {
  const limit = Math.min(bytes.length, 1024);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0x47) return true;
  }
  return false;
};

type StreamPayloadKind = "hls-manifest" | "mpegts" | "html" | "unknown" | "empty";

const classifyStreamPayload = (contentType: string, bytes: Uint8Array): StreamPayloadKind => {
  if (bytes.length === 0) return "empty";
  if (contentType.includes("text/html") || bytes[0] === 0x3c /* < */) return "html";
  const textStart = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 32))).trimStart();
  if (textStart.startsWith("#EXTM3U") || textStart.startsWith("#EXT")) return "hls-manifest";
  if (contentType.includes("mpegurl") || contentType.includes("x-mpegurl")) return "hls-manifest";
  if (hasMpegTsSyncByte(bytes) || contentType.includes("mp2t")) return "mpegts";
  return "unknown";
};

const formatBodyPreview = (bytes: Uint8Array): { text: string; hex: string } => {
  const slice = bytes.slice(0, 256);
  const text = new TextDecoder(undefined, { fatal: false })
    .decode(slice)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .trim()
    .slice(0, 200);
  const hex = Array.from(slice.slice(0, 48))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
  return { text, hex };
};

const describePayloadKind = (kind: StreamPayloadKind): string => {
  switch (kind) {
    case "hls-manifest":
      return "Valid HLS manifest (#EXTM3U)";
    case "mpegts":
      return "MPEG-TS binary (0x47 sync byte)";
    case "html":
      return "HTML page (not video) — often Cloudflare or provider error page";
    case "empty":
      return "Empty response body";
    default:
      return "Unknown binary/text — not recognized as HLS or MPEG-TS";
  }
};

const userMessageFromDiagnostic = (
  diagnostic: Record<string, unknown>,
  playbackMode: PlaybackMode,
): string | null => {
  const preview = String(diagnostic.bodyPreviewText ?? "").toLowerCase();
  const payloadKind = diagnostic.payloadKind;
  const urlExtension = String(diagnostic.urlExtension ?? "");

  if (preview.includes("xui.one") && preview.includes("debug mode")) {
    return "Provider panel (XUI.one) is in Debug Mode and returned an HTML page instead of video. Ask your provider to disable debug mode, or re-import with Live output: MPEG-TS (.ts).";
  }
  if (payloadKind === "html") {
    if (preview.includes("cloudflare") || preview.includes("just a moment")) {
      return "Provider returned a Cloudflare challenge page instead of video. Native IPTV apps may still work; browser playback is blocked.";
    }
    return "Provider returned an HTML page instead of a video stream (HTTP 200 but not video data).";
  }
  if (urlExtension === "m3u8" && payloadKind === "mpegts") {
    return "This URL ends in .m3u8 but the server sends MPEG-TS. Re-import the playlist with Live output: MPEG-TS (.ts).";
  }
  if (urlExtension === "m3u8" && payloadKind !== "hls-manifest" && diagnostic.probeFetch === "ok") {
    return `URL ends in .m3u8 but the server did not return an HLS manifest (got: ${String(diagnostic.payloadMeaning ?? payloadKind)}). Re-import with Live output: MPEG-TS (.ts).`;
  }
  if (urlExtension === "ts" && payloadKind === "hls-manifest") {
    return "URL ends in .ts but the server returned an HLS manifest. Re-import with Live output: HLS (.m3u8).";
  }
  if (diagnostic.probeFetch === "failed") {
    return `Browser could not fetch the stream URL (${String(diagnostic.fetchError ?? "network/CORS")}).`;
  }
  if (playbackMode === "hls" && payloadKind !== "hls-manifest" && payloadKind !== "unknown") {
    return `Cannot play as HLS: ${String(diagnostic.payloadMeaning ?? payloadKind)}`;
  }
  return null;
};

const resolveLiveFailureMessage = (
  reason: string,
  diagnostic: Record<string, unknown>,
  restreamProbe: Record<string, unknown> | undefined,
  options: {
    attemptLabel?: string;
    triedRestream: boolean;
    vlcFallbackUrl: string | null;
    userMessage?: string;
  },
): string => {
  if (options.userMessage) return options.userMessage;

  if (options.triedRestream) {
    const restreamText = String(restreamProbe?.bodyPreviewText ?? "");
    if (restreamProbe?.probeFetch === "failed") {
      return `Live restream could not be reached (${String(restreamProbe.fetchError ?? reason)}). Restart the dev server and try again.`;
    }
    if (restreamText && !restreamText.includes("#EXTM3U") && restreamProbe?.httpStatus !== 200) {
      return `Live restream failed (${reason}).`;
    }
    return `Live restream interrupted (${reason}). Try playing the channel again.${
      options.vlcFallbackUrl ? ` Or open in VLC: ${options.vlcFallbackUrl}` : ""
    }`;
  }

  if (options.attemptLabel === "direct-hls" || !options.triedRestream) {
    const probeMessage = userMessageFromDiagnostic(diagnostic, "hls");
    if (probeMessage) return probeMessage;
  }

  return options.vlcFallbackUrl
    ? `Playback failed (${reason}). This stream may work in VLC: ${options.vlcFallbackUrl}`
    : `Playback failed (${reason}).`;
};

/** Fetch first bytes of the stream URL and return a paste-friendly diagnostic object. */
const diagnoseStreamUrl = async (streamUrl: string): Promise<Record<string, unknown>> => {
  const urlExtension = streamUrl.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.toLowerCase() ?? "none";
  const crossOrigin = isCrossOriginStream(streamUrl);
  const base: Record<string, unknown> = {
    streamUrl,
    urlExtension,
    crossOrigin,
    pageOrigin: window.location.origin,
  };

  try {
    const response = await fetch(streamUrl, {
      method: "GET",
      headers: { Range: "bytes=0-2047", Accept: "*/*" },
      cache: "no-store",
    });
    const contentType = response.headers.get("content-type") ?? "";
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const payloadKind = classifyStreamPayload(contentType.toLowerCase(), bytes);
    const preview = formatBodyPreview(bytes);
    return {
      ...base,
      probeFetch: "ok",
      httpStatus: response.status,
      contentType,
      contentLength: response.headers.get("content-length"),
      payloadKind,
      payloadMeaning: describePayloadKind(payloadKind),
      bodyPreviewText: preview.text || "(non-text or empty)",
      bodyPreviewHex: preview.hex || "(empty)",
      urlExtensionMatchesPayload:
        urlExtension === "m3u8"
          ? payloadKind === "hls-manifest"
          : urlExtension === "ts"
            ? payloadKind === "mpegts"
            : "n/a",
    };
  } catch (error) {
    return {
      ...base,
      probeFetch: "failed",
      fetchError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      likelyCause: crossOrigin
        ? "CORS block or network error on cross-origin fetch from browser"
        : "Network error reaching stream URL",
    };
  }
};

const logPlaybackReport = (reason: string, context: Record<string, unknown>, diagnostic: Record<string, unknown>) => {
  const report = {
    _instruction: "Copy the JSON block below and paste it in your support message",
    reason,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    ...context,
    streamProbe: diagnostic,
  };
  console.error("[IPTV][Player] PLAYBACK FAILED");
  console.error("[IPTV][Player] Paste this JSON:", JSON.stringify(report, null, 2));
  return report;
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
  className,
}: VideoPlayerProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<ReturnType<typeof mpegts.createPlayer> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioGraphFailedRef = useRef(false);
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

  const resumeAudioContext = useCallback(() => {
    const context = audioContextRef.current;
    if (!context || context.state === "running") return;
    void context.resume().catch(() => undefined);
  }, []);

  const ensureAudioGraph = useCallback((): boolean => {
    if (audioGraphFailedRef.current) return false;
    const video = videoRef.current;
    if (!video || typeof window === "undefined") return false;
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      audioGraphFailedRef.current = true;
      return false;
    }
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContextCtor();
      }
      if (!mediaSourceRef.current) {
        mediaSourceRef.current = audioContextRef.current.createMediaElementSource(video);
      }
      if (!gainNodeRef.current) {
        gainNodeRef.current = audioContextRef.current.createGain();
        mediaSourceRef.current.connect(gainNodeRef.current);
        gainNodeRef.current.connect(audioContextRef.current.destination);
      }
      return true;
    } catch {
      audioGraphFailedRef.current = true;
      return false;
    }
  }, []);

  useEffect(() => {
    if (!isCasting) return;
    onPlayingStateRef.current(!mirror.isPaused);
  }, [isCasting, mirror.isPaused]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const requestedVolume = muted ? 0 : Math.min(2, Math.max(0, volume));
    const shouldUseBoost = requestedVolume > 1.0001 || Boolean(gainNodeRef.current);

    if (shouldUseBoost && ensureAudioGraph()) {
      const context = audioContextRef.current;
      const gainNode = gainNodeRef.current;
      if (context?.state === "running" && gainNode) {
        video.muted = false;
        video.volume = 1;
        gainNode.gain.value = requestedVolume;
        return;
      }
      resumeAudioContext();
    }

    video.volume = Math.min(1, requestedVolume);
    video.muted = muted;
  }, [ensureAudioGraph, muted, resumeAudioContext, volume]);

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

    const streamUrl = item.streamUrl;
    const playbackMode = resolvePlaybackMode(streamUrl, item.section);
    const liveAttempts = item.section === "live" ? buildLivePlaybackAttempts(streamUrl) : [];
    const vlcFallbackUrl = item.section === "live" ? toXtreamTsUrl(streamUrl) : null;

    const playbackContext: Record<string, unknown> = {
      itemId: item.id,
      title: item.title,
      section: item.section,
      streamUrl,
      engine: modeLabel(playbackMode),
      autoplay,
      hlsSupported: Hls.isSupported(),
      mpegtsSupported: canUseMpegTsEngine(),
      crossOrigin: isCrossOriginStream(streamUrl),
      vlcFallbackUrl,
      playbackPlan: liveAttempts.map((attempt) => `${attempt.label}:${attempt.url}`),
    };

    let liveAttemptIndex = 0;
    let activeLiveAttempts = liveAttempts;
    let liveRestreamRetries = 0;

    const failPlayback = (
      reason: string,
      extra?: Record<string, unknown>,
      existingDiagnostic?: Record<string, unknown>,
    ) => {
      clearStartupTimer();
      void (async () => {
        const diagnostic = existingDiagnostic ?? (await diagnoseStreamUrl(streamUrl));
        const attemptLabel = typeof extra?.attemptLabel === "string" ? extra.attemptLabel : undefined;
        const playbackUrl = typeof extra?.playbackUrl === "string" ? extra.playbackUrl : undefined;
        const attemptsTried = activeLiveAttempts.slice(0, liveAttemptIndex + 1).map((a) => a.label);
        const triedRestream = attemptsTried.includes("restream-hls");
        let restreamProbe: Record<string, unknown> | undefined;
        if (triedRestream) {
          const restreamUrl =
            playbackUrl ??
            activeLiveAttempts.find((attempt) => attempt.label === "restream-hls")?.url ??
            "";
          if (restreamUrl) restreamProbe = await diagnoseStreamUrl(restreamUrl);
        }
        const userMessage = resolveLiveFailureMessage(reason, diagnostic, restreamProbe, {
          attemptLabel,
          triedRestream,
          vlcFallbackUrl,
          userMessage: typeof extra?.userMessage === "string" ? extra.userMessage : undefined,
        });
        logPlaybackReport(
          reason,
          {
            ...playbackContext,
            vlcFallbackUrl,
            attemptsTried,
            ...extra,
            restreamProbe,
          },
          diagnostic,
        );
        setLocalError(userMessage);
        onErrorRef.current(userMessage);
        setLoading(false);
      })();
    };

    const playCurrent = () => {
      if (!autoplay) return;
      void video.play().catch(() => {
        onErrorRef.current("Autoplay is blocked by browser policy. Press play to start.");
      });
    };

    const armStartupTimeout = (attemptLabel?: string) => {
      const timeoutMs =
        attemptLabel === "restream-hls" ? MPEGTS_STARTUP_TIMEOUT_MS : SOURCE_STARTUP_TIMEOUT_MS;
      clearStartupTimer();
      startupTimerRef.current = window.setTimeout(() => {
        if (item.section === "live" && liveAttemptIndex + 1 < activeLiveAttempts.length) {
          tryLiveHlsNext("startup-timeout");
          return;
        }
        failPlayback("startup-timeout", {
          timeoutMs,
          readyState: video.readyState,
          networkState: video.networkState,
          attemptLabel: activeLiveAttempts[liveAttemptIndex]?.label,
          playbackUrl: activeLiveAttempts[liveAttemptIndex]?.url,
        });
      }, timeoutMs);
    };

    const prepareVideo = () => {
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
    };

    let latestDiagnostic: Record<string, unknown> = {};

    const startLiveHls = (attemptIndex: number) => {
      const attempt = activeLiveAttempts[attemptIndex];
      if (!attempt) {
        failPlayback("no-live-attempts");
        return;
      }
      liveAttemptIndex = attemptIndex;
      if (attempt.label !== "restream-hls") {
        liveRestreamRetries = 0;
      }
      prepareVideo();
      if (autoplay) armStartupTimeout(attempt.label);

      console.info("[IPTV][Player] Live playback attempt", {
        ...playbackContext,
        attempt: attemptIndex,
        attemptLabel: attempt.label,
        playbackUrl: attempt.url,
      });

      const hls = createLiveHls(attempt.label === "restream-hls");
      hlsRef.current = hls;
      hls.loadSource(attempt.url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        clearStartupTimer();
        console.info("[IPTV][Player] HLS manifest parsed", {
          ...playbackContext,
          attemptLabel: attempt.label,
          playbackUrl: attempt.url,
        });
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data?.fatal) {
          console.warn("[IPTV][Player] HLS non-fatal error", {
            ...playbackContext,
            attemptLabel: attempt.label,
            hlsErrorType: data.type,
            hlsErrorDetails: data.details,
          });
          return;
        }
        if (liveAttemptIndex + 1 < activeLiveAttempts.length) {
          tryLiveHlsNext("hls-fatal", {
            hlsErrorType: data.type,
            hlsErrorDetails: data.details,
            hlsErrorResponseCode: data.response?.code,
            hlsErrorResponseText: data.response?.text?.slice(0, 300),
          });
          return;
        }
        if (attempt.label === "restream-hls" && liveRestreamRetries < 1) {
          liveRestreamRetries += 1;
          console.warn("[IPTV][Player] Restream HLS error, restarting restream once", {
            ...playbackContext,
            attemptLabel: attempt.label,
            hlsErrorDetails: data.details,
          });
          window.setTimeout(() => startLiveHls(attemptIndex), 600);
          return;
        }
        failPlayback(
          "hls-fatal",
          {
            hlsErrorType: data.type,
            hlsErrorDetails: data.details,
            hlsErrorResponseCode: data.response?.code,
            hlsErrorResponseText: data.response?.text?.slice(0, 300),
            attemptLabel: attempt.label,
            playbackUrl: attempt.url,
          },
          latestDiagnostic,
        );
      });
      switchingSourceRef.current = false;
      playCurrent();
      if (!autoplay) setLoading(false);
    };

    const tryLiveHlsNext = (reason: string, extra?: Record<string, unknown>) => {
      const nextIndex = liveAttemptIndex + 1;
      if (nextIndex >= activeLiveAttempts.length) {
        failPlayback(reason, extra, latestDiagnostic);
        return;
      }
      console.warn("[IPTV][Player] Switching live playback method", {
        ...playbackContext,
        reason,
        from: activeLiveAttempts[liveAttemptIndex],
        to: activeLiveAttempts[nextIndex],
      });
      startLiveHls(nextIndex);
    };

    void (async () => {
      latestDiagnostic = await diagnoseStreamUrl(streamUrl);
      const playbackPlan = item.section === "live" ? activeLiveAttempts.map((a) => `${a.label}:${a.url}`) : [streamUrl];
      console.info("[IPTV][Player] Starting playback", {
        ...playbackContext,
        playbackPlan,
        streamProbe: latestDiagnostic,
      });
      console.info(
        "[IPTV][Player] Paste this JSON:",
        JSON.stringify({ ...playbackContext, playbackPlan, streamProbe: latestDiagnostic }, null, 2),
      );

      if (item.section === "live") {
        if (latestDiagnostic.payloadKind === "html" || latestDiagnostic.urlExtensionMatchesPayload === false) {
          activeLiveAttempts = liveAttempts.filter((attempt) => attempt.label !== "direct-hls");
          if (activeLiveAttempts.length === 0) activeLiveAttempts = liveAttempts;
        }
        if (activeLiveAttempts.length === 0) {
          failPlayback("no-live-attempts", undefined, latestDiagnostic);
          return;
        }
        startLiveHls(0);
        return;
      }

      const probeBlockMessage = userMessageFromDiagnostic(latestDiagnostic, playbackMode);
      if (probeBlockMessage && latestDiagnostic.payloadKind !== "unknown") {
        failPlayback("stream-probe-blocked", { userMessage: probeBlockMessage }, latestDiagnostic);
        return;
      }

      prepareVideo();
      if (autoplay) armStartupTimeout();

      if (playbackMode === "hls") {
        const hls = new Hls();
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.info("[IPTV][Player] HLS manifest parsed", playbackContext);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data?.fatal) {
            console.warn("[IPTV][Player] HLS non-fatal error", {
              ...playbackContext,
              hlsErrorType: data.type,
              hlsErrorDetails: data.details,
            });
            return;
          }
          failPlayback(
            "hls-fatal",
            {
              hlsErrorType: data.type,
              hlsErrorDetails: data.details,
              hlsErrorResponseCode: data.response?.code,
              hlsErrorResponseText: data.response?.text?.slice(0, 300),
            },
            latestDiagnostic,
          );
        });
        switchingSourceRef.current = false;
        playCurrent();
        if (!autoplay) setLoading(false);
        return;
      }

      if (playbackMode === "mpegts") {
        const player = mpegts.createPlayer(
          {
            type: "mpegts",
            url: streamUrl,
            isLive: false,
            cors: true,
            withCredentials: false,
          },
          {
            isLive: false,
            enableStashBuffer: false,
            stashInitialSize: 128 * 1024,
            lazyLoad: false,
            deferLoadAfterSourceOpen: false,
            liveBufferLatencyChasing: true,
            liveBufferLatencyMaxLatency: 1.0,
            liveBufferLatencyMinRemain: 0.2,
            liveSync: false,
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
          if (autoplay && speed > 0) armStartupTimeout();
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
          failPlayback("mpegts-error", { errorType, errorDetails, errorInfo });
        });
        switchingSourceRef.current = false;
        playCurrent();
        if (!autoplay) setLoading(false);
        return;
      }

      video.src = streamUrl;
      switchingSourceRef.current = false;
      playCurrent();
      if (!autoplay) setLoading(false);
    })();

    const onErrorEvent = () => {
      if (switchingSourceRef.current) return;
      const mediaErr = video.error;
      failPlayback("native-video-error", {
        currentSrc: video.currentSrc,
        networkState: video.networkState,
        readyState: video.readyState,
        mediaErrorCode: mediaErr?.code,
        mediaErrorName: mediaErrorName(mediaErr?.code),
        mediaErrorMessage: mediaErr?.message,
      });
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
      if (gainNodeRef.current) {
        try {
          gainNodeRef.current.disconnect();
        } catch {
          // no-op
        }
        gainNodeRef.current = null;
      }
      if (mediaSourceRef.current) {
        try {
          mediaSourceRef.current.disconnect();
        } catch {
          // no-op
        }
        mediaSourceRef.current = null;
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
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
    resumeAudioContext();
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  }, [item, isCasting, castPlayPause, resumeAudioContext]);

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
      const clamped = Math.min(2, Math.max(0, value));
      if (clamped > 1) resumeAudioContext();
      onVolume(clamped);
      if (isCasting) castSetVolumeLevel(clamped);
    },
    [onVolume, isCasting, castSetVolumeLevel, resumeAudioContext],
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
          handleOverlayVolume(Math.min(2, (volume || 0) + 0.05));
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
    <div className={clsx("panel flex min-h-0 flex-col overflow-hidden", className)}>
      <div
        ref={containerRef}
        className="player-viewport group/player relative"
        onPointerMove={bumpControls}
        onPointerLeave={() => {
          if (displayPlaying && !displayLoading && !localError) setControlsVisible(false);
        }}
        onFocus={showControls}
        tabIndex={0}
      >
        <video
          ref={videoRef}
          className="max-h-full max-w-full object-contain"
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
