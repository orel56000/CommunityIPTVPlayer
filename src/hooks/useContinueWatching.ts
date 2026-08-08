import type { ContinueWatchingEntry, PlaybackProgress } from "../types/models";
import { now } from "../utils/time";

const WATCH_COMPLETE_RATIO = 0.93;

export const useContinueWatching = (
  entries: ContinueWatchingEntry[],
  setEntries: (next: ContinueWatchingEntry[]) => void,
  progress: PlaybackProgress[],
  setProgress: (next: PlaybackProgress[]) => void,
) => {
  const updateProgress = (playlistId: string, itemId: string, positionSec: number, durationSec: number) => {
    if (!Number.isFinite(positionSec) || !Number.isFinite(durationSec) || durationSec <= 0) return;
    const completed = positionSec / durationSec >= WATCH_COMPLETE_RATIO;

    const nextProgress = [
      {
        playlistId,
        itemId,
        positionSec,
        durationSec,
        completed,
        updatedAt: now(),
      },
      ...progress.filter((p) => p.itemId !== itemId),
    ];
    setProgress(nextProgress.slice(0, 300));

    if (completed) {
      setEntries(entries.filter((entry) => entry.itemId !== itemId));
      return;
    }

    const nextEntries = [{ playlistId, itemId, updatedAt: now() }, ...entries.filter((entry) => entry.itemId !== itemId)];
    setEntries(nextEntries.slice(0, 100));
  };

  /**
   * Mark a batch of items watched or unwatched in ONE state update.
   *
   * Deliberately not `targets.forEach(updateProgress)`: every helper here reads
   * the `progress`/`entries` props captured at render, so a loop would compute
   * each update from the same stale array and only the last one would survive.
   * Marking a whole season/series is the main caller, so that would silently
   * drop all but one episode.
   */
  const setWatched = (targets: ReadonlyArray<{ playlistId: string; itemId: string }>, watched: boolean) => {
    if (targets.length === 0) return;
    const ids = new Set(targets.map((t) => t.itemId));

    // Unwatched = no history at all, so it also leaves Continue watching.
    if (!watched) {
      setProgress(progress.filter((entry) => !ids.has(entry.itemId)));
      setEntries(entries.filter((entry) => !ids.has(entry.itemId)));
      return;
    }

    const at = now();
    const existing = new Map(progress.map((entry) => [entry.itemId, entry]));
    const marked: PlaybackProgress[] = targets.map((target) => ({
      playlistId: target.playlistId,
      itemId: target.itemId,
      // positionSec 0, not durationSec: "I've seen this" should not also mean
      // "resume 2 seconds before the credits" the next time it is played.
      positionSec: 0,
      durationSec: existing.get(target.itemId)?.durationSec ?? 0,
      completed: true,
      updatedAt: at,
    }));

    // Newly marked first so the 300-entry cap evicts older history, not the
    // episodes the user just acted on.
    setProgress([...marked, ...progress.filter((entry) => !ids.has(entry.itemId))].slice(0, 300));
    setEntries(entries.filter((entry) => !ids.has(entry.itemId)));
  };

  const clearContinueWatching = () => {
    setEntries([]);
    setProgress([]);
  };

  const removeContinueWatching = (itemId: string) => {
    setEntries(entries.filter((entry) => entry.itemId !== itemId));
    setProgress(progress.filter((entry) => entry.itemId !== itemId));
  };

  const getResumePosition = (itemId: string): number => progress.find((entry) => entry.itemId === itemId)?.positionSec ?? 0;

  return { updateProgress, setWatched, clearContinueWatching, removeContinueWatching, getResumePosition };
};
