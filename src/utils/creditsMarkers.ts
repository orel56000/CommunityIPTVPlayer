/**
 * Credits markers: where a known "credits start at N seconds" comes from, and
 * how this device learns one for a series without any machine learning.
 *
 * Three sources, in the priority order `resolveMarkerCreditsStart` applies:
 *
 * 1. **manual** — a timestamp set for this exact item.
 * 2. **backend / playlist** — `parseMarkersFromItem` reads the EXTINF (or Xtream)
 *    attributes of the item itself, so a provider can ship the answer with the
 *    playlist: `#EXTINF:-1 credits-start="2580" ...`. Any of
 *    `credits-start` / `creditsStart` / `tvg-credits-start` (and the matching
 *    `credits-end`, `intro-start`, `intro-end`) is understood, as seconds or
 *    `HH:MM:SS`.
 * 3. **learned** — the median of what the user actually did on previous
 *    episodes of the same series on this device (see `getLearnedMarkers`).
 *
 * A marker wins over the heuristic outright: it is exact, and re-deriving it
 * from pixels every episode could only make it worse.
 *
 * Everything here is local. Nothing is uploaded, and no audio or video ever
 * leaves the machine — only a handful of timestamps in localStorage.
 */

import type { CreditsFeedbackRecord, VideoMarkers } from "../types/credits";
import type { PlaylistItem } from "../types/models";
import { now } from "./time";

const FEEDBACK_KEY = "iptv:credits-feedback:v1";
const MAX_RECORDS = 400;

/** Minimum agreeing episodes before a series marker is trusted. */
const LEARN_MIN_SAMPLES = 3;
/** Max spread (seconds) around the median for the samples to count as agreeing. */
const LEARN_MAX_SPREAD_SEC = 25;

/* --------------------------------------------------- playlist attributes -- */

const MARKER_KEYS: Record<keyof VideoMarkers, string[]> = {
  introStart: ["intro-start", "introstart", "tvg-intro-start"],
  introEnd: ["intro-end", "introend", "tvg-intro-end"],
  creditsStart: ["credits-start", "creditsstart", "tvg-credits-start", "outro-start"],
  creditsEnd: ["credits-end", "creditsend", "tvg-credits-end", "outro-end"],
};

/** Accepts `2580`, `2580.5`, `43:00` or `01:03:00`. */
export const parseTimestamp = (raw: string): number | null => {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Number.parseFloat(value);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  let seconds = 0;
  for (const part of parts) {
    const chunk = Number.parseFloat(part);
    if (!Number.isFinite(chunk) || chunk < 0) return null;
    seconds = seconds * 60 + chunk;
  }
  return seconds;
};

/** Read chapter markers a provider attached to the playlist entry, if any. */
export const parseMarkersFromItem = (item: PlaylistItem | null): VideoMarkers | null => {
  if (!item) return null;
  const attributes: Record<string, string> = {
    ...(item.rawAttributes ?? {}),
    ...(item.metadata ?? {}),
  };
  const lowerCased = new Map<string, string>();
  Object.entries(attributes).forEach(([key, value]) => {
    if (typeof value === "string") lowerCased.set(key.toLowerCase(), value);
  });

  const markers: VideoMarkers = {};
  let found = false;
  (Object.keys(MARKER_KEYS) as Array<keyof VideoMarkers>).forEach((field) => {
    for (const key of MARKER_KEYS[field]) {
      const raw = lowerCased.get(key);
      if (raw == null) continue;
      const seconds = parseTimestamp(raw);
      if (seconds == null) continue;
      markers[field] = seconds;
      found = true;
      return;
    }
  });

  return found ? markers : null;
};

/* -------------------------------------------------------------- identity -- */

/** Stable per-episode key. */
export const creditsContentId = (item: PlaylistItem | null): string | null =>
  item ? (item.shareId ?? item.id) : null;

/**
 * Series-level key that feedback is aggregated under. Episodes of one show all
 * roll up here; a movie gets its own bucket and will never reach the sample
 * count, which is correct — one movie teaches you nothing about the next.
 */
