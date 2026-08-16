import { useCallback, useEffect, useRef, useState } from "react";
import {
  MANAGED_TRACK_LANGUAGE,
  parseSubtitles,
  shiftCues,
  type SubtitleCue,
} from "../utils/subtitles";

export interface SubtitleOption {
  /** "off" | "embedded:<index>" | "external:<n>" */
  id: string;
  label: string;
  kind: "off" | "embedded" | "external";
}

export interface UseSubtitlesReturn {
  /** "Off" first, then any embedded tracks, then added files. */
  options: SubtitleOption[];
  selectedId: string;
  select: (id: string) => void;
  offsetSec: number;
  nudgeOffset: (deltaSec: number) => void;
  resetOffset: () => void;
  /** Parse + add a dropped/chosen file. Resolves to a message for the user. */
  addFile: (file: File) => Promise<string>;
  /** Transient status line under the list (added / failed / none found). */
  hint: string | null;
  /** True once an embedded track or an added file exists. */
  hasSubtitles: boolean;
}

export const OFF_ID = "off";

/**
 * Subtitle files are frequently NOT UTF-8 — Hebrew and Arabic releases are
 * routinely windows-1255/1256, and Western European ones latin-1. Decoding
 * those as UTF-8 yields a page of replacement characters, so try UTF-8
 * strictly first and fall back through the common legacy code pages.
 */
const decodeSubtitleBytes = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    /* not valid UTF-8 — fall through to the legacy code pages */
  }
  for (const encoding of ["windows-1255", "windows-1256", "windows-1251", "windows-1252"]) {
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      if (text.trim()) return text;
    } catch {
      /* try the next one */
    }
  }
  // Last resort: lossy UTF-8 rather than refusing the file outright.
  return new TextDecoder("utf-8").decode(buffer);
};

/** `track.cues` is null while a track is "disabled" — never read it blindly. */
const readableCues = (track: TextTrack): TextTrackCueList | null => {
  if (track.mode === "disabled") {
    try {
      track.mode = "hidden";
    } catch {
      return null;
    }
  }
  return track.cues;
};

const clearCues = (track: TextTrack): void => {
  const cues = readableCues(track);
  if (!cues) return;
  for (let index = cues.length - 1; index >= 0; index -= 1) {
    try {
      track.removeCue(cues[index]);
    } catch {
      /* already gone */
    }
  }
};

/** Snapshot a live TextTrackCueList into plain cues. */
const copyCues = (cues: TextTrackCueList): SubtitleCue[] => {
  const out: SubtitleCue[] = [];
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index] as TextTrackCue & { text?: string };
    out.push({ start: cue.startTime, end: cue.endTime, text: cue.text ?? "" });
  }
  return out;
};

const fillCues = (track: TextTrack, cues: readonly SubtitleCue[]): number => {
  const CueCtor =
    (window as unknown as { VTTCue?: typeof VTTCue }).VTTCue ??
    (window as unknown as { TextTrackCue?: typeof VTTCue }).TextTrackCue;
  if (!CueCtor) return 0;
  let added = 0;
  for (const cue of cues) {
    try {
      const vttCue = new CueCtor(cue.start, cue.end, cue.text);
      // Sit a few lines off the bottom instead of flush against it, so the
      // control bar doesn't cover the dialogue whenever it's on screen.
      // Negative counts up from the bottom edge.
      try {
        vttCue.line = -3;
      } catch {
        // Engines that reject the property still render at their default.
      }
      track.addCue(vttCue);
      added += 1;
    } catch {
      // A single malformed cue must not abandon the rest of the file.
    }
  }
  return added;
};

