import { useEffect, useMemo, useRef } from "react";
import { Check, X } from "lucide-react";
import clsx from "clsx";
import { focusedCueIndex, formatOffset, type SubtitleCue } from "../../utils/subtitles";
import { formatDuration } from "../../utils/time";

interface SubtitleSyncPanelProps {
  /** Cues at their ORIGINAL timings — the offset is applied for display only. */
  cues: SubtitleCue[];
  offsetSec: number;
  /** Playback position, coarsened by the player — display and focus only. */
  currentTime: number;
  /** Receives the picked cue's ORIGINAL start; the player derives the delay. */
  onPick: (cueStartSec: number) => void;
  onClose: () => void;
}

/**
 * Align subtitles by ear instead of by arithmetic.
 *
 * Nudging "+0.5s" repeatedly means guessing, playing, and re-guessing. Here the
 * user listens, finds the line they just heard, and clicks it: the delay that
 * puts that line at this exact moment is derived from the click, so one match is
 * usually the whole job. The player computes it against the LIVE position rather
 * than the prop below, which is deliberately coarse.
 *
 * The list follows playback, highlighting the line that SHOULD be showing under
 * the current delay — which doubles as the "how wrong is it right now" readout.
 */
export const SubtitleSyncPanel = ({ cues, offsetSec, currentTime, onPick, onClose }: SubtitleSyncPanelProps) => {
  const listRef = useRef<HTMLDivElement | null>(null);
  const focusedRef = useRef<HTMLButtonElement | null>(null);

  const focused = useMemo(
    () => focusedCueIndex(cues, offsetSec, currentTime),
    [cues, offsetSec, currentTime],
  );

  // Follow playback, but only ever scroll the list itself — scrollIntoView
  // would drag the whole page (and the player) around it.
  //
  // offsetTop is measured against the nearest POSITIONED ancestor, so the list
  // carries `relative` (see below). Without it the panel root is the reference
  // and every scroll overshoots by the height of the header above the list —
  // enough to push the focused line off the top of a phone-sized player.
  useEffect(() => {
    const scroller = listRef.current;
    const target = focusedRef.current;
    if (!scroller || !target) return;
    // Plain scrollTop, and deliberately no smooth scrolling: a WebView that does
    // not implement it (verified: Chromium ignores both scrollTo({behavior}) and
    // CSS scroll-behavior here) leaves the list where it was, so the focused line
    // is never brought into view and follow-playback silently does nothing.
    scroller.scrollTop = Math.max(0, target.offsetTop - scroller.clientHeight / 2 + target.clientHeight / 2);
  }, [focused]);

  return (
    <div
      className="absolute inset-y-4 right-4 z-40 flex w-[min(22rem,calc(100%-2rem))] flex-col rounded-xl border border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur"
      // The player toggles play on click and seeks on double-click; neither
      // should fire while the user is working inside this panel.
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start gap-2 border-b border-white/10 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-100">Match a line</p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
            Play until you hear a line, then click it. The delay is set from your pick.
          </p>
        </div>
        <button type="button" className="control-btn shrink-0" onClick={onClose} aria-label="Close subtitle sync">
          <X size={16} />
        </button>
      </div>

      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5 text-[11px]">
        <span className="tabular-nums text-slate-400">At {formatDuration(currentTime)}</span>
        <span className="tabular-nums text-cyan-300">Delay {formatOffset(offsetSec)}</span>
      </div>

      {cues.length === 0 ? (
        <p className="p-4 text-xs text-slate-400">
          No lines to match yet. Pick a subtitle track first, or wait for it to load.
        </p>
      ) : (
        <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto p-1.5">
          {cues.map((cue, index) => {
            const isFocused = index === focused;
            return (
              <button
                key={`${cue.start}-${index}`}
                ref={isFocused ? focusedRef : undefined}
                type="button"
                onClick={() => onPick(cue.start)}
                title={`Set the delay so this line lands at ${formatDuration(currentTime)}`}
                className={clsx(
                  "group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition",
                  isFocused
                    ? "bg-cyan-500/20 text-cyan-50 ring-1 ring-cyan-400/40"
                    : "text-slate-300 hover:bg-white/[0.06]",
                )}
              >
                {/* The shifted time — where this line currently lands. */}
                <span className="shrink-0 pt-0.5 text-[10px] tabular-nums text-slate-500">
                  {formatDuration(Math.max(0, cue.start + offsetSec))}
                </span>
                <span className="min-w-0 flex-1 whitespace-pre-line text-[11px] leading-snug">{cue.text}</span>
                <Check
                  size={13}
                  className="mt-0.5 shrink-0 text-cyan-300 opacity-0 transition group-hover:opacity-100"
                  aria-hidden
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
