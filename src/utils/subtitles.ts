/**
 * Subtitle file parsing: SRT, WebVTT and ASS/SSA into one cue shape.
 *
 * Browsers only render WebVTT natively, and only through a TextTrack — so
 * everything is normalized here into plain cues that the player turns into
 * VTTCues itself. Doing the conversion in-process (rather than handing the
 * file to a <track src>) is what makes a subtitle OFFSET possible: the cues
 * are re-emitted with shifted timings instead of the file being reloaded.
 *
 * Pure and dependency-free so it can be unit-tested without a DOM — see
 * subtitles.test.ts.
 */

/**
 * Marker on the single TextTrack the player renders subtitles through.
 *
 * Everything the user picks — an embedded track or an added file — is played
 * back through this one track, which is what lets the offset apply uniformly.
 * The credits detector skips it by this marker so mirrored cues are not
 * counted twice alongside the embedded track they were copied from.
 *
 * It is a LANGUAGE and not a label on purpose: hls.js claims ownership of
 * every text track with a non-empty label (its filterSubtitleTracks), and
 * would then disable ours the moment it sees it "showing" because the label
 * matches no rendition in the manifest. A blank label keeps it out of that
 * set entirely.
 */
export const MANAGED_TRACK_LANGUAGE = "x-ctv-subs";

export interface SubtitleCue {
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  /** Plain text; "\n" separates lines. May contain <i>/<b>/<u>, which VTT renders. */
  text: string;
}

export type SubtitleFormat = "srt" | "vtt" | "ass";

/** Cues shorter than this (or reversed) get this much screen time instead. */
const FALLBACK_CUE_SECONDS = 2;

/**
 * `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` / ASS's `H:MM:SS.cc`.
 *
 * The fraction is parsed as `0.<digits>` rather than assuming milliseconds,
 * which is what makes ASS centiseconds (`.50` = half a second, not 50ms) come
 * out right through the same code path.
 */
export const parseTimecode = (raw: string): number | null => {
  const value = raw.trim();
  if (!value) return null;
  const match = /^(\d{1,3}):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$|^(\d{1,3}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value);
  if (!match) return null;

  let seconds: number;
  let fraction: string | undefined;
  if (match[1] !== undefined) {
    seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    fraction = match[4];
  } else {
    // MM:SS — WebVTT allows the hours component to be omitted.
    seconds = Number(match[5]) * 60 + Number(match[6]);
    fraction = match[7];
  }
  if (!Number.isFinite(seconds)) return null;
  return fraction ? seconds + Number(`0.${fraction}`) : seconds;
};

/** Strip markup a VTTCue would show literally, and normalize line breaks. */
const cleanText = (raw: string): string =>
  raw
    .replace(/\r/g, "")
    // ASS drawing mode: {\p1}...{\p0} wraps vector shape commands, not
    // dialogue. Stripping only the braces would print "m 128 32 l 384 32" over
    // the video, so drop the whole run.
    .replace(/\{[^}]*\\p[1-9][^}]*\}[\s\S]*?(?:\{[^}]*\\p0[^}]*\}|$)/g, "")
    // ASS override blocks: {\an8}, {\i1}, {\pos(...)}, karaoke timings, ...
    .replace(/\{[^}]*\}/g, "")
    // ASS/SSA line breaks. \h is a NON-BREAKING SPACE, not a break — treating
    // it as one splits lines in the middle of a sentence.
    .replace(/\\h/g, " ")
    .replace(/\\[Nn]/g, "\n")
    // <font color="#fff"> has no VTT equivalent; <i>/<b>/<u> are kept.
    .replace(/<\/?font[^>]*>/gi, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();

const pushCue = (out: SubtitleCue[], start: number, end: number, text: string): void => {
  const body = cleanText(text);
  if (!body) return;
  // Reversed or zero-length timings appear in hand-edited files; showing the
  // line briefly beats dropping dialogue on the floor.
  const safeEnd = end > start ? end : start + FALLBACK_CUE_SECONDS;
  out.push({ start: Math.max(0, start), end: Math.max(0, safeEnd), text: body });
};

/**
 * SRT and WebVTT share a structure — blocks separated by blank lines, one of
 * which holds `-->` — so one parser handles both. VTT-only furniture (the
 * WEBVTT header, NOTE/STYLE/REGION blocks, cue settings after the end
 * timestamp) is skipped.
 */
const parseCueBlocks = (input: string): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  // `\r+\n` first: files saved through a broken pipeline carry doubled CRs,
  // and turning each one into its own newline would split every line into its
  // own block (and parse to zero cues). Blank-line separators are then matched
  // tolerantly, because a "blank" line routinely holds a space or a tab —
  // splitting on /\n{2,}/ alone merges the entire file into one cue.
  const blocks = input
    .replace(/\r+\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\uFEFF/, "")
    .split(/\n(?:[^\S\n]*\n)+/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    const head = lines[0].trim();
    if (/^WEBVTT/i.test(head) || /^(NOTE|STYLE|REGION)\b/i.test(head)) continue;

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;

    const [rawStart, rawRest] = lines[timingIndex].split("-->");
    if (rawRest === undefined) continue;
    const start = parseTimecode(rawStart);
    // Cue settings ride along after the end timestamp: "... --> 00:02.0 line:90%".
    const end = parseTimecode(rawRest.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null) continue;

    pushCue(cues, start, end, lines.slice(timingIndex + 1).join("\n"));
  }
  return cues;
};