export const useSubtitles = (
  videoRef: React.RefObject<HTMLVideoElement | null>,
  /** Changes when a different item loads; resets everything. */
  contentKey: string | null,
): UseSubtitlesReturn => {
  const [embedded, setEmbedded] = useState<SubtitleOption[]>([]);
  const [externals, setExternalsState] = useState<{ id: string; label: string; cues: SubtitleCue[] }[]>([]);
  const setExternals = useCallback((next: { id: string; label: string; cues: SubtitleCue[] }[]) => {
    externalsRef.current = next;
    setExternalsState(next);
  }, []);
  const [selectedId, setSelectedId] = useState<string>(OFF_ID);
  const [offsetSec, setOffsetSec] = useState(0);
  const [hint, setHint] = useState<string | null>(null);

  const managedRef = useRef<TextTrack | null>(null);
  const externalSeq = useRef(0);
  /**
   * Mirror of `externals`, so addFile can resolve the id BEFORE dispatching.
   * Assigning it inside a setState updater looked equivalent but is not:
   * React only runs the updater eagerly when the owning fiber has no pending
   * work, and this fiber re-renders ~4x/second from timeupdate — so the id
   * read back out was often still "", and the file was added but never
   * selected. Dev StrictMode's extra render hid it; production did not.
   */
  const externalsRef = useRef<{ id: string; label: string; cues: SubtitleCue[] }[]>([]);
  /** Cue count the managed track SHOULD have, for the self-healing poll. */
  const expectedCueCountRef = useRef(0);
  /** Source cue count last mirrored, so streamed-in cues can be picked up. */
  const mirroredCountRef = useRef(-1);

  // New item: forget the previous item's tracks, files and alignment.
  useEffect(() => {
    setEmbedded([]);
    setExternals([]);
    expectedCueCountRef.current = 0;
    setSelectedId(OFF_ID);
    setOffsetSec(0);
    setHint(null);
    mirroredCountRef.current = -1;
  }, [contentKey, setExternals]);

  // Embedded tracks appear asynchronously (in-band tracks arrive after
  // metadata, and HLS adds them as the manifest is parsed), so watch the list
  // rather than reading it once.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const list = video.textTracks;
    if (!list) return;

    const refresh = () => {
      const next: SubtitleOption[] = [];
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index];
        if (track.language === MANAGED_TRACK_LANGUAGE) continue;
        if (track.kind !== "subtitles" && track.kind !== "captions") continue;
        next.push({
          id: `embedded:${index}`,
          kind: "embedded",
          label: track.label || track.language || `Embedded ${next.length + 1}`,
        });
      }
      setEmbedded((prev) =>
        prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.label === next[i].label)
          ? prev
          : next,
      );
    };

    refresh();
    list.addEventListener?.("addtrack", refresh);
    list.addEventListener?.("removetrack", refresh);
    list.addEventListener?.("change", refresh);
    const poll = window.setInterval(refresh, 2000);
    return () => {
      list.removeEventListener?.("addtrack", refresh);
      list.removeEventListener?.("removetrack", refresh);
      list.removeEventListener?.("change", refresh);
      window.clearInterval(poll);
    };
  }, [videoRef, contentKey, setExternals]);

  /** The one track everything renders through; created lazily, reused after. */
  const ensureManaged = useCallback((video: HTMLVideoElement): TextTrack | null => {
    const list = video.textTracks;
    if (!list) return null;
    for (let index = 0; index < list.length; index += 1) {
      if (list[index].language === MANAGED_TRACK_LANGUAGE) {
        managedRef.current = list[index];
        return list[index];
      }
    }
    try {
      // Tracks added this way are NOT media-resource-specific, so this one
      // survives source changes — hence the reuse scan above. The BLANK label
      // is load-bearing: hls.js only manages labelled subtitle tracks.
      const track = video.addTextTrack("subtitles", "", MANAGED_TRACK_LANGUAGE);
      managedRef.current = track;
      return track;
    } catch {
      return null;
    }
  }, []);

  // Render the selection through the managed track, with the offset applied.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const managed = ensureManaged(video);
    if (!managed) return;

    // Nothing but the managed track may render, or lines would double up.
    const list = video.textTracks;
    for (let index = 0; index < list.length; index += 1) {
      const track = list[index];
      if (track === managed) continue;
      if (track.mode === "showing") {
        try {
          track.mode = "hidden";
        } catch {
          /* engine refused; harmless */
        }
      }
    }

    // Must be non-disabled before touching cues (cues is null when disabled).
    try {
      managed.mode = "hidden";
    } catch {
      return;
    }
    clearCues(managed);
    mirroredCountRef.current = -1;

    if (selectedId === OFF_ID) {
      try {
        managed.mode = "disabled";
      } catch {
        /* leaving it hidden is equally invisible */
      }
      return;
    }

    const external = externals.find((entry) => entry.id === selectedId);
    if (external) {
      expectedCueCountRef.current = fillCues(managed, shiftCues(external.cues, offsetSec));
      managed.mode = "showing";
      return;
    }

    if (selectedId.startsWith("embedded:")) {
      const index = Number(selectedId.slice("embedded:".length));
      const source = list[index];
      // Even with no source yet (the track list is still filling in), show the
      // empty track rather than returning early — returning would leave it
      // stuck "hidden" with the poll below faithfully preserving that.
      if (source) {
        const cues = readableCues(source);
        if (cues) {
          expectedCueCountRef.current = fillCues(managed, shiftCues(copyCues(cues), offsetSec));
          mirroredCountRef.current = cues.length;
        }
      }
      managed.mode = "showing";
    }
  }, [videoRef, ensureManaged, selectedId, offsetSec, externals, contentKey]);

  // Self-healing watchdog. Two things quietly undo the work above:
  //   1. hls.js wipes cues off EVERY text track (its _cleanTracks is
  //      unfiltered) whenever media is attached or detached — which happens on
  //      "Try again", on the frame-watchdog reload, and on each live-fallback
  //      attempt. Without this the subtitles just disappear mid-item with no
  //      way back except re-picking them.
  //   2. An embedded track's cues keep streaming in, and another track can
  //      start "showing" later and double the lines on screen.
  useEffect(() => {
    if (selectedId === OFF_ID) return;
    const video = videoRef.current;
    if (!video) return;

    const tick = () => {
      const managed = managedRef.current;
      const list = video.textTracks;
      if (!managed || !list) return;

      // Nothing but the managed track may render.
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index];
        if (track !== managed && track.mode === "showing") {
          try {
            track.mode = "hidden";
          } catch {
            /* engine refused; harmless */
          }
        }
      }

      const external = externalsRef.current.find((entry) => entry.id === selectedId);
      let desired: SubtitleCue[] | null = null;

      if (external) {
        // Only rebuild when the cues actually went missing.
        const current = managed.mode === "disabled" ? null : managed.cues;
        if (current && current.length === expectedCueCountRef.current && managed.mode === "showing") return;
        desired = shiftCues(external.cues, offsetSec);
      } else if (selectedId.startsWith("embedded:")) {
        const source = list[Number(selectedId.slice("embedded:".length))];
        if (!source) return;
        const cues = readableCues(source);
        if (!cues) return;
        const managedCues = managed.mode === "disabled" ? null : managed.cues;
        const intact =
          cues.length === mirroredCountRef.current &&
          managedCues &&
          managedCues.length === expectedCueCountRef.current &&
          managed.mode === "showing";
        if (intact) return;
        desired = shiftCues(copyCues(cues), offsetSec);
        mirroredCountRef.current = cues.length;
      }
      if (!desired) return;

      try {
        managed.mode = "hidden";
      } catch {
        return;
      }
      clearCues(managed);
      expectedCueCountRef.current = fillCues(managed, desired);
      try {
        // Always back to showing — never restore a mode hls.js just forced.
        managed.mode = "showing";
      } catch {
        /* ignore */
      }
    };

    const poll = window.setInterval(tick, 2000);
    return () => window.clearInterval(poll);
  }, [videoRef, selectedId, offsetSec]);

  const addFile = useCallback(async (file: File): Promise<string> => {
    try {
      const cues = parseSubtitles(decodeSubtitleBytes(await file.arrayBuffer()), file.name);
      if (cues.length === 0) {
        const message = `No subtitles found in ${file.name}`;
        setHint(message);
        return message;
      }
      // Re-adding the same file (dropped twice, or picked again after
      // editing it) replaces that entry instead of stacking duplicates.
      const prev = externalsRef.current;
      const existing = prev.find((entry) => entry.label === file.name);
      const id = existing?.id ?? `external:${(externalSeq.current += 1)}`;
      setExternals(
        existing
          ? prev.map((entry) => (entry.id === id ? { ...entry, cues } : entry))
          : [...prev, { id, label: file.name, cues }],
      );
      setSelectedId(id);
      setOffsetSec(0);
      const message = `Added ${file.name} (${cues.length} lines)`;
      setHint(message);
      return message;
    } catch (error) {
      const message = `Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      setHint(message);
      return message;
    }
  }, [setExternals]);

  // Let a status line linger long enough to read, then clear itself.
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), 4000);
    return () => window.clearTimeout(timer);
  }, [hint]);

  const select = useCallback((id: string) => {
    setSelectedId(id);
    // Alignment belongs to a specific track/file pairing, not to the item.
    setOffsetSec(0);
  }, []);

  const nudgeOffset = useCallback((deltaSec: number) => {
    setOffsetSec((prev) => Math.round((prev + deltaSec) * 10) / 10);
  }, []);

  const resetOffset = useCallback(() => setOffsetSec(0), []);

  const options: SubtitleOption[] = [
    { id: OFF_ID, kind: "off", label: "Off" },
    ...embedded,
    ...externals.map((entry) => ({ id: entry.id, kind: "external" as const, label: entry.label })),
  ];

  return {
    options,
    selectedId,
    select,
    offsetSec,
    nudgeOffset,
    resetOffset,
    addFile,
    hint,
    hasSubtitles: embedded.length > 0 || externals.length > 0,
  };
};
