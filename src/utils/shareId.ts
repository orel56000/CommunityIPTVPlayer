import type { PlaylistItem } from "../types/models";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const CODE_LENGTH = 8;

/**
 * Deterministic 64-bit FNV-1a variant -> base36 code.
 * Stable across imports for the same stream URL, so users can share the ID and
 * a friend pasting it into search will land on the same row.
 */
const hashToBase36 = (input: string, length = CODE_LENGTH): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ ((code + i) | 0), 0x85ebca6b);
  }
  let a = (h1 >>> 0) >>> 0;
  let b = (h2 >>> 0) >>> 0;
  let out = "";
  while (out.length < length) {
    const n = (a + b) >>> 0;
    out += ALPHABET[n % 36];
    a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) >>> 0;
    b = Math.imul(b ^ (b >>> 17), 0xc2b2ae35) >>> 0;
  }
  return out;
};

export const computeShareIdFromUrl = (streamUrl: string): string => hashToBase36(streamUrl.trim().toLowerCase());

/**
 * Read or lazily compute a stable 8-character share code for a playlist item.
 * Items saved before this feature won't have `shareId` stored, so we derive it from
 * the stream URL on demand.
 */
export const getShareId = (item: Pick<PlaylistItem, "shareId" | "streamUrl" | "url">): string => {
  if (item.shareId) return item.shareId;
  return computeShareIdFromUrl(item.streamUrl || item.url || "");
};
