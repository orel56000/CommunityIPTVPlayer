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
  /** Set the delay outright (match-a-line syncing computes one). */
  setOffset: (sec: number) => void;
  /**
   * The selected track's cues at their ORIGINAL timings, for the sync panel.
   * Unshifted on purpose: the panel derives a new offset from them, so
   * feeding it already-shifted times would compound the existing delay.
   */
  selectedCues: SubtitleCue[];
  /** Parse + add a dropped/chosen file. Resolves to a message for the user. */
  addFile: (file: File) => Promise<string>;
  /** Transient status line under the list (added / failed / none found). */
  hint: string | null;
  /** True once an embedded track or an added file exists. */
  hasSubtitles: boolean;
  /**
   * Replace the selected track's cues with synced ones, keeping the original
   * for `undoSyncedCues`.
   *
   * An EMBEDDED selection is promoted to a new external entry rather than
   * edited in place: the self-healing watchdog below re-mirrors an embedded
   * track from its source every two seconds, so synced cues written over it
   * would be silently reverted within the next tick.
   *
   * Pass `forTrackId` to make the write conditional on that track still being
   * the selected one — a long-running sync must not land on a track the user
   * switched to while it was working. Returns whether the cues were applied.
   */
  applySyncedCues: (cues: SubtitleCue[], label?: string, forTrackId?: string) => boolean;
  /** Put back the cues (and the delay) from before the last apply. */
  undoSyncedCues: () => void;
  canUndoSyncedCues: boolean;
  /**
   * Cues from a DIFFERENT track, for use as a sync reference.
   *
   * ffsubsync's default is to align against the video's own subtitles when it
   * has any, and only fall back to listening to the audio. This is that: an
   * already-correct track makes the sync exact and instant. Resolves to an
   * empty array when there is no other track to use.
   *
   * Reading an in-band track means briefly un-disabling it — see
   * `peekTrackCues` — which for an HLS rendition costs one small WebVTT fetch.
   */
  collectReferenceCues: (signal?: AbortSignal) => Promise<SubtitleCue[]>;
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

/**
 * Read a track's cues without leaving it enabled.
 *
 * In-band and HLS subtitle tracks sit at mode "disabled", where `cues` is null.
 * Moving one to "hidden" makes the engine populate it — and, for an HLS
 * rendition, fetch it — so this waits (briefly, bounded) for cues to appear and
 * then puts the mode back. Never "showing": that would put a second set of
 * lines on screen behind the managed track.
 */
