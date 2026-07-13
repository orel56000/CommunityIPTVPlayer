import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaylistItem } from "../types/models";
import { getRelayBase } from "../utils/secureUrl";
import { toXtreamTsUrl } from "../utils/xtreamStreamUrl";

const DEFAULT_RECEIVER = "CC1AD845";
const FALLBACK_CAST_STATE = {
  NOT_CONNECTED: "NOT_CONNECTED" as cast.framework.CastState,
  CONNECTED: "CONNECTED" as cast.framework.CastState,
  NO_DEVICES_AVAILABLE: "NO_DEVICES_AVAILABLE" as cast.framework.CastState,
};

const getCastFramework = (): typeof cast.framework | null =>
  typeof window === "undefined" ? null : window.cast?.framework ?? null;

const getCastStates = (): typeof cast.framework.CastState | typeof FALLBACK_CAST_STATE =>
  getCastFramework()?.CastState ?? FALLBACK_CAST_STATE;

const getCastContext = (): cast.framework.CastContext | null => {
  const framework = getCastFramework();
  if (!framework?.CastContext) return null;
  try {
    return framework.CastContext.getInstance();
  } catch {
    return null;
  }
};

const contentTypeForUrl = (url: string): string =>
  url.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4";

const buildLoadRequest = (item: PlaylistItem): chrome.cast.media.LoadRequest => {
  const mediaInfo = new chrome.cast.media.MediaInfo(item.streamUrl, contentTypeForUrl(item.streamUrl));
  const metadata = new chrome.cast.media.GenericMediaMetadata();
  metadata.title = item.title;
  mediaInfo.metadata = metadata;
  return new chrome.cast.media.LoadRequest(mediaInfo);
};

const loadMediaOnSession = async (
  session: cast.framework.CastSession,
  item: PlaylistItem,
): Promise<string | null> => {
  const code = await session.loadMedia(buildLoadRequest(item));
  if (code === undefined) return null;
  return typeof code === "string" ? code : `error ${String(code)}`;
};

export interface CastMirrorState {
  currentTime: number;
  duration: number;
  isPaused: boolean;
  isMediaLoaded: boolean;
}

const emptyMirror: CastMirrorState = {
  currentTime: 0,
  duration: 0,
  isPaused: true,
  isMediaLoaded: false,
};

// ---------------------------------------------------------------------------
// Relay-native cast backend (macOS WKWebView has no chrome.cast; the app's
// relay speaks the Cast protocol itself — see src-tauri/src/cast.rs).
// ---------------------------------------------------------------------------

export interface RelayCastDevice {
  name: string;
  host: string;
  port: number;
}

interface RelayCastSnapshot {
  active: boolean;
  device_name?: string;
  host?: string;
  player_state?: string;
  current_time?: number;
  duration?: number;
  muted?: boolean;
  error?: string | null;
}

const relayApi = (path: string): string => `${getRelayBase()}${path}`;

