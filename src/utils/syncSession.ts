/**
 * Master/follower playback sync over the local relay.
 *
 * The device that owns the relay (the native app — its WebView is always a
 * loopback peer of its own server) is the MASTER. Any other device that opened
 * the app over the LAN (`http://<master-ip>:11471/`, e.g. a TV browser) can
 * choose "sync" mode and become a FOLLOWER: it plays whatever the master plays,
 * advances episodes on its own, and reports its playback back so the master's
 * watched/continue-watching state stays the single source of truth.
 *
 * Transport is plain polled JSON on the relay (`/api/sync*`) — the same
 * pattern as the cast status channel, so it works identically for the master's
 * WebView (same-origin loopback) and remote browsers, and survives the relay's
 * takeover-restart cycle by simply resuming on the next poll. The relay treats
 * command/report bodies as opaque JSON; this module owns the schema.
 */

import type { PlaylistItem } from "../types/models";
import { getRelayBase } from "./secureUrl";
import { RELAY_PORT, getSavedBackendOrigin, isNativeRuntime } from "./relayDiscovery";

export type RemoteMode = "sync" | "regular";

const REMOTE_MODE_KEY = "ctv-remote-mode";
const FOLLOWER_ID_KEY = "ctv-sync-follower-id";

/**
 * True when this page is the app served by a relay over a LAN address — i.e.
 * another device (TV, laptop) opened the master's `http://<ip>:11471/`. The
 * bundled native window loads the same app from 127.0.0.1 and must NOT count.
 * `?remote=1` forces it for development against `npm run dev`.
 */
export const isRemoteLanClient = (): boolean => {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("remote") === "1") return true;
  if (isNativeRuntime()) return false;
  if (window.location.port !== String(RELAY_PORT)) return false;
  return !/^127\.0\.0\.1$|^localhost$/i.test(window.location.hostname);
};

/**
 * Only the relay's OWNER may act as sync master: the native app driving its
 * own loopback server — the only caller `/api/sync/command` accepts anyway.
 * Without this, any browser merely CONNECTED to someone's relay (saved backend
 * origin, or a second tab on 127.0.0.1:11471) would self-elect master: its
 * commands 403 silently while its poll loop folds other people's follower
 * reports into this device's watched state.
 */
/**
 * This app is the sync master when it is the native runtime serving its own
 * relay. The origin is passed in rather than read from storage so that React
 * callers depend on it explicitly — reading it here made a memo go stale when
 * the user switched back to this app's own backend.
 */
export const ownsSyncRelay = (savedBackendOrigin = getSavedBackendOrigin()): boolean =>
  isNativeRuntime() && !savedBackendOrigin;

/** The mode a remote device chose on its landing page (per browser session). */
export const getRemoteMode = (): RemoteMode | null => {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(REMOTE_MODE_KEY);
    return raw === "sync" || raw === "regular" ? raw : null;
  } catch {
    return null;
  }
};

export const saveRemoteMode = (mode: RemoteMode): void => {
  try {
    window.sessionStorage.setItem(REMOTE_MODE_KEY, mode);
  } catch {
    /* session-only nicety — losing it just re-shows the chooser */
  }
};

/**
 * A master "now playing" command. Carries the full item snapshot so a follower
 * can start playback without resolving anything — resolution by id/shareId is
 * only needed for the reverse (report) direction. `positionSec`/`durationSec`
 * are the master's resume point for the item (0/0 when never watched).
 */
export interface SyncCommand {
  /** Assigned by the relay: monotonic sequence + unix-ms timestamp. */
  seq?: number;
  at?: number;
  item: PlaylistItem;
  playlistName: string;
  shareId: string;
  positionSec: number;
  durationSec: number;
}

/** What a follower periodically reports back about its own playback. */
export interface SyncFollowerReport {
  id: string;
  name: string;
  /** Assigned by the relay (unix ms). */
  at?: number;
  itemId: string | null;
  playlistId: string | null;
  playlistName: string | null;
  shareId: string | null;
  title: string | null;
  positionSec: number;
  durationSec: number;
  playing: boolean;
}

export interface SyncStateResponse {
  seq: number;
  command: SyncCommand | null;
  followers: SyncFollowerReport[];
}

const syncUrl = (path: string): string => `${getRelayBase()}${path}`;

export const fetchSyncState = async (): Promise<SyncStateResponse | null> => {
  try {
    const res = await fetch(syncUrl("/api/sync"), {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as SyncStateResponse;
  } catch {
    return null;
  }
};

export const postSyncCommand = async (command: SyncCommand): Promise<boolean> => {
  try {
    const res = await fetch(syncUrl("/api/sync/command"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export const postSyncReport = async (
  report: SyncFollowerReport,
): Promise<{ seq: number; command: SyncCommand | null } | null> => {
  try {
    const res = await fetch(syncUrl("/api/sync/report"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as { seq: number; command: SyncCommand | null };
  } catch {
    return null;
  }
};

/** Stable per-browser-session follower identity. */
export const getFollowerId = (): string => {
  try {
    const existing = window.sessionStorage.getItem(FOLLOWER_ID_KEY);
    if (existing) return existing;
    const id = Math.random().toString(36).slice(2, 10);
    window.sessionStorage.setItem(FOLLOWER_ID_KEY, id);
    return id;
  } catch {
    return "follower";
  }
};

/** Human-readable device label for the master's follower list. */
export const followerDeviceName = (): string => {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/tizen/i.test(ua)) return "Samsung TV";
  if (/web0s|webos/i.test(ua)) return "LG TV";
  if (/bravia/i.test(ua)) return "Sony TV";
  if (/googletv|crkey|android tv/i.test(ua)) return "Google TV";
  if (/aft\w{0,3}[ )/;]/i.test(ua) || /fire tv/i.test(ua)) return "Fire TV";
  if (/smart-?tv|hbbtv|netcast|viera|roku/i.test(ua)) return "Smart TV";
  if (/android/i.test(ua)) return "Android device";
  if (/iphone|ipad/i.test(ua)) return "iOS device";
  return "Browser";
};
