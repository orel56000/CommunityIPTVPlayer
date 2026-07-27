import clsx from "clsx";
import type { CreditsDetectionResult, CreditsSignalName } from "../../types/credits";
import { formatDuration } from "../../utils/time";

export interface CreditsDebugPanelProps {
  result: CreditsDetectionResult;
  triggerScore: number;
  requiredConsecutiveSamples: number;
}

const SIGNAL_ORDER: CreditsSignalName[] = [
  "nearEnd",
  "subtitleSilence",
  "dialogueDrop",
  "darkFrame",
  "lowMotion",
  "audioTransition",
  "fadeToBlack",
];

const num = (value: number | null | undefined, digits = 3): string =>
  value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);

/**
 * Development-only readout of the credits detector. Enabled through the
 * detector's `debug` config flag, which the player wires to `import.meta.env.DEV`.
 */
export const CreditsDebugPanel = ({
  result,
  triggerScore,
  requiredConsecutiveSamples,
}: CreditsDebugPanelProps) => {
  const debug = result.debug;
  if (!debug) return null;

  const row = (label: string, value: string) => (
    <div key={label} className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="tabular-nums text-slate-200">{value}</span>
    </div>
  );

  return (
    <div className="pointer-events-none absolute left-3 top-14 z-20 w-56 space-y-1 rounded-lg border border-white/10 bg-slate-950/85 p-2.5 font-mono text-[10px] leading-relaxed backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 pb-1">
        <span className="font-semibold uppercase tracking-wider text-cyan-400/90">credits</span>
        <span
          className={clsx(
            "rounded px-1.5 py-0.5 font-semibold tabular-nums",
            debug.score >= triggerScore ? "bg-emerald-500/20 text-emerald-300" : "bg-slate-700/60 text-slate-300",
          )}
        >
          {debug.score}/{triggerScore}
        </span>
      </div>

      {row("t", `${formatDuration(debug.mediaTime)} (-${formatDuration(debug.remaining)})`)}
      {row("streak", `${debug.consecutive}/${requiredConsecutiveSamples}`)}
      {row("weight", `${debug.availableWeight}`)}
      {row("luma", `${num(debug.luma)} / base ${num(debug.baselineLuma)}`)}
      {row("dark%", num(debug.darkFraction, 2))}
      {row("motion", `${num(debug.motion)} / base ${num(debug.baselineMotion)}`)}
      {row("audio", `${num(debug.audioLevel)} cv ${num(debug.audioVariation, 2)}`)}
      {row("no-dialog", debug.secondsSinceDialogue == null ? "—" : `${debug.secondsSinceDialogue.toFixed(0)}s`)}

      <div className="flex flex-wrap gap-1 border-t border-white/10 pt-1">
        {SIGNAL_ORDER.map((name) => (
          <span
            key={name}
            className={clsx(
              "rounded px-1 py-0.5 text-[9px]",
              result.signals[name] ? "bg-cyan-500/25 text-cyan-200" : "bg-slate-800/70 text-slate-600",
            )}
          >
            {name}
          </span>
        ))}
      </div>

      <div className="border-t border-white/10 pt-1 text-slate-400">
        <div>
          src {String(result.source ?? "—")} · vis {debug.availability.visual ? "y" : "n"} · sub{" "}
          {debug.availability.subtitles ? "y" : "n"} · aud {debug.availability.audio ? "y" : "n"}
        </div>
        <div className="truncate" title={debug.reason ?? undefined}>
          {result.creditsDetected
            ? `FIRED @ ${formatDuration(result.detectedAt ?? 0)} (${result.confidence}%)`
            : (debug.reason ?? "watching")}
        </div>
      </div>
    </div>
  );
};