const peekTrackCues = async (
  track: TextTrack,
  timeoutMs = 3000,
  signal?: AbortSignal,
): Promise<SubtitleCue[]> => {
  const existing = track.mode === "disabled" ? null : track.cues;
  if (existing && existing.length > 0) return copyCues(existing);
  if (signal?.aborted) return [];

  const originalMode = track.mode;
  try {
    track.mode = "hidden";
  } catch {
    return [];
  }
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !signal?.aborted && !(track.cues && track.cues.length > 0)) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }
    return track.cues && track.cues.length > 0 ? copyCues(track.cues) : [];
  } finally {
    try {
      track.mode = originalMode;
    } catch {
      // The render effect forces every non-managed track back to hidden on its
      // next pass, so a refused restore is cosmetic.
    }
  }
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
  /** Last mirror of the selected embedded track, for the sync panel. */
  const [embeddedCues, setEmbeddedCues] = useState<SubtitleCue[]>([]);
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
  /** What the selected track looked like before the last automatic sync. */
  const syncUndoRef = useRef<{ id: string; cues: SubtitleCue[]; offsetSec: number } | null>(null);
  const [canUndoSyncedCues, setCanUndoSyncedCues] = useState(false);
  /** Cue count the managed track SHOULD have, for the self-healing poll. */
  const expectedCueCountRef = useRef(0);
  /** Source cue count last mirrored, so streamed-in cues can be picked up. */
  const mirroredCountRef = useRef(-1);

  // New item: forget the previous item's tracks, files and alignment.
  useEffect(() => {
    setEmbedded([]);
    setExternals([]);
    setEmbeddedCues([]);
    expectedCueCountRef.current = 0;
    setSelectedId(OFF_ID);
    setOffsetSec(0);
    setHint(null);
    mirroredCountRef.current = -1;
    syncUndoRef.current = null;
    setCanUndoSyncedCues(false);
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
          const copied = copyCues(cues);
          setEmbeddedCues(copied);
          expectedCueCountRef.current = fillCues(managed, shiftCues(copied, offsetSec));
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
        const copied = copyCues(cues);
        // Only publish when the cue list actually grew — this runs every 2s
        // and a fresh array each tick would re-render the sync panel forever.
        if (cues.length !== mirroredCountRef.current) setEmbeddedCues(copied);
        desired = shiftCues(copied, offsetSec);
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
      // The undo snapshot belongs to whatever was selected before. Leaving it
      // armed means "Undo sync" would delete the file that was just added.
      syncUndoRef.current = null;
      setCanUndoSyncedCues(false);
      const message = `Added ${file.name} (${cues.length} lines)`;
      setHint(message);
      return message;
    } catch (error) {
      const message = `Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      setHint(message);
      return message;
    }
  }, [setExternals]);

  /**
   * Swap in cues produced by an automatic sync.
   *
   * The synced timings are BAKED INTO THE CUES and the manual delay is reset to
   * zero, rather than the sync being expressed as an offset. It has to be: a
   * framerate correction and a piecewise result are not a single shift, so
   * there is no offset that could represent them. It also means the "Delay"
   * nudges keep working afterwards, as a manual adjustment ON TOP of the sync —
   * which is what "manual offset adjustment afterwards" should feel like.
   *
   * The user's own file is never touched. Even for an external entry the cues
   * are replaced only in memory; the file on disk is whatever they dropped.
   */
  const applySyncedCues = useCallback(
    (cues: SubtitleCue[], label?: string, forTrackId?: string) => {
      if (cues.length === 0) return false;
      // A sync takes minutes; the user may well have picked a different track
      // meanwhile. Applying one track's timings to another is worse than doing
      // nothing, so the caller passes the track it started on and this refuses
      // if the selection has moved.
      if (forTrackId !== undefined && forTrackId !== selectedId) return false;
      const prev = externalsRef.current;
      const existing = prev.find((entry) => entry.id === selectedId);

      if (existing) {
        syncUndoRef.current = { id: existing.id, cues: existing.cues, offsetSec };
        setExternals(prev.map((entry) => (entry.id === existing.id ? { ...entry, cues } : entry)));
      } else {
        // An embedded selection becomes a new external entry. Editing the
        // embedded mirror in place would survive exactly one watchdog tick.
        const id = `external:${(externalSeq.current += 1)}`;
        const sourceLabel =
          label ?? `${embedded.find((option) => option.id === selectedId)?.label ?? "Subtitles"} (synced)`;
        syncUndoRef.current = { id: selectedId, cues: [], offsetSec };
        setExternals([...prev, { id, label: sourceLabel, cues }]);
        setSelectedId(id);
      }
      setOffsetSec(0);
      setCanUndoSyncedCues(true);
      return true;
    },
    [embedded, offsetSec, selectedId, setExternals],
  );

  /**
   * Put back what was there before the last apply.
   *
   * For a track that was embedded, "before" was the embedded track itself, so
   * undo re-selects it and drops the synced copy rather than restoring cues
   * into an entry that did not exist.
   */
  const undoSyncedCues = useCallback(() => {
    const snapshot = syncUndoRef.current;
    if (!snapshot) return;
    const prev = externalsRef.current;
    if (snapshot.cues.length > 0) {
      setExternals(
        prev.map((entry) => (entry.id === snapshot.id ? { ...entry, cues: snapshot.cues } : entry)),
      );
      setSelectedId(snapshot.id);
    } else {
      setExternals(prev.filter((entry) => entry.id !== selectedId));
      setSelectedId(snapshot.id);
    }
    setOffsetSec(snapshot.offsetSec);
    syncUndoRef.current = null;
    setCanUndoSyncedCues(false);
    setHint("Undone — the original subtitles are back.");
  }, [selectedId, setExternals]);

  /**
   * Find the longest set of cues belonging to a track OTHER than the selected
   * one, to align against.
   *
   * "Longest" rather than "first" follows ffsubsync, which picks the embedded
   * track with the largest time span: a forced-narrative track covering three
   * signs is technically a subtitle track and useless as a reference.
   *
   * In-band tracks sit at mode "disabled", where `cues` is null, so each
   * candidate is briefly moved to "hidden" — never "showing", which would put
   * a second set of lines on screen — and its previous mode restored. The wait
   * is bounded: an HLS rendition has to be fetched, and a track that never
   * produces cues must not hold the whole sync up.
   */
  const collectReferenceCues = useCallback(async (signal?: AbortSignal): Promise<SubtitleCue[]> => {
    let best: SubtitleCue[] = [];
    // A whole-scan budget on top of the per-track one. A video with six
    // subtitle renditions, none of which ever produce cues, would otherwise
    // hold the sync for eighteen seconds before it even starts.
    const deadline = Date.now() + 6000;
    const consider = (cues: SubtitleCue[]) => {
      if (cues.length === 0) return;
      const span = cues[cues.length - 1].end - cues[0].start;
      const bestSpan = best.length > 0 ? best[best.length - 1].end - best[0].start : -1;
      if (span > bestSpan) best = cues;
    };

    for (const entry of externalsRef.current) {
      if (entry.id !== selectedId) consider(entry.cues);
    }

    const video = videoRef.current;
    const list = video?.textTracks;
    if (list) {
      const selectedIndex = selectedId.startsWith("embedded:")
        ? Number(selectedId.slice("embedded:".length))
        : -1;
      for (let index = 0; index < list.length; index += 1) {
        const track = list[index];
        if (index === selectedIndex) continue;
        if (track.language === MANAGED_TRACK_LANGUAGE) continue;
        if (track.kind !== "subtitles" && track.kind !== "captions") continue;

        if (signal?.aborted) break;
        consider(await peekTrackCues(track, Math.max(0, Math.min(3000, deadline - Date.now())), signal));
      }
    }
    return best;
  }, [selectedId, videoRef]);

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
    // The undo snapshot belongs to the track it was taken from; offering it
    // after a switch would restore one track's cues onto another's entry.
    syncUndoRef.current = null;
    setCanUndoSyncedCues(false);
  }, []);

  const nudgeOffset = useCallback((deltaSec: number) => {
    setOffsetSec((prev) => Math.round((prev + deltaSec) * 10) / 10);
  }, []);

  const resetOffset = useCallback(() => setOffsetSec(0), []);

  const setOffset = useCallback((sec: number) => {
    setOffsetSec(Number.isFinite(sec) ? Math.round(sec * 10) / 10 : 0);
  }, []);

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
    setOffset,
    selectedCues:
      externals.find((entry) => entry.id === selectedId)?.cues ??
      (selectedId.startsWith("embedded:") ? embeddedCues : []),
    addFile,
    hint,
    hasSubtitles: embedded.length > 0 || externals.length > 0,
    applySyncedCues,
    undoSyncedCues,
    canUndoSyncedCues,
    collectReferenceCues,
  };
};
