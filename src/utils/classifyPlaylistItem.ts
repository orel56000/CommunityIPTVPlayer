import type { PlaylistKind } from "../types/models";

export interface ClassifyInput {
  displayName: string;
  tvgName?: string;
  tvgId?: string;
  groupTitle?: string;
  url: string;
  /** Normalized #EXTINF attributes (lowercase kebab-case keys). */
  rawAttributes?: Record<string, string>;
}

/**
 * Provider-confirmed title patterns.
 * 1) Season/Episode  -> series  (e.g. "... S01E09", "Show S1E10")
 * 2) Year in parens  -> movie   (e.g. "... (2002)")
 */
const EPISODE_PATTERN = /\bS\d{1,2}E\d{1,3}\b/i;
const YEAR_PATTERN = /\((?:19|20)\d{2}\)/;

const nonEmpty = (value?: string): string => (value ?? "").trim();

/** Extract season/episode numbers + series title from a combined string. */
const extractEpisodeMeta = (
  combined: string,
): { seriesTitle?: string; season: number; episode: number } | null => {
  const match = combined.match(/(.+?)\s*[Ss](\d{1,2})[Ee](\d{1,3})\b/);
  if (!match) return null;
  const season = Number(match[2]);
  const episode = Number(match[3]);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
  const seriesTitle = match[1]?.trim().replace(/[-–—|]+$/u, "").trim();
  return {
    seriesTitle: seriesTitle && seriesTitle.length > 0 ? seriesTitle : undefined,
    season,
    episode,
  };
};

/**
 * Metadata/title-first classifier matching the provider rules:
 *   1. tvg-name OR displayName matches /\bS\d{1,2}E\d{1,3}\b/i  -> series
 *   2. tvg-name OR displayName matches /\((19|20)\d{2}\)/       -> movie
 *   3. tvg-id exists and is non-empty                           -> live
 *   4. otherwise                                                -> unknown
 *
 * URL is NOT used as a primary signal. `#.mp4` and similar are treated as
 * weak VOD hints only (tie-breaker when the title has no year and no SxxEyy).
 */
export const classifyPlaylistItem = (
  input: ClassifyInput,
): {
  kind: PlaylistKind;
  section: "live" | "movies" | "series";
  seriesTitle?: string;
  season?: number;
  episode?: number;
} => {
  const displayName = nonEmpty(input.displayName);
  const tvgName = nonEmpty(input.tvgName);
  const tvgId = nonEmpty(input.tvgId);

  // Rule 1: SxxEyy in either tvg-name or displayName => series
  const episodeMatchSource = EPISODE_PATTERN.test(tvgName)
    ? tvgName
    : EPISODE_PATTERN.test(displayName)
      ? displayName
      : null;
  if (episodeMatchSource) {
    const meta = extractEpisodeMeta(episodeMatchSource) ?? { season: 1, episode: 1 };
    return {
      kind: "series_episode",
      section: "series",
      seriesTitle: meta.seriesTitle ?? tvgName ?? displayName,
      season: meta.season,
      episode: meta.episode,
    };
  }

  // Rule 2: (YYYY) in either tvg-name or displayName => movie
  if (YEAR_PATTERN.test(tvgName) || YEAR_PATTERN.test(displayName)) {
    return { kind: "movie", section: "movies" };
  }

  // Rule 3: tvg-id present => live
  if (tvgId.length > 0) {
    return { kind: "live", section: "live" };
  }

  // Rule 4: unknown. Weak VOD hint from URL only as a tiebreaker.
  const loweredUrl = input.url.toLowerCase();
  const weakVodHint = loweredUrl.includes("#.mp4");
  if (weakVodHint) {
    return { kind: "movie", section: "movies" };
  }

  return { kind: "unknown", section: "live" };
};
