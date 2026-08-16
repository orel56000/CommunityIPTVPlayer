import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Cast,
  Download,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Captions,
  Plus,
  Settings,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
  ZoomIn,
} from "lucide-react";
import clsx from "clsx";
import type { VideoFitMode } from "../../types/player";
import { formatOffset } from "../../utils/subtitles";
import type { SubtitleOption } from "../../hooks/useSubtitles";
import { formatDuration } from "../../utils/time";
import { CastDevicePicker } from "./CastDevicePicker";
import type { RelayCastDevice } from "../../hooks/useChromecast";

export interface PlayerOverlayProps {
  title: string;
  loading: boolean;
  error: string | null;
  isPlaying: boolean;
  isLive: boolean;
  isFullscreen: boolean;
  canPip: boolean;
  canCast: boolean;
  /** Devices found by the relay's native Cast discovery (null = picker closed). */
  castDevices?: RelayCastDevice[] | null;
  /** Device picked from that list, held until the user confirms it. */
  pendingCastDevice?: RelayCastDevice | null;
  onPickCastDevice?: (device: RelayCastDevice) => void;
  onConfirmCastDevice?: () => void;
  onDismissCastConfirm?: () => void;
  onCancelCastPicker?: () => void;
  /** Receiver is connected and media is routed to Cast. */
  castActive?: boolean;
  /** Friendly name from Cast device (e.g. Living Room TV). */
  castDeviceLabel?: string | null;
  /** Cast-specific messages (errors, cancelled picker). */
  castHint?: string | null;
  muted: boolean;
  volume: number;
  volumePercentMode: boolean;
  currentTime: number;
  duration: number;
  buffered: number;
  playbackRate: number;
  controlsVisible: boolean;
  onTogglePlay: () => void;
  onSeekTo: (seconds: number) => void;
  onSkip: (deltaSec: number) => void;
  onToggleMute: () => void;
  onVolume: (value: number) => void;
  onTogglePip: () => void;
  onToggleFullscreen: () => void;
  onCast: () => void;
  onChangePlaybackRate: (rate: number) => void;
  /** Current video zoom factor (1 = 100%, no zoom). */
  videoScale: number;
  onVideoScale: (scale: number) => void;
  /** How the video maps onto its box (contain/cover/fill/none). */
  videoFitMode?: VideoFitMode;
  onVideoFitModeChange?: (mode: VideoFitMode) => void;
  /** Subtitle tracks (embedded + added files), "Off" first. */
  subtitleOptions?: SubtitleOption[];
  subtitleSelectedId?: string;
  onSelectSubtitle?: (id: string) => void;
  /** Seconds the subtitles are shifted by; positive shows them later. */
  subtitleOffsetSec?: number;
  onNudgeSubtitleOffset?: (deltaSec: number) => void;
  onResetSubtitleOffset?: () => void;
  /** Opens the file picker for adding an external subtitle file. */
  onAddSubtitleFile?: () => void;
  /** Opens the match-a-line sync panel (only useful with a track selected). */
  onOpenSubtitleSync?: () => void;
  subtitleHint?: string | null;
  /** A next episode is queued (series only) — shows the in-player skip button. */
  canPlayNext?: boolean;
  nextEpisodeLabel?: string | null;
  onPlayNext?: () => void;
  canDownload: boolean;
  downloadBusy: boolean;
  downloadHint: string | null;
  isHlsStream: boolean;
  onDownload: () => void;
  errorActionLabel?: string;
  onErrorAction?: () => void;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ZOOM_MIN = 1;
const ZOOM_MAX = 5;
const ZOOM_PRESETS = [1, 1.5, 2, 3, 4];
const FIT_MODES: { value: VideoFitMode; label: string; title: string }[] = [
  { value: "none", label: "Original", title: "Original — native size, no scaling" },
  { value: "contain", label: "Fit", title: "Fit — show the whole picture, may letterbox" },
  { value: "cover", label: "Fill", title: "Fill — crop to fill the screen, no black bars" },
  { value: "fill", label: "Stretch", title: "Stretch — fill exactly, may distort the picture" },
];

export const PlayerOverlay = ({
  title,
  loading,
  error,
  isPlaying,
  isLive,
  isFullscreen,
  canPip,
  canCast,
  castDevices = null,
  pendingCastDevice = null,
  onPickCastDevice,
  onConfirmCastDevice,
  onDismissCastConfirm,
  onCancelCastPicker,
  castActive = false,
  castDeviceLabel = null,
  castHint = null,
  muted,
  volume,
  volumePercentMode,
  currentTime,
  duration,
  buffered,
  playbackRate,
  controlsVisible,
  onTogglePlay,
  onSeekTo,
  onSkip,
  onToggleMute,
  onVolume,
  onTogglePip,
  onToggleFullscreen,
  onCast,
  onChangePlaybackRate,
  videoScale,
  onVideoScale,
  videoFitMode = "contain",
  onVideoFitModeChange,
  subtitleOptions,
  subtitleSelectedId = "off",
  onSelectSubtitle,
  subtitleOffsetSec = 0,
  onNudgeSubtitleOffset,
  onResetSubtitleOffset,
  onAddSubtitleFile,
  onOpenSubtitleSync,
  subtitleHint = null,
  canPlayNext = false,
  nextEpisodeLabel = null,
  onPlayNext,
  canDownload,
  downloadBusy,
  downloadHint,
  isHlsStream,
  onDownload,
  errorActionLabel,
  onErrorAction,
}: PlayerOverlayProps) => {
  const [ratesOpen, setRatesOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [subsOpen, setSubsOpen] = useState(false);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  // A ref, not state: it is never rendered, and the pointerdown -> pointerup
  // of a fast click can land in the same React batch, so a state flag would
  // still read false in the pointerup handler and swallow the seek.
  const scrubbingRef = useRef(false);
  /** Staged seek target during a drag; committed once on release. */
  const [pendingSeek, setPendingSeek] = useState<number | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{ left: number; time: number } | null>(null);

  // While dragging, show the staged position rather than the video's real
  // time — the seek has not been committed yet, so currentTime is still back
  // where playback was and the bar would otherwise snap backwards under the
  // cursor.
  const displayTime = pendingSeek ?? currentTime;
  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (displayTime / duration) * 100)) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, Math.max(0, (buffered / duration) * 100)) : 0;

  useEffect(() => {
    if (!ratesOpen) return;
    const close = () => setRatesOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [ratesOpen]);

  useEffect(() => {
    if (!zoomOpen) return;
    const close = () => setZoomOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [zoomOpen]);

  useEffect(() => {
    if (!subsOpen) return;
    const close = () => setSubsOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [subsOpen]);

  const zoomPercent = Math.round(videoScale * 100);
  const subtitleActive = subtitleSelectedId !== "off";
  const hasEmbeddedSubtitles = (subtitleOptions ?? []).some((option) => option.kind === "embedded");
  const subtitleActiveLabel =
    (subtitleOptions ?? []).find((option) => option.id === subtitleSelectedId)?.label ?? "Off";

  const timeFromClientX = (clientX: number): number | null => {
    const el = scrubberRef.current;
    if (!el || !Number.isFinite(duration) || duration <= 0) return null;
    const rect = el.getBoundingClientRect();
    // A zero-width bar (not laid out yet, or hidden) makes this 0/0 = NaN;
    // seeking to NaN throws away the playback position for no reason.
    if (rect.width <= 0) return null;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const seconds = ratio * duration;
    return Number.isFinite(seconds) ? seconds : null;
  };

  // While dragging, only the BAR moves — the actual seek is committed once, on
  // release. Seeking on every pointermove made each drag issue dozens of
  // seeks, and every seek makes the media element open a fresh byte-range
  // connection to the provider; IP-locked panels answer that burst with 429
  // and then refuse everything until the limit resets. This is what made
  // fast-forwarding unusable.
  const handleScrubPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isLive || duration <= 0) return;
    event.stopPropagation();
    event.preventDefault();
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      /* capture is an optimisation; the drag still works without it */
    }
    scrubbingRef.current = true;
    setPendingSeek(timeFromClientX(event.clientX));
  };

  const handleScrubPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = scrubberRef.current;
    if (!el || duration <= 0 || isLive) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHoverPreview({ left: ratio * rect.width, time: ratio * duration });
    if (scrubbingRef.current) setPendingSeek(ratio * duration);
  };

  const handleScrubPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    try {
      (event.target as Element).releasePointerCapture?.(event.pointerId);
    } catch {
      /* pointer already released */
    }
    scrubbingRef.current = false;
    // A plain click is pointerdown+up in one spot, so it still seeks — once.
    const target = timeFromClientX(event.clientX) ?? pendingSeek;
    setPendingSeek(null);
    if (target != null) onSeekTo(target);
  };

  // Pointer capture normally guarantees pointerup, but if the gesture is
  // cancelled (touch interruption, context menu) commit what was staged
  // rather than leaving the bar stuck at a position the video never went to.
  const handleScrubPointerCancel = () => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    const target = pendingSeek;
    setPendingSeek(null);
    if (target != null) onSeekTo(target);
  };

  const handleScrubLeave = () => {
    setHoverPreview(null);
  };

  // Keyboard seek (TV remotes / tab focus) staged like the drag above: each
  // keydown (incl. auto-repeat while the key is held) only moves the staged
  // position, and the ONE real seek is committed on keyup. Seeking per repeat
  // would recreate exactly the byte-range burst the drag redesign eliminated.
  const handleScrubKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isLive || duration <= 0 || scrubbingRef.current) return;
    let target: number | null = null;
    if (event.key === "ArrowLeft") target = Math.max(0, displayTime - 10);
    else if (event.key === "ArrowRight") target = Math.min(duration, displayTime + 10);
    if (target == null) return;
    event.preventDefault();
    event.stopPropagation();
    setPendingSeek(target);
  };

  const handleScrubKeyUp = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (scrubbingRef.current || pendingSeek == null) return;
    event.preventDefault();
    event.stopPropagation();
    setPendingSeek(null);
    onSeekTo(pendingSeek);
  };

  // Flaky TV browsers can drop the keyup; don't leave the bar stuck at a
  // position the video never went to.
  const handleScrubBlur = () => {
    if (scrubbingRef.current || pendingSeek == null) return;
    setPendingSeek(null);
    onSeekTo(pendingSeek);
  };

  const volumeIcon = useMemo(() => {
    if (muted || volume <= 0.001) return <VolumeX size={18} />;
    if (volume < 0.5) return <Volume1 size={18} />;
    return <Volume2 size={18} />;
  }, [muted, volume]);

  const volumePercent = Math.round((muted ? 0 : volume) * 100);

  const applyVolumePercent = (raw: string): void => {
    if (raw.trim() === "") return;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n)) return;
    onVolume(Math.min(200, Math.max(0, n)) / 100);
  };
  const volumePercentKey = `${volumePercent}-${muted ? 1 : 0}`;

  const showCenterBigPlay = !loading && !error && !isPlaying;

  return (
    <div
      className={clsx(
        "pointer-events-none absolute inset-0 flex flex-col justify-between transition-opacity duration-200",
        controlsVisible || !isPlaying || loading || error ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/80 to-transparent" />

      <div className="pointer-events-auto relative z-10 flex items-start justify-between gap-2 p-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div className="flex min-w-0 max-w-full items-center gap-2 rounded-md bg-slate-950/70 px-2 py-1 text-xs text-slate-200">
            {isLive ? (
              <span className="inline-flex items-center gap-1 rounded bg-rose-600/80 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                <span className="h-1.5 w-1.5 rounded-full bg-white" /> Live
              </span>
            ) : null}
            <span className="truncate">{title}</span>
          </div>
          {castActive && castDeviceLabel ? (
            <span
              className="inline-flex max-w-full items-center gap-1 truncate rounded-md bg-cyan-950/80 px-2 py-1 text-[11px] font-medium text-cyan-100 ring-1 ring-cyan-500/40"
              title="Playback is on your Cast device. Use the controls below to pause, seek, and change volume."
            >
              <Cast size={12} className="shrink-0" aria-hidden />
              <span className="truncate">{castDeviceLabel}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="pointer-events-none relative z-10 flex flex-1 items-center justify-center">
        {loading ? (
          <div className="pointer-events-auto inline-flex items-center gap-2 rounded-full bg-slate-950/70 px-3 py-2 text-sm text-slate-200">
            <Loader2 size={16} className="animate-spin" /> Loading stream...
          </div>
        ) : null}
        {error ? (
          onErrorAction ? (
            <button
              type="button"
              className="pointer-events-auto mb-4 inline-flex max-w-md items-center gap-2 rounded-md bg-rose-950/90 px-3 py-2 text-left text-sm text-rose-100 shadow-lg transition hover:bg-rose-900/95"
              onClick={onErrorAction}
            >
              <AlertTriangle size={16} className="shrink-0" />
              <span className="min-w-0">
                {error}
                {errorActionLabel ? <span className="ml-1 font-semibold underline decoration-rose-200/50">{errorActionLabel}</span> : null}
              </span>
            </button>
          ) : (
            <div className="pointer-events-auto mb-4 inline-flex max-w-md items-center gap-2 rounded-md bg-rose-950/90 px-3 py-2 text-sm text-rose-100 shadow-lg">
              <AlertTriangle size={16} /> {error}
            </div>
          )
        ) : null}
        {showCenterBigPlay ? (
          <button
            type="button"
            aria-label="Play"
            onClick={onTogglePlay}
            className="pointer-events-auto flex h-16 w-16 items-center justify-center rounded-full bg-cyan-500/80 text-white shadow-xl transition hover:scale-105 hover:bg-cyan-400/90"
          >
            <Play size={28} className="translate-x-0.5" />
          </button>
        ) : null}
      </div>

      <div className="pointer-events-auto relative z-10 flex flex-col gap-2 px-3 pb-3">
        <div className="flex items-center gap-3 text-xs text-slate-300">
          <span className="tabular-nums">{isLive ? "LIVE" : formatDuration(displayTime)}</span>
          <div
            ref={scrubberRef}
            className={clsx(
              "group relative h-2 flex-1 rounded-full bg-slate-700/70",
              isLive || duration <= 0 ? "opacity-50" : "cursor-pointer",
            )}
            onPointerDown={handleScrubPointerDown}
            onPointerMove={handleScrubPointerMove}
            onPointerUp={handleScrubPointerUp}
            onPointerCancel={handleScrubPointerCancel}
            onPointerLeave={handleScrubLeave}
            onKeyDown={handleScrubKeyDown}
            onKeyUp={handleScrubKeyUp}
            onBlur={handleScrubBlur}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration) || 0}
            aria-valuenow={Math.floor(displayTime) || 0}
            // Not focusable while live/unseekable — a D-pad (tvNavigation)
            // would otherwise land on a slider that ignores every arrow.
            tabIndex={isLive || duration <= 0 ? -1 : 0}
          >
            <div className="absolute inset-y-0 left-0 rounded-full bg-slate-500/50" style={{ width: `${bufferedPct}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-cyan-400" style={{ width: `${progressPct}%` }} />
            <div
              className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300 shadow opacity-0 transition-opacity group-hover:opacity-100"
              style={{ left: `${progressPct}%` }}
            />
            {hoverPreview && !isLive ? (
              <div
                className="pointer-events-none absolute -top-7 -translate-x-1/2 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] text-slate-100"
                style={{ left: hoverPreview.left }}
              >
                {formatDuration(hoverPreview.time)}
              </div>
            ) : null}
          </div>
          <span className="tabular-nums">{isLive ? "" : formatDuration(duration)}</span>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="control-btn"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={onTogglePlay}
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <button
            type="button"
            className="control-btn"
            aria-label="Back 10 seconds"
            title="Back 10s"
            onClick={() => onSkip(-10)}
            disabled={isLive}
          >
            <RotateCcw size={18} />
          </button>
          <button
            type="button"
            className="control-btn"
            aria-label="Forward 10 seconds"
            title="Forward 10s"
            onClick={() => onSkip(10)}
            disabled={isLive}
          >
            <RotateCw size={18} />
          </button>
          {canPlayNext ? (
            <button
              type="button"
              className="control-btn"
              aria-label="Play next episode"
              title={nextEpisodeLabel ? `Next episode · ${nextEpisodeLabel}` : "Play next episode"}
              onClick={onPlayNext}
            >
              <SkipForward size={18} />
            </button>
          ) : null}

          <div className={clsx("ml-1 flex items-center gap-1", !volumePercentMode && "group")}>
            <button type="button" className="control-btn" aria-label="Mute" onClick={onToggleMute}>
              {volumeIcon}
            </button>
            {volumePercentMode ? (
              <>
                <label className="sr-only" htmlFor="player-volume-pct">
                  Volume percent
                </label>
                <input
                  key={volumePercentKey}
                  id="player-volume-pct"
                  type="number"
                  min={0}
                  max={200}
                  step={1}
                  defaultValue={volumePercent}
                  onBlur={(event) => applyVolumePercent(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  }}
                  className="input w-[3.25rem] py-1 text-center text-xs tabular-nums"
                  aria-label="Volume percent (press Enter or leave field to apply)"
                />
                <span className="text-[11px] text-slate-500">%</span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={(event) => onVolume(Number(event.target.value))}
                  aria-label="Volume"
                  title={`${volumePercent}%`}
                  className="w-20 accent-cyan-500"
                />
              </>
            ) : (
              <>
                <span className="hidden w-9 text-right text-[11px] tabular-nums text-slate-500 sm:inline" aria-hidden>
                  {volumePercent}%
                </span>
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={(event) => onVolume(Number(event.target.value))}
                  aria-label={`Volume ${volumePercent}%`}
                  title={`Volume ${volumePercent}%`}
                  // Touch has no hover: show the slider inline on phones. On sm+
                  // keep the tidy hover/focus-reveal so it doesn't crowd the bar.
                  className="ml-1 w-20 opacity-100 transition-all duration-200 accent-cyan-500 sm:w-0 sm:opacity-0 sm:group-hover:w-24 sm:group-hover:opacity-100 sm:focus:w-24 sm:focus:opacity-100"
                />
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1">
            {onSelectSubtitle ? (
              <div className="relative">
                <button
                  type="button"
                  className="control-btn"
                  aria-label="Subtitles"
                  aria-expanded={subsOpen}
                  title={
                    subtitleActive
                      ? `Subtitles: ${subtitleActiveLabel}`
                      : "Subtitles — pick a track, or add a file"
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    setRatesOpen(false);
                    setZoomOpen(false);
                    setSubsOpen((v) => !v);
                  }}
                >
                  <Captions size={18} className={subtitleActive ? "text-cyan-300" : undefined} />
                </button>
                {subsOpen ? (
                  <div
                    className="absolute bottom-full right-0 mb-2 w-64 rounded-md border border-slate-700 bg-slate-950/95 p-3 shadow-xl"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div className="mb-2 text-xs text-slate-300">Subtitles</div>
                    <div className="max-h-52 space-y-1 overflow-y-auto">
                      {(subtitleOptions ?? []).map((option) => (
                        <button
                          key={option.id}
                          type="button"
                          className={clsx(
                            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[11px] transition",
                            option.id === subtitleSelectedId
                              ? "bg-cyan-500/80 text-white"
                              : "bg-slate-800 text-slate-200 hover:bg-slate-700",
                          )}
                          onClick={() => onSelectSubtitle(option.id)}
                        >
                          <span className="min-w-0 flex-1 truncate">{option.label}</span>
                          {option.kind === "embedded" ? (
                            <span className="shrink-0 text-[10px] opacity-70">in video</span>
                          ) : null}
                        </button>
                      ))}
                    </div>
                    {!hasEmbeddedSubtitles ? (
                      <p className="mt-2 text-[10px] leading-snug text-slate-500">
                        This video has no subtitles of its own.
                      </p>
                    ) : null}
                    {onAddSubtitleFile ? (
                      <button
                        type="button"
                        className="mt-2 flex w-full items-center justify-center gap-1 rounded border border-dashed border-slate-600 px-2 py-1.5 text-[11px] text-slate-300 transition hover:border-slate-400 hover:text-slate-100"
                        onClick={onAddSubtitleFile}
                      >
                        <Plus size={12} />
                        Add subtitle file
                      </button>
                    ) : null}
                    <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                      .srt, .vtt or .ass — you can also drop one onto the player.
                    </p>
                    {subtitleActive && onNudgeSubtitleOffset ? (
                      <>
                        <div className="my-2 border-t border-slate-800" />
                        <div className="mb-1.5 flex items-center justify-between text-[11px]">
                          <span className="text-slate-300">Delay</span>
                          <span className="tabular-nums text-cyan-300">{formatOffset(subtitleOffsetSec)}</span>
                        </div>
                        {onOpenSubtitleSync ? (
                          <button
                            type="button"
                            className="mb-2 w-full rounded bg-cyan-500/15 px-2 py-1.5 text-[11px] text-cyan-200 transition hover:bg-cyan-500/25"
                            onClick={() => {
                              // The panel takes over this corner of the player —
                              // leaving the popover up would sit on top of it.
                              setSubsOpen(false);
                              onOpenSubtitleSync();
                            }}
                            title="Pick the line you can hear and let the player work out the delay"
                          >
                            Match a line to the video…
                          </button>
                        ) : null}
                        <div className="flex items-center gap-1">
                          {[-1, -0.5, 0.5, 1].map((step) => (
                            <button
                              key={step}
                              type="button"
                              className="flex-1 rounded bg-slate-800 px-1 py-1 text-[11px] tabular-nums text-slate-200 transition hover:bg-slate-700"
                              onClick={() => onNudgeSubtitleOffset(step)}
                              title={
                                step < 0 ? "Show subtitles earlier" : "Show subtitles later"
                              }
                            >
                              {step > 0 ? `+${step}` : step}
                            </button>
                          ))}
                          {onResetSubtitleOffset ? (
                            <button
                              type="button"
                              className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-200 transition hover:bg-slate-700"
                              onClick={onResetSubtitleOffset}
                              title="Reset the delay to 0"
                            >
                              Reset
                            </button>
                          ) : null}
                        </div>
                        <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
                          Negative shows lines earlier, positive later.
                        </p>
                      </>
                    ) : null}
                    {subtitleHint ? (
                      <p className="mt-2 text-[10px] leading-snug text-cyan-300/90">{subtitleHint}</p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
            <div className="relative">
              <button
                type="button"
                className="control-btn"
                aria-label="Video zoom"
                title={`Zoom ${zoomPercent}% — enlarge low-res video`}
                onClick={(event) => {
                  event.stopPropagation();
                  setRatesOpen(false);
                  setZoomOpen((v) => !v);
                }}
              >
                <ZoomIn size={18} />
                <span className="ml-1 text-[11px] tabular-nums">{zoomPercent}%</span>
              </button>
              {zoomOpen ? (
                <div
                  className="absolute bottom-full right-0 mb-2 w-52 rounded-md border border-slate-700 bg-slate-950/95 p-3 shadow-xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  {onVideoFitModeChange ? (
                    <>
                      <div className="mb-2 text-xs text-slate-300">Fit</div>
                      <div className="mb-3 flex flex-wrap gap-1">
                        {FIT_MODES.map((mode) => (
                          <button
                            key={mode.value}
                            type="button"
                            className={clsx(
                              "rounded px-2 py-1 text-[11px] transition",
                              videoFitMode === mode.value
                                ? "bg-cyan-500/80 text-white"
                                : "bg-slate-800 text-slate-200 hover:bg-slate-700",
                            )}
                            title={mode.title}
                            onClick={() => onVideoFitModeChange(mode.value)}
                          >
                            {mode.label}
                          </button>
                        ))}
                      </div>
                      <div className="mb-3 border-t border-slate-800" />
                    </>
                  ) : null}
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="text-slate-300">Zoom</span>
                    <span className="tabular-nums text-cyan-300">{zoomPercent}%</span>
                  </div>
                  <input
                    type="range"
                    min={ZOOM_MIN * 100}
                    max={ZOOM_MAX * 100}
                    step={5}
                    value={zoomPercent}
                    onChange={(event) => onVideoScale(Number(event.target.value) / 100)}
                    aria-label="Video zoom percent"
                    className="w-full accent-cyan-500"
                  />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {ZOOM_PRESETS.map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className={clsx(
                          "rounded px-2 py-1 text-[11px] tabular-nums transition",
                          Math.abs(preset - videoScale) < 0.001
                            ? "bg-cyan-500/80 text-white"
                            : "bg-slate-800 text-slate-200 hover:bg-slate-700",
                        )}
                        onClick={() => onVideoScale(preset)}
                      >
                        {Math.round(preset * 100)}%
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="relative">
              <button
                type="button"
                className="control-btn"
                aria-label="Playback speed"
                title={`Speed ${playbackRate}x`}
                onClick={(event) => {
                  event.stopPropagation();
                  setZoomOpen(false);
                  setRatesOpen((v) => !v);
                }}
              >
                <Settings size={18} />
                <span className="ml-1 text-[11px] tabular-nums">{playbackRate}x</span>
              </button>
              {ratesOpen ? (
                <div
                  className="absolute bottom-full right-0 mb-2 w-28 overflow-hidden rounded-md border border-slate-700 bg-slate-950/95 shadow-xl"
                  onClick={(event) => event.stopPropagation()}
                >
                  {RATES.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      className={clsx(
                        "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-slate-800",
                        rate === playbackRate ? "text-cyan-300" : "text-slate-200",
                      )}
                      onClick={() => {
                        onChangePlaybackRate(rate);
                        setRatesOpen(false);
                      }}
                    >
                      <span>{rate}x</span>
                      {rate === playbackRate ? <span>•</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className="control-btn"
              aria-label="Download"
              title={
                isHlsStream
                  ? "Download uses your browser cache when possible. HLS: saves the .m3u8 playlist (not a merged video file)."
                  : "Download uses your browser cache when the stream allows it, so replay may not re-download the full file."
              }
              onClick={onDownload}
              disabled={!canDownload || downloadBusy}
            >
              {downloadBusy ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
            </button>
            {canCast ? (
              <button
                type="button"
                className={clsx("control-btn", castActive && "ring-2 ring-cyan-400/70 ring-offset-2 ring-offset-slate-950")}
                aria-label={castActive ? "Stop casting" : "Cast to TV"}
                title={
                  castActive
                    ? "Stop casting and play on this browser again"
                    : "Choose a Chromecast, Google TV, or Android TV device on your Wi‑Fi network"
                }
                onClick={onCast}
              >
                <Cast size={18} />
              </button>
            ) : null}
            {canPip ? (
              <button type="button" className="control-btn" aria-label="Picture in picture" onClick={onTogglePip}>
                <PictureInPicture2 size={18} />
              </button>
            ) : null}
            <button
              type="button"
              className="control-btn"
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={onToggleFullscreen}
            >
              {isFullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
            </button>
          </div>
        </div>
        {downloadHint ? (
          <p
            className={clsx(
              "text-center text-[11px] leading-snug",
              downloadHint.startsWith("Saved") ? "text-emerald-400/90" : "text-amber-200/90",
            )}
          >
            {downloadHint}
          </p>
        ) : null}
        {castHint ? (
          <p className="text-center text-[11px] leading-snug text-amber-200/90" role="status">
            {castHint}
          </p>
        ) : null}
      </div>
      <CastDevicePicker
        devices={castDevices}
        pending={pendingCastDevice}
        itemTitle={title}
        onPick={(device) => onPickCastDevice?.(device)}
        onConfirm={() => onConfirmCastDevice?.()}
        onDismissConfirm={() => onDismissCastConfirm?.()}
        onCancel={() => onCancelCastPicker?.()}
      />
    </div>
  );
};
