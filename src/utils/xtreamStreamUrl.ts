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

/** Backend ffmpeg restream — serves browser-playable HLS from an Xtream `.ts` source. */
export const buildRestreamManifestUrl = (tsUrl: string): string =>
  `/api/restream/index.m3u8?url=${encodeURIComponent(tsUrl)}`;

export type LivePlaybackAttempt = {
  url: string;
  label: "direct-hls" | "restream-hls";
};

export const buildLivePlaybackAttempts = (streamUrl: string): LivePlaybackAttempt[] => {
  const attempts: LivePlaybackAttempt[] = [];
  const m3u8Url = toXtreamM3u8Url(streamUrl);
  const tsUrl = toXtreamTsUrl(streamUrl);
  if (m3u8Url) attempts.push({ url: m3u8Url, label: "direct-hls" });
  if (tsUrl) attempts.push({ url: buildRestreamManifestUrl(tsUrl), label: "restream-hls" });
  return attempts;
};