export const creditsGroupId = (item: PlaylistItem | null): string | null => {
  if (!item) return null;
  if (item.section === "series") {
    const key = item.parentSeriesId ?? item.seriesTitle ?? item.title;
    return `series:${key.toLowerCase()}`;
  }
  return `item:${item.shareId ?? item.id}`;
};

/* -------------------------------------------------------------- feedback -- */

const readRecords = (): CreditsFeedbackRecord[] => {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(FEEDBACK_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CreditsFeedbackRecord[]) : [];
  } catch {
    return [];
  }
};

const writeRecords = (records: CreditsFeedbackRecord[]): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FEEDBACK_KEY, JSON.stringify(records.slice(0, MAX_RECORDS)));
  } catch {
    // Storage full or blocked — learning is a bonus, never a requirement.
  }
};

/**
 * Merge one observation for an episode. Called when credits are detected, when
 * the user skips or dismisses, and when playback reaches the end.
 */
export const recordCreditsFeedback = (
  update: Partial<CreditsFeedbackRecord> & { contentId: string; groupId: string; durationSec: number },
): void => {
  if (!Number.isFinite(update.durationSec) || update.durationSec <= 0) return;
  const records = readRecords();
  const existing = records.find((record) => record.contentId === update.contentId);
  const merged: CreditsFeedbackRecord = {
    ...existing,
    ...update,
    // Each call carries only what it observed, so a later "reached the end"
    // must not erase the earlier "user skipped at 42:10".
    detectedCreditsStart: update.detectedCreditsStart ?? existing?.detectedCreditsStart ?? null,
    userSkippedAt: update.userSkippedAt ?? existing?.userSkippedAt ?? null,
    userDismissed: (update.userDismissed ?? false) || (existing?.userDismissed ?? false),
    reachedVideoEnd: (update.reachedVideoEnd ?? false) || (existing?.reachedVideoEnd ?? false),
    updatedAt: now(),
  };
  writeRecords([merged, ...records.filter((record) => record.contentId !== update.contentId)]);
};

export const clearCreditsFeedback = (): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(FEEDBACK_KEY);
  } catch {
    // no-op
  }
};

/**
 * The timestamp a record actually teaches us, expressed as seconds BEFORE the
 * end — that is what stays constant across episodes of differing length.
 *
 * A user pressing "Next episode" is the strongest evidence there is. A
 * detection the user neither skipped nor dismissed, on an episode that then ran
 * to the end, is weaker but still usable. A dismissal teaches nothing except
 * "not that", so it is excluded rather than counted.
 */
const learnableFromEnd = (record: CreditsFeedbackRecord): number | null => {
  if (record.userDismissed) return null;
  const at = record.userSkippedAt ?? (record.reachedVideoEnd ? record.detectedCreditsStart : null);
  if (at == null || !Number.isFinite(at)) return null;
  const fromEnd = record.durationSec - at;
  if (fromEnd <= 5 || fromEnd > record.durationSec * 0.5) return null;
  return fromEnd;
};

const medianOf = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
};

/**
 * Aggregate this device's history for a series into a credits marker.
 *
 * Deliberately not a model: it is a median plus an agreement check. If the
 * episodes disagree by more than `LEARN_MAX_SPREAD_SEC` around that median, no
 * marker is returned and the heuristic keeps running.
 */
export const getLearnedMarkers = (
  groupId: string | null,
  durationSec: number,
  records: CreditsFeedbackRecord[] = readRecords(),
): VideoMarkers | null => {
  if (!groupId || !Number.isFinite(durationSec) || durationSec <= 0) return null;
  if (!groupId.startsWith("series:")) return null;

  const samples = records
    .filter((record) => record.groupId === groupId)
    .map(learnableFromEnd)
    .filter((value): value is number => value != null);

  if (samples.length < LEARN_MIN_SAMPLES) return null;

  const centre = medianOf(samples);
  const agreeing = samples.filter((value) => Math.abs(value - centre) <= LEARN_MAX_SPREAD_SEC);
  if (agreeing.length < LEARN_MIN_SAMPLES) return null;

  const creditsStart = durationSec - medianOf(agreeing);
  if (creditsStart <= durationSec * 0.5 || creditsStart >= durationSec - 5) return null;
  return { creditsStart };
};
