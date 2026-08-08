/**
 * Aggregate "watched" state for a group of episodes (a season, or a whole
 * series), derived from the same `PlaybackProgress.completed` flag the episode
 * rows use — so a season badge can never disagree with the episodes under it.
 *
 * Pure and dependency-free on purpose: the season/series badges and the
 * mark-all buttons all read from this one definition. See watchedState.test.ts.
 */

import type { PlaybackProgress } from "../types/models";

export type WatchedState = "none" | "partial" | "all";

/** An empty group is "none" — there is nothing watched in it. */
export const watchedStateFor = (
  episodes: ReadonlyArray<{ id: string }>,
  progressByItemId: ReadonlyMap<string, PlaybackProgress>,
): WatchedState => {
  if (episodes.length === 0) return "none";
  let watched = 0;
  for (const episode of episodes) {
    if (progressByItemId.get(episode.id)?.completed) watched += 1;
  }
  if (watched === 0) return "none";
  return watched === episodes.length ? "all" : "partial";
};

/**
 * What a "mark all" control should do next for a group: fully-watched groups
 * toggle off, everything else (none OR partial) fills in. Partial -> watched
 * matches the intent of a single click on a half-finished season.
 */
export const nextWatchedTarget = (state: WatchedState): boolean => state !== "all";