const relayCastStatus = async (): Promise<RelayCastSnapshot | null> => {
  try {
    const res = await fetch(relayApi("/api/cast/status"), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RelayCastSnapshot;
  } catch {
    return null;
  }
};

/** Media the Cast device should fetch. VOD goes straight to the provider (the
 * device shares the home IP, and mp4 playback needs no CORS); live TV uses the
 * relay's ffmpeg HLS restream on the LAN address. */
const buildRelayCastMedia = (
  item: PlaylistItem,
  lanOrigin: string | null,
): { url: string; content_type: string; live: boolean } | null => {
  if (item.section === "live") {
    if (!lanOrigin) return null;
    const ts = toXtreamTsUrl(item.streamUrl) ?? item.streamUrl;
    return {
      url: `${lanOrigin}/api/restream/index.m3u8?url=${encodeURIComponent(ts)}`,
      content_type: "application/x-mpegURL",
      live: true,
    };
  }
  return { url: item.streamUrl, content_type: contentTypeForUrl(item.streamUrl), live: false };
};

/**
 * Chromecast support with two backends behind one interface:
 * - Google Cast Web Sender (CAF) where `chrome.cast` exists (Chrome, WebView2).
 * - The app relay's native Cast implementation everywhere else (WKWebView).
 */
export const useChromecast = (
  item: PlaylistItem | null,
  onRemoteProgress?: (positionSec: number, durationSec: number) => void,
) => {
  const itemRef = useRef(item);
  const onRemoteProgressRef = useRef(onRemoteProgress);

  useEffect(() => {
    itemRef.current = item;
  }, [item]);

  useEffect(() => {
    onRemoteProgressRef.current = onRemoteProgress;
  }, [onRemoteProgress]);

  const [sdkReady, setSdkReady] = useState(false);
  const [castState, setCastState] = useState<cast.framework.CastState>(() => {
    return getCastContext()?.getCastState() ?? getCastStates().NOT_CONNECTED;
  });
  const [mirror, setMirror] = useState<CastMirrorState>(emptyMirror);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [castMessage, setCastMessage] = useState<string | null>(null);
  const clearCastMessage = useCallback(() => setCastMessage(null), []);

  // Relay backend state
  const [relayCastAvailable, setRelayCastAvailable] = useState(false);
  const [relayCasting, setRelayCasting] = useState(false);
  const [castDevices, setCastDevices] = useState<RelayCastDevice[] | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);
  const lanOriginRef = useRef<string | null>(null);
  const lastDeviceRef = useRef<RelayCastDevice | null>(null);
  const relayMutedRef = useRef(false);

  const remotePlayerRef = useRef<cast.framework.RemotePlayer | null>(null);
  const remoteControllerRef = useRef<cast.framework.RemotePlayerController | null>(null);
  const mirrorHandlerRef = useRef<(() => void) | null>(null);

  const refreshCastContext = useCallback(() => {
    const ctx = getCastContext();
    if (!ctx) return;
    setCastState(ctx.getCastState());
    const session = ctx.getCurrentSession();
    setDeviceName(session?.getCastDevice()?.friendlyName ?? null);
  }, []);

  // Google SDK arming (no-op where chrome.cast can't exist).
  useEffect(() => {
    if (typeof window === "undefined") return;

    const tryArm = (): boolean => {
      const ctx = getCastContext();
      if (!ctx) return false;
      ctx.getCastState();
      setSdkReady(true);
      refreshCastContext();
      return true;
    };

    if (tryArm()) return;

    const prev = window.__onGCastApiAvailable;
    window.__onGCastApiAvailable = (isAvailable: boolean, reason?: string) => {
      prev?.(isAvailable, reason);
      if (isAvailable) {
        const ctx = getCastContext();
        try {
          if (!ctx) throw new Error("CastContext unavailable");
          ctx.setOptions({
            receiverApplicationId: chrome.cast.media?.DEFAULT_MEDIA_RECEIVER_APP_ID ?? DEFAULT_RECEIVER,
            autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
            resumeSavedSession: false,
          });
        } catch {
          /* setOptions may have run from index.html */
        }
        setSdkReady(true);
        refreshCastContext();
      }
    };

    const id = window.setInterval(() => {
      if (tryArm()) window.clearInterval(id);
    }, 250);

    return () => window.clearInterval(id);
  }, [refreshCastContext]);

  // Relay backend probe: the endpoint answers only from the local relay, and
  // we also learn the LAN origin the Cast device must use for restreams.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const status = await relayCastStatus();
      if (cancelled || !status) return;
      setRelayCastAvailable(true);
      if (status.active) setRelayCasting(true);
      try {
        const res = await fetch(relayApi("/api/server-info"), { cache: "no-store" });
        if (res.ok) {
          const info = (await res.json()) as { origins?: string[] };
          const lan = info.origins?.find(
            (origin) => !origin.includes("127.0.0.1") && !origin.includes("localhost"),
          );
          if (!cancelled) lanOriginRef.current = lan ?? info.origins?.[0] ?? null;
        }
      } catch {
        /* keep null; live-TV casting will report it */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sdkReady) return;
    const ctx = getCastContext();
    const framework = getCastFramework();
    if (!ctx || !framework) return;

    const onCastState = () => {
      refreshCastContext();
      const session = ctx.getCurrentSession();
      setDeviceName(session?.getCastDevice()?.friendlyName ?? null);
    };

    ctx.addEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, onCastState);
    ctx.addEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, onCastState);
    return () => {
      ctx.removeEventListener(framework.CastContextEventType.CAST_STATE_CHANGED, onCastState);
      ctx.removeEventListener(framework.CastContextEventType.SESSION_STATE_CHANGED, onCastState);
    };
  }, [sdkReady, refreshCastContext]);

  const attachRemotePlayer = useCallback(() => {
    if (remotePlayerRef.current && remoteControllerRef.current) return;
    const framework = getCastFramework();
    if (!framework) return;
    const rp = new framework.RemotePlayer();
    const rpc = new framework.RemotePlayerController(rp);
    remotePlayerRef.current = rp;
    remoteControllerRef.current = rpc;

    const handler = () => {
      const next: CastMirrorState = {
        currentTime: rp.currentTime,
        duration: rp.duration,
        isPaused: rp.isPaused,
        isMediaLoaded: rp.isMediaLoaded,
      };
      setMirror(next);
      if (rp.isMediaLoaded && rp.duration > 0) {
        onRemoteProgressRef.current?.(rp.currentTime, rp.duration);
      }
    };
    mirrorHandlerRef.current = handler;
    rpc.addEventListener(framework.RemotePlayerEventType.ANY_CHANGE, handler);
    handler();
  }, []);

  const detachRemotePlayer = useCallback(() => {
    const rpc = remoteControllerRef.current;
    const h = mirrorHandlerRef.current;
    const framework = getCastFramework();
    if (rpc && h && framework) {
      rpc.removeEventListener(framework.RemotePlayerEventType.ANY_CHANGE, h);
    }
    mirrorHandlerRef.current = null;
    remoteControllerRef.current = null;
    remotePlayerRef.current = null;
    setMirror(emptyMirror);
  }, []);

  useEffect(() => {
    if (!sdkReady) return;
    if (castState !== getCastStates().CONNECTED) {
      detachRemotePlayer();
      return;
    }
    attachRemotePlayer();
    return () => detachRemotePlayer();
  }, [sdkReady, castState, attachRemotePlayer, detachRemotePlayer]);

  const googleCasting = sdkReady && castState === getCastStates().CONNECTED;
  const isCasting = googleCasting || relayCasting;

  // Relay backend: poll the session status while casting.
  useEffect(() => {
    if (!relayCasting) return;
    const id = window.setInterval(() => {
      void (async () => {
        const status = await relayCastStatus();
        if (!status || !status.active) {
          setRelayCasting(false);
          setMirror(emptyMirror);
          setDeviceName(null);
          if (status?.error) setCastMessage(`Cast: ${status.error}`);
          return;
        }
        setDeviceName(status.device_name ?? null);
        relayMutedRef.current = Boolean(status.muted);
        const state = status.player_state ?? "";
        const loaded = state === "PLAYING" || state === "PAUSED" || state === "BUFFERING";
        const currentTime = status.current_time ?? 0;
        const duration = status.duration ?? 0;
        setMirror({
          currentTime,
          duration,
          isPaused: state === "PAUSED",
          isMediaLoaded: loaded,
        });
        if (loaded && duration > 0) onRemoteProgressRef.current?.(currentTime, duration);
      })();
    }, 1000);
    return () => window.clearInterval(id);
  }, [relayCasting]);

  const relayCastCmd = useCallback((params: string) => {
    void fetch(relayApi(`/api/cast/cmd?${params}`), { method: "POST" }).catch(() => undefined);
  }, []);

  const relayCastLoad = useCallback(
    async (device: RelayCastDevice, current: PlaylistItem): Promise<boolean> => {
      const media = buildRelayCastMedia(current, lanOriginRef.current);
      if (!media) {
        setCastMessage("Cast: could not determine a LAN address for live TV casting.");
        return false;
      }
      try {
        const res = await fetch(relayApi("/api/cast/start"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            host: device.host,
            port: device.port,
            name: device.name,
            title: current.title,
            ...media,
          }),
        });
        if (!res.ok) {
          setCastMessage(`Cast: start failed (${res.status}).`);
          return false;
        }
        return true;
      } catch {
        setCastMessage("Cast: could not reach the app backend.");
        return false;
      }
    },
    [],
  );

  const castToDevice = useCallback(
    async (device: RelayCastDevice) => {
      const current = itemRef.current;
      setCastDevices(null);
      if (!current) return;
      setCastMessage(null);
      lastDeviceRef.current = device;
      if (await relayCastLoad(device, current)) {
        setDeviceName(device.name);
        setRelayCasting(true);
      }
    },
    [relayCastLoad],
  );

  const cancelCastPicker = useCallback(() => setCastDevices(null), []);

  // Load the new item on the active session when the user switches content.
  useEffect(() => {
    if (!isCasting) return;
    const current = itemRef.current;
    if (!current) return;

    if (googleCasting) {
      const session = getCastContext()?.getCurrentSession();
      if (!session) return;
      let cancelled = false;
      void (async () => {
        setCastMessage(null);
        const err = await loadMediaOnSession(session, current);
        if (cancelled) return;
        if (err) setCastMessage(`Cast: could not load this stream (${err}).`);
      })();
      return () => {
        cancelled = true;
      };
    }

    const device = lastDeviceRef.current;
    if (device) void relayCastLoad(device, current);
  }, [isCasting, googleCasting, item?.id, relayCastLoad]);

  const requestCastSession = useCallback(async () => {
    const current = itemRef.current;
    if (!current) return;
    setCastMessage(null);

    // Google backend (Chrome / WebView2): the browser shows its own picker.
    if (sdkReady) {
      const ctx = getCastContext();
      if (!ctx) {
        setCastMessage("Cast is not available in this browser yet.");
        return;
      }
      try {
        const err = await ctx.requestSession();
        if (err) {
          setCastMessage("Cast was cancelled or no device was selected.");
          return;
        }
        const session = ctx.getCurrentSession();
        if (!session) {
          setCastMessage("No Cast session.");
          return;
        }
        setDeviceName(session.getCastDevice()?.friendlyName ?? null);
      } catch {
        setCastMessage("Cast failed. Check that a Cast device is on your network.");
      }
      return;
    }

    // Relay backend: discover devices and show our own picker.
    if (!relayCastAvailable || pickerBusy) return;
    setPickerBusy(true);
    setCastMessage("Looking for Cast devices…");
    try {
      const res = await fetch(relayApi("/api/cast/devices"), { cache: "no-store" });
      const devices = res.ok ? ((await res.json()) as RelayCastDevice[]) : [];
      setCastMessage(null);
      if (!devices.length) {
        setCastMessage("No Cast devices found on your network.");
      } else if (devices.length === 1) {
        await castToDevice(devices[0]);
      } else {
        setCastDevices(devices);
      }
    } catch {
      setCastMessage("Cast device discovery failed.");
    } finally {
      setPickerBusy(false);
    }
  }, [sdkReady, relayCastAvailable, pickerBusy, castToDevice]);

  const stopCasting = useCallback(() => {
    if (googleCasting) {
      getCastContext()?.endCurrentSession(true);
    }
    if (relayCasting) {
      relayCastCmd("op=stop");
      setRelayCasting(false);
      setMirror(emptyMirror);
    }
    setCastMessage(null);
    setDeviceName(null);
  }, [googleCasting, relayCasting, relayCastCmd]);

  const castPlayPause = useCallback(() => {
    if (relayCasting) {
      relayCastCmd(mirror.isPaused ? "op=play" : "op=pause");
      return;
    }
    remoteControllerRef.current?.playOrPause();
  }, [relayCasting, relayCastCmd, mirror.isPaused]);

  const castSeekTo = useCallback(
    (seconds: number) => {
      if (relayCasting) {
        const clamped = mirror.duration > 0 ? Math.min(Math.max(0, seconds), mirror.duration) : Math.max(0, seconds);
        relayCastCmd(`op=seek&t=${clamped.toFixed(2)}`);
        return;
      }
      const rp = remotePlayerRef.current;
      const rpc = remoteControllerRef.current;
      if (!rp || !rpc) return;
      const dur = rp.duration;
      const clamped =
        Number.isFinite(dur) && dur > 0 ? Math.min(Math.max(0, seconds), dur) : Math.max(0, seconds);
      rp.currentTime = clamped;
      rpc.seek();
    },
    [relayCasting, relayCastCmd, mirror.duration],
  );

  const castSetVolumeLevel = useCallback(
    (level: number) => {
      if (relayCasting) {
        relayCastCmd(`op=volume&level=${Math.min(1, Math.max(0, level)).toFixed(3)}`);
        return;
      }
      const rp = remotePlayerRef.current;
      const rpc = remoteControllerRef.current;
      if (!rp || !rpc || !rp.canControlVolume) return;
      rp.volumeLevel = Math.min(1, Math.max(0, level));
      rpc.setVolumeLevel();
    },
    [relayCasting, relayCastCmd],
  );

  const castMuteToggle = useCallback(() => {
    if (relayCasting) {
      relayCastCmd(`op=mute&muted=${relayMutedRef.current ? "false" : "true"}`);
      return;
    }
    remoteControllerRef.current?.muteOrUnmute();
  }, [relayCasting, relayCastCmd]);

  const googleCanCast =
    typeof chrome !== "undefined" &&
    sdkReady &&
    (googleCasting || castState !== getCastStates().NO_DEVICES_AVAILABLE);
  const canCast = googleCanCast || relayCastAvailable;

  return {
    sdkReady,
    castState,
    isCasting,
    mirror,
    deviceName,
    castMessage,
    castDevices,
    castToDevice,
    cancelCastPicker,
    requestCastSession,
    stopCasting,
    castPlayPause,
    castSeekTo,
    castSetVolumeLevel,
    castMuteToggle,
    canCast,
    clearCastMessage,
  };
};