/**
 * ASS/SSA: read the `[Events]` section's `Format:` line to locate the Start,
 * End and Text columns (their order is not fixed), then each `Dialogue:` row.
 * Text is last and may itself contain commas, so the split is bounded.
 */
const parseAss = (input: string): SubtitleCue[] => {
  const cues: SubtitleCue[] = [];
  const lines = input.replace(/\r+\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let columns: string[] | null = null;
  let inEvents = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = /^\[events\]$/i.test(trimmed);
      continue;
    }
    if (!inEvents) continue;

    if (/^Format\s*:/i.test(trimmed)) {
      columns = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((name) => name.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(trimmed)) continue;

    const cols = columns ?? ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
    const startIdx = cols.indexOf("start");
    const endIdx = cols.indexOf("end");
    const textIdx = cols.indexOf("text");
    if (startIdx === -1 || endIdx === -1 || textIdx === -1) continue;

    // Text is the final field and can contain commas — keep it whole.
    const parts = trimmed.slice(trimmed.indexOf(":") + 1).split(",");
    if (parts.length <= textIdx) continue;
    const text = parts.slice(textIdx).join(",");
    const start = parseTimecode(parts[startIdx] ?? "");
    const end = parseTimecode(parts[endIdx] ?? "");
    if (start === null || end === null) continue;

    pushCue(cues, start, end, text);
  }
  return cues;
};

/** Sniff the format from the content (a wrong file extension is common). */
export const detectSubtitleFormat = (input: string, filename?: string): SubtitleFormat => {
  const head = input.slice(0, 4096);
  if (/^\uFEFF?\s*WEBVTT/i.test(head)) return "vtt";
  if (/^\s*\[Script Info\]/im.test(head) || /^\s*\[V4\+? Styles\]/im.test(head) || /^\s*Dialogue\s*:/im.test(head)) {
    return "ass";
  }
  if (/-->/.test(head)) return "srt";
  const ext = filename?.toLowerCase().split(".").pop();
  if (ext === "vtt") return "vtt";
  if (ext === "ass" || ext === "ssa") return "ass";
  return "srt";
};

/**
 * Parse any supported subtitle file into sorted cues. Returns an empty array
 * rather than throwing — a file that parses to nothing is reported to the
 * user as "no cues", which is more useful than a stack trace.
 */
export const parseSubtitles = (input: string, filename?: string): SubtitleCue[] => {
  const format = detectSubtitleFormat(input, filename);
  const cues = format === "ass" ? parseAss(input) : parseCueBlocks(input);
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
};

/** Shift cues by `offsetSec` (positive = later), clamped at zero. */
export const shiftCues = (cues: readonly SubtitleCue[], offsetSec: number): SubtitleCue[] => {
  if (offsetSec === 0) return cues.slice();
  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    const end = cue.end + offsetSec;
    // A cue pushed entirely before zero can never be shown.
    if (end <= 0) continue;
    out.push({ ...cue, start: Math.max(0, cue.start + offsetSec), end });
  }
  return out;
};

/**
 * Index of the cue that SHOULD be on screen at `timeSec` under the current
 * offset — the last one that has already started. Falls back to the first cue
 * when playback is still before all of them, so the sync list always has
 * somewhere sensible to focus.
 *
 * Binary search: subtitle files routinely run to thousands of cues and this is
 * re-evaluated as the clock ticks.
 */
export const focusedCueIndex = (
  cues: readonly SubtitleCue[],
  offsetSec: number,
  timeSec: number,
): number => {
  if (cues.length === 0) return -1;
  let low = 0;
  let high = cues.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start + offsetSec <= timeSec) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found === -1 ? 0 : found;
};

/**
 * The offset that makes `cueStartSec` land exactly on `timeSec`.
 *
 * This is the whole point of match-a-line syncing: instead of guessing "+3s"
 * and checking, the user says "THIS line is what I'm hearing right now" and
 * the delay is derived from it.
 */
export const offsetForMatch = (cueStartSec: number, timeSec: number): number =>
  Math.round((timeSec - cueStartSec) * 10) / 10;

/** "+1.5s" / "-0.5s" / "0s" — the offset as shown next to the controls. */
export const formatOffset = (offsetSec: number): string => {
  if (Math.abs(offsetSec) < 0.001) return "0s";
  const rounded = Math.round(offsetSec * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}s`;
};
