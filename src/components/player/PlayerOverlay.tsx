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
  Settings,
  Volume1,
  Volume2,
  VolumeX,
} from "lucide-react";
import clsx from "clsx";
import { formatDuration } from "../../utils/time";

export interface PlayerOverlayProps {
  title: string;
  loading: boolean;
  error: string | null;
  isPlaying: boolean;
  isLive: boolean;
  isFullscreen: boolean;
  canPip: boolean;
  canCast: boolean;
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
  canDownload: boolean;
  downloadBusy: boolean;
  downloadHint: string | null;
  isHlsStream: boolean;
  onDownload: () => void;
}

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export const PlayerOverlay = ({
  title,
  loading,
  error,
  isPlaying,
  isLive,
  isFullscreen,
  canPip,
  canCast,
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
  canDownload,
  downloadBusy,
  downloadHint,
  isHlsStream,
  onDownload,
}: PlayerOverlayProps) => {
  const [ratesOpen, setRatesOpen] = useState(false);
  const scrubberRef = useRef<HTMLDivElement | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<{ left: number; time: number } | null>(null);

  const progressPct = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const bufferedPct = duration > 0 ? Math.min(100, Math.max(0, (buffered / duration) * 100)) : 0;

  useEffect(() => {
    if (!ratesOpen) return;
    const close = () => setRatesOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [ratesOpen]);

  const seekFromClientX = (clientX: number): void => {
    const el = scrubberRef.current;
    if (!el || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    onSeekTo(ratio * duration);
  };

  const handleScrubPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isLive || duration <= 0) return;
    event.stopPropagation();
    event.preventDefault();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    setScrubbing(true);
    seekFromClientX(event.clientX);
  };

  const handleScrubPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = scrubberRef.current;
    if (!el || duration <= 0 || isLive) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    setHoverPreview({ left: ratio * rect.width, time: ratio * duration });
    if (scrubbing) seekFromClientX(event.clientX);
  };

  const handleScrubPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbing) return;
    (event.target as Element).releasePointerCapture?.(event.pointerId);
    setScrubbing(false);
  };

  const handleScrubLeave = () => {
    setHoverPreview(null);
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
    onVolume(Math.min(100, Math.max(0, n)) / 100);
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
          <div className="pointer-events-auto mb-4 inline-flex max-w-md items-center gap-2 rounded-md bg-rose-950/90 px-3 py-2 text-sm text-rose-100 shadow-lg">
            <AlertTriangle size={16} /> {error}
          </div>
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
          <span className="tabular-nums">{isLive ? "LIVE" : formatDuration(currentTime)}</span>
          <div
            ref={scrubberRef}
            className={clsx(
              "group relative h-2 flex-1 rounded-full bg-slate-700/70",
              isLive || duration <= 0 ? "opacity-50" : "cursor-pointer",
            )}
            onPointerDown={handleScrubPointerDown}
            onPointerMove={handleScrubPointerMove}
            onPointerUp={handleScrubPointerUp}
            onPointerLeave={handleScrubLeave}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration) || 0}
            aria-valuenow={Math.floor(currentTime) || 0}
            tabIndex={-1}
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
                  max={100}
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
                  max={1}
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
                  max={1}
                  step={0.01}
                  value={muted ? 0 : volume}
                  onChange={(event) => onVolume(Number(event.target.value))}
                  aria-label={`Volume ${volumePercent}%`}
                  title={`Volume ${volumePercent}%`}
                  className="ml-1 w-0 opacity-0 transition-all duration-200 group-hover:w-24 group-hover:opacity-100 focus:w-24 focus:opacity-100 accent-cyan-500"
                />
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1">
            <div className="relative">
              <button
                type="button"
                className="control-btn"
                aria-label="Playback speed"
                title={`Speed ${playbackRate}x`}
                onClick={(event) => {
                  event.stopPropagation();
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
    </div>
  );
};
