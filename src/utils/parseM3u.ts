import { classifyPlaylistItem } from "./classifyPlaylistItem";
import { computeShareIdFromUrl } from "./shareId";
import type { ImportResult, PlaylistItem } from "../types/models";

interface ExtInfData {
  duration: number | null;
  displayName: string;
  attrs: Record<string, string>;
}

const normalizeAttrKey = (key: string): string => key.trim().toLowerCase().replace(/_/g, "-");

/**
 * Parse #EXTINF attribute block: supports quoted values and common unquoted `key=value` tokens
 * (many IPTV exports omit quotes). Keys are normalized to lowercase kebab-case.
 */
const parseAttributes = (raw: string): Record<string, string> => {
  const attrs: Record<string, string> = {};
  const body = raw.replace(/^-?\d+\s*/, "").trim();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i += 1;
    const keyStart = i;
    while (i < body.length && /[\w-]/.test(body[i])) i += 1;
    if (i <= keyStart) {
      i += 1;
      continue;
    }
    const key = normalizeAttrKey(body.slice(keyStart, i));
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (body[i] !== "=") continue;
    i += 1;
    while (i < body.length && /\s/.test(body[i])) i += 1;
    if (i >= body.length) break;
    if (body[i] === '"' || body[i] === "'") {
      const quote = body[i];
      i += 1;
      const valStart = i;
      while (i < body.length && body[i] !== quote) i += 1;
      attrs[key] = body.slice(valStart, i);
      if (body[i] === quote) i += 1;
    } else {
      const valStart = i;
      while (i < body.length && !/\s/.test(body[i])) i += 1;
      attrs[key] = body.slice(valStart, i);
    }
  }
  return attrs;
};

/**
 * Split #EXTINF payload into attribute chunk + display title (after last comma).
 * If there is no comma, attributes are the whole line and display title comes from tvg-name.
 */
const parseExtInf = (line: string): ExtInfData | null => {
  if (!line.startsWith("#EXTINF:")) return null;
  const value = line.replace("#EXTINF:", "");
  const commaIndex = value.lastIndexOf(",");
  let attrsChunk: string;
  let displayName: string;

  if (commaIndex < 0) {
    attrsChunk = value.trim();
    const attrs = parseAttributes(attrsChunk);
    const durationMatch = attrsChunk.match(/^(-?\d+)/);
    const duration = durationMatch ? Number(durationMatch[1]) : null;
    displayName = (attrs["tvg-name"] ?? attrs["tvg_name"] ?? "").trim() || "Untitled";
    return { duration, displayName, attrs };
  }

  attrsChunk = value.slice(0, commaIndex).trim();
  displayName = value.slice(commaIndex + 1).trim() || "Untitled";
  const durationMatch = attrsChunk.match(/^(-?\d+)/);
  const duration = durationMatch ? Number(durationMatch[1]) : null;
  const attrs = parseAttributes(attrsChunk);
  if (!displayName || displayName === "Untitled") {
    const fallback = (attrs["tvg-name"] ?? attrs["tvg_name"] ?? "").trim();
    if (fallback) displayName = fallback;
  }
  return { duration, displayName, attrs };
};

const makeId = (playlistId: string, streamUrl: string, index: number): string => {
  let hash = 0;
  for (let i = 0; i < streamUrl.length; i += 1) {
    hash = (hash << 5) - hash + streamUrl.charCodeAt(i);
    hash |= 0;
  }
  return `${playlistId}-${index}-${Math.abs(hash)}`;
};

const isLikelyM3u = (text: string): boolean => text.includes("#EXTM3U") || text.includes("#EXTINF:");

