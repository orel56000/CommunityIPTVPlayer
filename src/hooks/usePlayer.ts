import { useMemo, useState } from "react";
import type { PlaylistItem } from "../types/models";
import type { PlayerState } from "../types/player";

export const usePlayer = (defaultVolume: number) => {
  const [state, setState] = useState<PlayerState>({
    currentItem: null,
    loading: false,
    error: null,
    muted: false,
    volume: defaultVolume,
    isPlaying: false,
    canPip: false,
  });

  const actions = useMemo(
    () => ({
      setCurrentItem: (item: PlaylistItem | null) => setState((prev) => ({ ...prev, currentItem: item, error: null, loading: !!item })),
      setLoading: (loading: boolean) => setState((prev) => ({ ...prev, loading })),
      setError: (error: string | null) => setState((prev) => ({ ...prev, error, loading: false })),
      setMuted: (muted: boolean) => setState((prev) => ({ ...prev, muted })),
      setVolume: (volume: number) => setState((prev) => ({ ...prev, volume })),
      setPlaying: (isPlaying: boolean) => setState((prev) => ({ ...prev, isPlaying })),
      setCanPip: (canPip: boolean) => setState((prev) => ({ ...prev, canPip })),
    }),
    [],
  );

  return { playerState: state, ...actions };
};
