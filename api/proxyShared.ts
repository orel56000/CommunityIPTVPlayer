export const IPTV_STREAM_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 ExoPlayerLib/2.18.1";

/** Headers that make IPTV providers serve the real stream (not a browser/debug page). */
export const applyIptvStreamHeaders = (headers: Headers, target: URL): void => {
  headers.set("user-agent", IPTV_STREAM_USER_AGENT);
  headers.set("accept", "*/*");
  if (!headers.has("referer")) {
    headers.set("referer", `${target.protocol}//${target.host}/`);
  }
};

export const isBlockedHost = (hostname: string): boolean => {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (host.startsWith("fc") || host.startsWith("fd")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
  }
  return false;
};

export const parseProxyTarget = (
  rawTarget: string | null,
): { ok: true; target: URL } | { ok: false; status: number; message: string } => {
  if (!rawTarget) {
    return { ok: false, status: 400, message: "Missing url query parameter" };
  }

  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    return { ok: false, status: 400, message: "Invalid target url" };
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    return { ok: false, status: 400, message: "Unsupported target protocol" };
  }

  if (isBlockedHost(target.hostname)) {
    return { ok: false, status: 403, message: "Target host is blocked" };
  }

  return { ok: true, target };
};
