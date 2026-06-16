/**
 * Per-category HTTPS capability for direct (no-proxy) playback.
 *
 * The host scheme the user entered is respected:
 *   - HTTPS host  -> always played over HTTPS.
 *   - HTTP host   -> the first time each category (live / movies / series) is
 *                    watched, the player tries HTTPS first and falls back to
 *                    HTTP. Whichever actually plays is cached in localStorage
 *                    per provider host + category, so later plays skip the test.
 *
 * This module only decides the plan and stores results. The real "test" is the
 * player attempting playback (see VideoPlayer), which records the outcome via
 * writeHttpsCapability.
 */

import { isHttpUrl, upgradeToHttps } from "./secureUrl";

export type StreamCategory = "live" | "movies" | "series";
type Capability = "yes" | "no";

// v2: the v1 cache could store a wrong "no" from an earlier probe-based test.
// Bumping the key discards those stale entries so HTTPS is re-tested.
const STORAGE_KEY = "iptv:https-capability:v2";

/** Map a PlaylistItem.section to one of the three tested categories. */
export const categoryForSection = (section: string): StreamCategory => {
  if (section === "movies") return "movies";
  if (section === "series") return "series";
  return "live"; // live + catchup share the live category
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

const entryKey = (host: string, category: StreamCategory): string => `${host}::${category}`;

const loadAll = (): Record<string, Capability> => {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, Capability>) : {};
  } catch {
    return {};
  }
};

const saveAll = (data: Record<string, Capability>): void => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* ignore quota / private-mode errors */
  }
};

export const readHttpsCapability = (streamUrl: string, category: StreamCategory): Capability | null => {
  const host = hostOf(streamUrl);
  if (!host) return null;
  return loadAll()[entryKey(host, category)] ?? null;
};

export const writeHttpsCapability = (
  streamUrl: string,
  category: StreamCategory,
  value: Capability,
): void => {
  const host = hostOf(streamUrl);
  if (!host) return;
  const data = loadAll();
  if (data[entryKey(host, category)] === value) return;
  data[entryKey(host, category)] = value;
  saveAll(data);
};

export interface PlaybackPlan {
  /** URL to try first. */
  primaryUrl: string;
  /** HTTP fallback to try if the primary (HTTPS) attempt fails - only while testing. */
  fallbackUrl: string | null;
  /** True when this is a first watch of an HTTP category and the result will be cached. */
  testingHttps: boolean;
  /** The category this plan applies to. */
  category: StreamCategory;
}

/**
 * Decide how to play a stream, honoring the user's original scheme:
 *   - already HTTPS        -> play HTTPS, no test
 *   - HTTP + cached "yes"  -> play HTTPS, no test
 *   - HTTP + cached "no"   -> play HTTP, no test
 *   - HTTP + unknown       -> try HTTPS, fall back to HTTP; the player caches the winner
 */
export const planCategoryPlayback = (streamUrl: string, section: string): PlaybackPlan => {
  const category = categoryForSection(section);
  if (!isHttpUrl(streamUrl)) {
    return { primaryUrl: streamUrl, fallbackUrl: null, testingHttps: false, category };
  }

  const cached = readHttpsCapability(streamUrl, category);
  if (cached === "yes") {
    return { primaryUrl: upgradeToHttps(streamUrl), fallbackUrl: null, testingHttps: false, category };
  }
  if (cached === "no") {
    return { primaryUrl: streamUrl, fallbackUrl: null, testingHttps: false, category };
  }

  // First watch of this category over HTTP: try HTTPS, keep HTTP as a fallback.
  return { primaryUrl: upgradeToHttps(streamUrl), fallbackUrl: streamUrl, testingHttps: true, category };
};
