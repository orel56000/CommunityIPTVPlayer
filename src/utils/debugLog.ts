/**
 * Debug mode: logs every `fetch()` the frontend makes (method, url, status,
 * duration) to the relay's `/api/debug/log`, and opens a second native window
 * that polls it live — alongside whatever the relay itself logs about its own
 * upstream provider fetches (see relay.rs's `push_debug_log`).
 *
 * Native-only: there's no window to pop in a plain browser tab, so callers
 * should gate the UI on `isNativeRuntime()` (relayDiscovery.ts) themselves.
 */

import { redactUrl } from "./redactUrl";
import { getRelayBase } from "./secureUrl";

let debugModeEnabled = false;
let fetchWrapped = false;

export const setDebugModeEnabled = (enabled: boolean): void => {
  debugModeEnabled = enabled;
  installFetchLogging();
};

/** Opens (or focuses) the debug log window via the Rust `open_debug_window` command. */
export const openDebugLogWindow = async (): Promise<void> => {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_debug_window");
  } catch {
    // Best-effort — the log window is a debugging aid, never block on it.
  }
};

const debugLogEndpoint = (): string => `${getRelayBase()}/api/debug/log`;

const reportFetch = (
  method: string,
  url: string,
  status: number | null,
  durationMs: number,
  error: string | null,
): void => {
  const originalFetch = window.fetch;
  void originalFetch(debugLogEndpoint(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, url, status, durationMs: Math.round(durationMs), error }),
  }).catch(() => undefined);
};

const requestUrl = (input: RequestInfo | URL): string => {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

/** Installed once, unconditionally — cheap no-op per call while debug mode is off. */
const installFetchLogging = (): void => {
  if (fetchWrapped || typeof window === "undefined" || !window.fetch) return;
  fetchWrapped = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (!debugModeEnabled || url.includes("/api/debug/log")) {
      return originalFetch(input, init);
    }
    // Log the redacted form only — the raw `url` above is used solely for the
    // self-check guard, and must never reach the log buffer.
    const logged = redactUrl(url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const started = performance.now();
    return originalFetch(input, init).then(
      (response) => {
        reportFetch(method, logged, response.status, performance.now() - started, null);
        return response;
      },
      (error: unknown) => {
        reportFetch(method, logged, null, performance.now() - started, error instanceof Error ? error.message : String(error));
        throw error;
      },
    );
  };
};

installFetchLogging();
