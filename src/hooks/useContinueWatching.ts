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

  const clearContinueWatching = () => {
    setEntries([]);
    setProgress([]);
  };

  const removeContinueWatching = (itemId: string) => {
    setEntries(entries.filter((entry) => entry.itemId !== itemId));
    setProgress(progress.filter((entry) => entry.itemId !== itemId));
  };

  const getResumePosition = (itemId: string): number => progress.find((entry) => entry.itemId === itemId)?.positionSec ?? 0;

  return { updateProgress, clearContinueWatching, removeContinueWatching, getResumePosition };
};
