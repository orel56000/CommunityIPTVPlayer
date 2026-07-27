import { SkipForward, X } from "lucide-react";
import clsx from "clsx";

export interface CreditsOverlayProps {
  visible: boolean;
  /** e.g. "S1E4 · The One With The Thing". */
  nextEpisodeLabel: string | null;
  /** Seconds left on the auto-advance countdown, or null when it is not running. */
  countdownSeconds: number | null;
  countdownTotalSeconds: number;
  onPlayNext: () => void;
  onDismiss: () => void;
  onCancelCountdown: () => void;
}

/**
 * The credits suggestion: "looks like the episode is over, want the next one?".
 *
 * It only ever suggests. Nothing here advances playback on its own unless the
 * user has switched the countdown on, and even then the countdown is cancellable
 * right up to zero — a post-credit scene should never be skipped out from under
 * someone.
 */
export const CreditsOverlay = ({
  visible,
  nextEpisodeLabel,
  countdownSeconds,
  countdownTotalSeconds,
  onPlayNext,
  onDismiss,
  onCancelCountdown,
}: CreditsOverlayProps) => {
  if (!visible) return null;

  const counting = countdownSeconds != null;
  const progress =
    counting && countdownTotalSeconds > 0
      ? Math.min(100, Math.max(0, ((countdownTotalSeconds - countdownSeconds) / countdownTotalSeconds) * 100))
      : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        "credits-card pointer-events-auto absolute bottom-24 right-3 z-20 w-[min(19rem,calc(100%-1.5rem))]",
        "overflow-hidden rounded-xl border border-white/10 bg-slate-950/90 shadow-2xl shadow-black/60 backdrop-blur",
      )}
    >
      <div className="flex items-start gap-2 px-3 pb-2 pt-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-400/90">
            {counting ? `Up next in ${countdownSeconds}s` : "Credits · up next"}
          </p>
          <p className="mt-0.5 truncate text-sm font-medium text-slate-100" title={nextEpisodeLabel ?? undefined}>
            {nextEpisodeLabel ?? "Next episode"}
          </p>
        </div>
        <button
          type="button"
          className="-mr-1 -mt-0.5 shrink-0 rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-slate-100"
          aria-label="Dismiss next episode suggestion"
          title="Dismiss"
          onClick={onDismiss}
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex items-center gap-2 px-3 pb-3">
        <button
          type="button"
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-cyan-400"
          onClick={onPlayNext}
        >
          <SkipForward size={15} />
          Play next
        </button>
        {counting ? (
          <button
            type="button"
            className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 hover:text-slate-100"
            onClick={onCancelCountdown}
          >
            Cancel
          </button>
        ) : null}
      </div>

      {counting ? (
        <div className="h-0.5 w-full bg-white/10">
          <div className="h-full bg-cyan-400 transition-[width] duration-1000 ease-linear" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
    </div>
  );
};
