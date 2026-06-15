const API_PROXY_PATH = "/api/proxy";
const API_STREAM_PATH = "/api/stream";

const isProxyUrl = (value: string): boolean => value.startsWith(`${API_PROXY_PATH}?`);

const isStreamProxyUrl = (value: string): boolean => value.startsWith(`${API_STREAM_PATH}?`);

const isSameOriginPath = (value: string): boolean => value.startsWith("/") && !value.startsWith("//");

export const toProxyUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (isProxyUrl(trimmed)) return trimmed;
  return `${API_PROXY_PATH}?url=${encodeURIComponent(trimmed)}`;
};

export const toStreamProxyUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (isStreamProxyUrl(trimmed) || isProxyUrl(trimmed) || isSameOriginPath(trimmed)) return trimmed;
  return `${API_STREAM_PATH}?url=${encodeURIComponent(trimmed)}`;
};

/** True when the browser cannot reliably play/fetch the remote URL directly (CORS, mixed content). */
export const needsStreamProxy = (url: string): boolean => {
  if (typeof window === "undefined") return false;
  const trimmed = url.trim();
  if (!trimmed || isStreamProxyUrl(trimmed) || isProxyUrl(trimmed) || isSameOriginPath(trimmed)) {
    return false;
  }
  try {
    const target = new URL(trimmed);
    return target.origin !== window.location.origin;
  } catch {
    return false;
  }
};

export const resolveStreamPlaybackUrl = (url: string): string =>
  needsStreamProxy(url) ? toStreamProxyUrl(url) : url;

export const proxifyRemoteAssetUrl = (url?: string | null): string | undefined => {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  if (/^(data|blob):/i.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  return toProxyUrl(trimmed);
};
