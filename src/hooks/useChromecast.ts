import { useCallback, useEffect, useRef, useState } from "react";
import type { PlaylistItem } from "../types/models";

const DEFAULT_RECEIVER = "CC1AD845";

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

/**
 * Chromecast Web Sender (CAF): device picker + default media receiver,
 * RemotePlayer for pause/seek/volume from the browser.
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
    if (typeof window === "undefined") return cast.framework.CastState.NOT_CONNECTED;
    try {
      return cast.framework.CastContext.getInstance().getCastState();
    } catch {
      return cast.framework.CastState.NOT_CONNECTED;
    }
  });
  const [mirror, setMirror] = useState<CastMirrorState>(emptyMirror);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [castMessage, setCastMessage] = useState<string | null>(null);
  const clearCastMessage = useCallback(() => setCastMessage(null), []);

  const remotePlayerRef = useRef<cast.framework.RemotePlayer | null>(null);
  const remoteControllerRef = useRef<cast.framework.RemotePlayerController | null>(null);
  const mirrorHandlerRef = useRef<(() => void) | null>(null);

  const refreshCastContext = useCallback(() => {
    if (typeof window === "undefined" || !window.cast?.framework?.CastContext) return;
    try {
      const ctx = cast.framework.CastContext.getInstance();
      setCastState(ctx.getCastState());
      const session = ctx.getCurrentSession();
      setDeviceName(session?.getCastDevice()?.friendlyName ?? null);
    } catch {
      /* framework not ready */
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const tryArm = (): boolean => {
      if (!window.cast?.framework?.CastContext) return false;
      try {
        cast.framework.CastContext.getInstance().getCastState();
        setSdkReady(true);
        refreshCastContext();
      } catch {
        return false;
      }
      return true;
    };

    if (tryArm()) return;

    const prev = window.__onGCastApiAvailable;
    window.__onGCastApiAvailable = (isAvailable: boolean, reason?: string) => {
      prev?.(isAvailable, reason);
      if (isAvailable) {
        try {
          const ctx = cast.framework.CastContext.getInstance();
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

  useEffect(() => {
    if (!sdkReady) return;
    const ctx = cast.framework.CastContext.getInstance();

    const onCastState = () => {
      refreshCastContext();
      const session = ctx.getCurrentSession();
      setDeviceName(session?.getCastDevice()?.friendlyName ?? null);
    };

    ctx.addEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onCastState);
    ctx.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onCastState);
    return () => {
      ctx.removeEventListener(cast.framework.CastContextEventType.CAST_STATE_CHANGED, onCastState);
      ctx.removeEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, onCastState);
    };
  }, [sdkReady, refreshCastContext]);

  const attachRemotePlayer = useCallback(() => {
    if (remotePlayerRef.current && remoteControllerRef.current) return;
    const rp = new cast.framework.RemotePlayer();
    const rpc = new cast.framework.RemotePlayerController(rp);
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
    rpc.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, handler);
    handler();
  }, []);

  const detachRemotePlayer = useCallback(() => {
    const rpc = remoteControllerRef.current;
    const h = mirrorHandlerRef.current;
    if (rpc && h) {
      rpc.removeEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, h);
    }
    mirrorHandlerRef.current = null;
    remoteControllerRef.current = null;
    remotePlayerRef.current = null;
    setMirror(emptyMirror);
  }, []);

  useEffect(() => {
    if (!sdkReady) return;
    if (castState !== cast.framework.CastState.CONNECTED) {
      detachRemotePlayer();
      return;
    }
    attachRemotePlayer();
    return () => detachRemotePlayer();
  }, [sdkReady, castState, attachRemotePlayer, detachRemotePlayer]);

  const isCasting = castState === cast.framework.CastState.CONNECTED;

  useEffect(() => {
    if (!sdkReady || !isCasting) return;
    const current = itemRef.current;
    const session = cast.framework.CastContext.getInstance().getCurrentSession();
    if (!session || !current) return;
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
  }, [sdkReady, isCasting, item?.id]);

  const requestCastSession = useCallback(async () => {
    const current = itemRef.current;
    if (!sdkReady || !current) return;
    setCastMessage(null);
    const ctx = cast.framework.CastContext.getInstance();
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
      setCastMessage("Cast failed. Use Chrome on desktop, or check that a Cast device is on your network.");
    }
  }, [sdkReady]);

  const stopCasting = useCallback(() => {
    if (!sdkReady) return;
    cast.framework.CastContext.getInstance().endCurrentSession(true);
    setCastMessage(null);
    setDeviceName(null);
  }, [sdkReady]);

  const castPlayPause = useCallback(() => {
    remoteControllerRef.current?.playOrPause();
  }, []);

  const castSeekTo = useCallback((seconds: number) => {
    const rp = remotePlayerRef.current;
    const rpc = remoteControllerRef.current;
    if (!rp || !rpc) return;
    const dur = rp.duration;
    const clamped =
      Number.isFinite(dur) && dur > 0 ? Math.min(Math.max(0, seconds), dur) : Math.max(0, seconds);
    rp.currentTime = clamped;
    rpc.seek();
  }, []);

  const castSetVolumeLevel = useCallback((level: number) => {
    const rp = remotePlayerRef.current;
    const rpc = remoteControllerRef.current;
    if (!rp || !rpc || !rp.canControlVolume) return;
    rp.volumeLevel = Math.min(1, Math.max(0, level));
    rpc.setVolumeLevel();
  }, []);

  const castMuteToggle = useCallback(() => {
    remoteControllerRef.current?.muteOrUnmute();
  }, []);

  const canCast =
    typeof chrome !== "undefined" &&
    sdkReady &&
    (isCasting || castState !== cast.framework.CastState.NO_DEVICES_AVAILABLE);

  return {
    sdkReady,
    castState,
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
    clearCastMessage,
  };
};
