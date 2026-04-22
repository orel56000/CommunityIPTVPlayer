import type { RecentEntry } from "../types/models";
import { now } from "../utils/time";

const MAX_RECENTS = 80;

export const useRecents = (recents: RecentEntry[], setRecents: (next: RecentEntry[]) => void) => {
  const pushRecent = (playlistId: string, itemId: string) => {
    const next = [{ playlistId, itemId, viewedAt: now() }, ...recents.filter((entry) => entry.itemId !== itemId)];
    setRecents(next.slice(0, MAX_RECENTS));
  };

  const clearRecents = () => setRecents([]);

  return { pushRecent, clearRecents };
};