export const parseM3u = (playlistId: string, text: string): ImportResult => {
  const errors: string[] = [];
  if (!isLikelyM3u(text)) {
    return { items: [], errors: ["Input does not look like a valid M3U playlist."] };
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const items: PlaylistItem[] = [];
  let pending: ExtInfData | null = null;
  let pendingLine = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF:")) {
      pending = parseExtInf(line);
      pendingLine = i + 1;
      if (!pending) errors.push(`Malformed EXTINF line at ${i + 1}`);
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!pending) {
      errors.push(`Skipped URL without preceding EXTINF at line ${i + 1}`);
      continue;
    }
    const streamUrl = line;
    const displayName = pending.displayName;
    const tvgName = pending.attrs["tvg-name"];
    const tvgId = pending.attrs["tvg-id"];
    const groupTitle = pending.attrs["group-title"];
    const classified = classifyPlaylistItem({
      displayName,
      tvgName,
      tvgId,
      groupTitle,
      url: streamUrl,
      rawAttributes: pending.attrs,
    });
    const hasCatchup =
      Boolean(pending.attrs.catchup && pending.attrs.catchup !== "default") ||
      Boolean(pending.attrs["catchup-days"] || pending.attrs["catchup-source"]);
    items.push({
      id: makeId(playlistId, streamUrl, i),
      sourceId: playlistId,
      playlistId,
      displayName,
      title: displayName,
      url: streamUrl,
      streamUrl,
      kind: classified.kind,
      logo: pending.attrs["tvg-logo"],
      groupTitle,
      tvgName,
      tvgId,
      tvgChno: pending.attrs["tvg-chno"],
      xuiId: pending.attrs["xui-id"],
      shareId: computeShareIdFromUrl(streamUrl),
      catchup: pending.attrs.catchup,
      catchupDays: pending.attrs["catchup-days"],
      catchupSource: pending.attrs["catchup-source"],
      duration: pending.duration,
      section: hasCatchup ? "catchup" : classified.section,
      seriesTitle: classified.seriesTitle,
      season: classified.season,
      episode: classified.episode,
      episodeTitle: classified.seriesTitle ? displayName : undefined,
      rawAttributes: pending.attrs,
      metadata: pending.attrs,
    });
    pending = null;
    pendingLine = -1;
  }

  if (pending) errors.push(`Missing URL after EXTINF at line ${pendingLine}`);
  if (!items.length) errors.push("No playable entries were found in playlist.");
  return { items, errors };
};

interface ParseChunkedOptions {
  chunkSize?: number;
  onProgress?: (percent: number) => void;
}

const pause = async (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const parseM3uChunked = async (
  playlistId: string,
  text: string,
  options: ParseChunkedOptions = {},
): Promise<ImportResult> => {
  return parseM3uInternal(playlistId, text, options);
};

const parseM3uInternal = async (
  playlistId: string,
  text: string,
  options: ParseChunkedOptions = {},
): Promise<ImportResult> => {
  const errors: string[] = [];
  if (!isLikelyM3u(text)) {
    return { items: [], errors: ["Input does not look like a valid M3U playlist."] };
  }

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const totalLines = lines.length;
  if (totalLines === 0) return { items: [], errors: ["No playable entries were found in playlist."] };

  const chunkSize = Math.max(500, options.chunkSize ?? 4000);
  const items: PlaylistItem[] = [];

  options.onProgress?.(0);

  let pending: ExtInfData | null = null;
  let pendingLine = -1;

  for (let start = 0; start < totalLines; start += chunkSize) {
    const end = Math.min(start + chunkSize, totalLines);
    for (let i = start; i < end; i += 1) {
      const rawLine = lines[i];
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith("#EXTINF:")) {
        pending = parseExtInf(line);
        pendingLine = i + 1;
        if (!pending) errors.push(`Malformed EXTINF line at ${i + 1}`);
        continue;
      }
      if (line.startsWith("#")) {
        continue;
      }
      if (!pending) {
        errors.push(`Skipped URL without preceding EXTINF at line ${i + 1}`);
        continue;
      }

      const streamUrl = line;
      const displayName = pending.displayName;
      const tvgName = pending.attrs["tvg-name"];
      const tvgId = pending.attrs["tvg-id"];
      const groupTitle = pending.attrs["group-title"];
      const classified = classifyPlaylistItem({
        displayName,
        tvgName,
        tvgId,
        groupTitle,
        url: streamUrl,
        rawAttributes: pending.attrs,
      });

      const hasCatchup =
        Boolean(pending.attrs.catchup && pending.attrs.catchup !== "default") ||
        Boolean(pending.attrs["catchup-days"] || pending.attrs["catchup-source"]);

      items.push({
        id: makeId(playlistId, streamUrl, i),
        sourceId: playlistId,
        playlistId,
        displayName,
        title: displayName,
        url: streamUrl,
        streamUrl,
        kind: classified.kind,
        logo: pending.attrs["tvg-logo"],
        groupTitle,
        tvgName,
        tvgId,
        tvgChno: pending.attrs["tvg-chno"],
        xuiId: pending.attrs["xui-id"],
        shareId: computeShareIdFromUrl(streamUrl),
        catchup: pending.attrs.catchup,
        catchupDays: pending.attrs["catchup-days"],
        catchupSource: pending.attrs["catchup-source"],
        duration: pending.duration,
        section: hasCatchup ? "catchup" : classified.section,
        seriesTitle: classified.seriesTitle,
        season: classified.season,
        episode: classified.episode,
        episodeTitle: classified.seriesTitle ? displayName : undefined,
        rawAttributes: pending.attrs,
        metadata: pending.attrs,
      });
      pending = null;
      pendingLine = -1;
    }

    options.onProgress?.(Math.round((end / totalLines) * 100));
    if (end < totalLines) await pause();
  }

  if (pending) {
    errors.push(`Missing URL after EXTINF at line ${pendingLine}`);
  }

  if (!items.length) errors.push("No playable entries were found in playlist.");
  return { items, errors };
};
