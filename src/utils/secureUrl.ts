/**
 * URL helpers for IPTV playback.
 *
 * Streams are played through the same-origin relay (api/stream.ts) via
 * `toRelayUrl`, so the browser is not subject to the provider's CORS / redirect
 * / browser-gating. `upgradeToHttps` / `isHttpUrl` remain available for callers
 * that still reason about scheme.
 */

const isAbsoluteHttp = (value: string): boolean => /^https?:\/\//i.test(value);

/** Build the HTTPS variant of an http URL (port 80 -> 443). https/other URLs pass through. */
export const upgradeToHttps = (url: string): string => {
  const trimmed = (url ?? "").trim();
  if (!trimmed || !isAbsoluteHttp(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:") {
      parsed.protocol = "https:";
      if (parsed.port === "80") parsed.port = "443";
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
};

/** True when the URL is HTTP. */
export const isHttpUrl = (url: string): boolean => /^http:\/\//i.test((url ?? "").trim());

const RELAY_PATH = "/api/stream";

/**
 * Route a remote stream URL through the same-origin relay (api/stream.ts), so
 * the browser fetches same-origin bytes instead of hitting the provider's CORS
 * / redirect / browser-gating directly. Pass-through for already-relayed or
 * same-origin (root-relative) paths.
 */
export const toRelayUrl = (url: string): string => {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith(RELAY_PATH + "?") || trimmed.startsWith("/")) return trimmed;
  if (!isAbsoluteHttp(trimmed)) return trimmed;
  return RELAY_PATH + "?url=" + encodeURIComponent(trimmed);
};

/**
 * Normalize an optional asset URL (logos, covers) without changing its scheme -
 * drops empties, passes through data:/blob:. Browsers auto-upgrade mixed-content
 * images themselves, so we leave the provider's scheme untouched.
 */
export const cleanAssetUrl = (url?: string | null): string | undefined => {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  return trimmed;
};
