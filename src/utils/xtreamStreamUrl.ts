import { getRelayBase } from "./secureUrl";

/** Build Xtream live MPEG-TS URL from any live stream URL variant. */
export const toXtreamTsUrl = (streamUrl: string): string | null => {
  if (/\.ts(\?|$)/i.test(streamUrl)) return streamUrl;
  if (/\.m3u8(\?|$)/i.test(streamUrl)) return streamUrl.replace(/\.m3u8(\?|$)/i, ".ts$1");
  return null;
};

/** Build Xtream live HLS URL from any live stream URL variant. */
export const toXtreamM3u8Url = (streamUrl: string): string | null => {
  if (/\.m3u8(\?|$)/i.test(streamUrl)) return streamUrl;
  if (/\.ts(\?|$)/i.test(streamUrl)) return streamUrl.replace(/\.ts(\?|$)/i, ".m3u8$1");
  return null;
};

export const buildXtreamLiveTsUrl = (
  host: string,
  username: string,
  password: string,
  streamId: string,
): string => {
  const base = host.replace(/\/+$/, "");
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${encodeURIComponent(streamId)}.ts`;
};

/** Server-side ffmpeg restream: serves browser-playable HLS remuxed from an Xtream `.ts` source. */
export const buildRestreamManifestUrl = (tsUrl: string): string =>
  `${getRelayBase()}/api/restream/index.m3u8?url=${encodeURIComponent(tsUrl)}`;

export type LivePlaybackAttempt = {
  url: string;
  label: "direct-ts" | "restream-hls";
  engine: "mpegts" | "hls";
};

/**
 * Live playback attempts, in priority order:
 *   1. restream-hls - ffmpeg pulls the .ts (player headers) and remuxes to HLS,
 *      played by hls.js. This is the reliable path for providers that gate or
 *      send non-browser-decodable codecs (it normalizes to H.264/AAC).
 *   2. direct-ts - the raw .ts via the byte relay + mpegts.js (lighter, works
 *      only when the stream is already browser-decodable).
 */
export const buildLivePlaybackAttempts = (streamUrl: string): LivePlaybackAttempt[] => {
  const tsUrl = toXtreamTsUrl(streamUrl);
  if (!tsUrl) return [];
  return [
    { url: buildRestreamManifestUrl(tsUrl), label: "restream-hls", engine: "hls" },
    { url: tsUrl, label: "direct-ts", engine: "mpegts" },
  ];
};
