/**
 * Local helper-app (native relay) discovery.
 *
 * The Community IPTV Player helper runs a local HTTP relay on 127.0.0.1:11471.
 * It fetches the IP-locked provider from the user's home IP, adds CORS, and runs
 * ffmpeg for live TV — the three things the browser / Vercel can't do.
 *
 * `http://127.0.0.1` is a "potentially trustworthy" origin, so even the HTTPS
 * deployed site may call it without mixed-content blocking. On startup we probe
 * `/health`; if the helper answers we point all /api/* calls at it
 * (setRelayBase). Otherwise the app keeps its current web behavior and can
 * prompt the user to install the helper for live TV / blocked streams.
 */

import { getRelayBase, setRelayBase } from "./secureUrl";

export const RELAY_PORT = 11471;
export const RELAY_ORIGIN = `http://127.0.0.1:${RELAY_PORT}`;
const BACKEND_ORIGIN_KEY = "ctv-backend-origin";

export type RelayStatus = "unknown" | "checking" | "available" | "unavailable";

let status: RelayStatus = "unknown";
const listeners = new Set<(s: RelayStatus) => void>();

const setStatus = (next: RelayStatus): void => {
  if (status === next) return;
  status = next;
  for (const fn of listeners) fn(status);
  emitBackendChange();
};

export const getRelayStatus = (): RelayStatus => status;

export const subscribeRelayStatus = (fn: (s: RelayStatus) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const emitBackendChange = (): void => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event("ctv:backend-change"));
};

/** True when this page is already served by the local relay (bundled window). */
export const servedByLocalRelay = (): boolean =>
  typeof window !== "undefined" &&
  /^127\.0\.0\.1$|^localhost$/i.test(window.location.hostname) &&
  window.location.port === String(RELAY_PORT);

export const isNativeRuntime = (): boolean => {
  if (typeof window === "undefined") return false;
  const win = window as typeof window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
    __TAURI_METADATA__?: unknown;
  };
  return Boolean(win.__TAURI__ || win.__TAURI_INTERNALS__ || win.__TAURI_METADATA__);
};

export interface BackendHealth {
  app?: string;
  version?: string;
}

export interface BackendServerInfo {
  app?: string;
  version?: string;
  port?: number;
  origins?: string[];
}

export interface BackendSnapshot {
  status: RelayStatus;
  relayBase: string;
  savedBackendOrigin: string;
  canServe: boolean;
  isNative: boolean;
  servedByRelay: boolean;
}

export const normalizeBackendOrigin = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const parsed = new URL(withScheme);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Use an http:// or https:// server address.");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
};

export const getSavedBackendOrigin = (): string => {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(BACKEND_ORIGIN_KEY) ?? "";
  } catch {
    return "";
  }
};

const saveBackendOrigin = (origin: string): void => {
  if (typeof window === "undefined") return;
  try {
    if (origin) window.localStorage.setItem(BACKEND_ORIGIN_KEY, origin);
    else window.localStorage.removeItem(BACKEND_ORIGIN_KEY);
  } catch {
    /* ignore */
  }
};

export const getBackendSnapshot = (): BackendSnapshot => ({
  status,
  relayBase: getRelayBase(),
  savedBackendOrigin: getSavedBackendOrigin(),
  canServe: isNativeRuntime(),
  isNative: isNativeRuntime(),
  servedByRelay: servedByLocalRelay(),
});

export const probeBackend = async (origin: string, timeoutMs = 1800): Promise<BackendHealth> => {
  const normalized = normalizeBackendOrigin(origin);
  const res = await fetch(`${normalized}/health`, {
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Server returned HTTP ${res.status}.`);
  const body = (await res.json().catch(() => null)) as BackendHealth | null;
  if (body?.app !== "ctv-relay") {
    throw new Error("That address did not answer as a Community IPTV Player backend.");
  }
  return body;
};

export const fetchServerInfo = async (origin = ""): Promise<BackendServerInfo | null> => {
  const base = origin ? normalizeBackendOrigin(origin) : "";
  try {
    const res = await fetch(`${base}/api/server-info`, {
      signal: AbortSignal.timeout(1800),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as BackendServerInfo;
  } catch {
    return null;
  }
};

export const connectBackend = async (rawOrigin: string): Promise<string> => {
  const origin = normalizeBackendOrigin(rawOrigin);
  setStatus("checking");
  try {
    await probeBackend(origin);
    setRelayBase(origin);
    saveBackendOrigin(origin);
    setStatus("available");
    emitBackendChange();
    return origin;
  } catch (error) {
    setRelayBase("");
    setStatus("unavailable");
    emitBackendChange();
    throw error;
  }
};

export const selectThisAppBackend = (): void => {
  setRelayBase("");
  saveBackendOrigin("");
  setStatus("available");
  emitBackendChange();
};

export const disconnectBackend = (): void => {
  setRelayBase("");
  saveBackendOrigin("");
  setStatus("unavailable");
  emitBackendChange();
};

/**
 * Probe the local relay and, if present, route /api/* through it. Safe to call
 * once on startup. Returns true when the relay was found.
 */
export const discoverRelay = async (): Promise<boolean> => {
  setStatus("checking");

  const saved = getSavedBackendOrigin();
  if (saved) {
    try {
      await probeBackend(saved);
      setRelayBase(saved);
      setStatus("available");
      return true;
    } catch {
      setRelayBase("");
      setStatus("unavailable");
      return false;
    }
  }

  // Already same-origin with the relay (mode A): keep relative /api/* calls.
  if (servedByLocalRelay()) {
    setRelayBase("");
    setStatus("available");
    return true;
  }

  try {
    await probeBackend(RELAY_ORIGIN, 1200);
    setRelayBase(RELAY_ORIGIN);
    setStatus("available");
    return true;
  } catch {
    /* no local relay reachable */
  }
  setRelayBase("");
  setStatus("unavailable");
  return false;
};
