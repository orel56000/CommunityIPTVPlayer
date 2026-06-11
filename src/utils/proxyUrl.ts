const API_PROXY_PATH = "/api/proxy";

const isProxyUrl = (value: string): boolean => value.startsWith(`${API_PROXY_PATH}?`);

export const toProxyUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (isProxyUrl(trimmed)) return trimmed;
  return `${API_PROXY_PATH}?url=${encodeURIComponent(trimmed)}`;
};

export const proxifyRemoteAssetUrl = (url?: string | null): string | undefined => {
  const trimmed = url?.trim();
  if (!trimmed) return undefined;
  if (/^(data|blob):/i.test(trimmed)) return trimmed;
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  return toProxyUrl(trimmed);
};
