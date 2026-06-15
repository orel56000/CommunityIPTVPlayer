import type { IncomingMessage, ServerResponse } from "node:http";
import { parseProxyTarget } from "./proxyShared.js";
import {
  getOrStartRestreamSession,
  invalidateRestreamSession,
  readRestreamManifest,
  readRestreamSegment,
  rewriteRestreamManifest,
  touchRestreamSession,
} from "./restreamManager.js";

const loadRestreamManifest = async (sourceUrl: string): Promise<{ sessionId: string; manifest: string }> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const session = await getOrStartRestreamSession(sourceUrl, attempt > 0);
      const manifest = await readRestreamManifest(session);
      return { sessionId: session.id, manifest: rewriteRestreamManifest(manifest, session.id) };
    } catch (error) {
      lastError = error;
      await invalidateRestreamSession(sourceUrl);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Restream manifest failed");
};

const sendText = (res: ServerResponse, status: number, body: string, contentType: string): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
};

const sendBuffer = (res: ServerResponse, status: number, body: Buffer, contentType: string): void => {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
};

const parseRestreamPath = (pathname: string): string[] => {
  const normalized = pathname.replace(/^\/api\/restream\/?/, "/").replace(/^\/+/, "");
  return normalized ? normalized.split("/").filter(Boolean) : [];
};

const isRestreamRequest = (pathname: string): boolean => {
  const parts = parseRestreamPath(pathname);
  if (parts.length === 1 && parts[0] === "index.m3u8") return true;
  if (parts.length === 2 && /\.ts$/i.test(parts[1])) return true;
  return false;
};

export const handleRestreamNodeRequest = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
  if (!req.url || req.method !== "GET") return false;
  const requestUrl = new URL(req.url, "http://localhost");
  if (!isRestreamRequest(requestUrl.pathname)) return false;

  const parts = parseRestreamPath(requestUrl.pathname);

  try {
    if (parts.length === 1 && parts[0] === "index.m3u8") {
      const sourceParam = requestUrl.searchParams.get("url");
      const result = parseProxyTarget(sourceParam);
      if (!result.ok) {
        sendText(res, result.status, result.message, "text/plain; charset=utf-8");
        return true;
      }
      if (!/\.ts(\?|$)/i.test(result.target.pathname)) {
        sendText(res, 400, "Restream source must be an Xtream MPEG-TS (.ts) URL", "text/plain; charset=utf-8");
        return true;
      }

      const { manifest } = await loadRestreamManifest(result.target.toString());
      sendText(res, 200, manifest, "application/vnd.apple.mpegurl");
      return true;
    }

    if (parts.length === 2) {
      const [sessionId, fileName] = parts;
      const session = touchRestreamSession(sessionId);
      if (!session) {
        sendText(res, 404, "Restream session not found or expired", "text/plain; charset=utf-8");
        return true;
      }
      const segment = await readRestreamSegment(session, fileName);
      sendBuffer(res, 200, segment, "video/mp2t");
      return true;
    }

    sendText(res, 404, "Unknown restream route", "text/plain; charset=utf-8");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restream failed";
    console.error("[IPTV][Restream] Request failed", { path: requestUrl.pathname, message });
    sendText(res, 502, message, "text/plain; charset=utf-8");
    return true;
  }
};

export const handleRestreamWebRequest = async (request: Request): Promise<Response | null> => {
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || !isRestreamRequest(requestUrl.pathname)) return null;

  const parts = parseRestreamPath(requestUrl.pathname);
  const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

  try {
    if (parts.length === 1 && parts[0] === "index.m3u8") {
      const sourceParam = requestUrl.searchParams.get("url");
      const result = parseProxyTarget(sourceParam);
      if (!result.ok) {
        return new Response(result.message, { status: result.status, headers });
      }
      if (!/\.ts(\?|$)/i.test(result.target.pathname)) {
        return new Response("Restream source must be an Xtream MPEG-TS (.ts) URL", { status: 400, headers });
      }

      const { manifest } = await loadRestreamManifest(result.target.toString());
      return new Response(manifest, {
        status: 200,
        headers: { ...headers, "Content-Type": "application/vnd.apple.mpegurl" },
      });
    }

    if (parts.length === 2) {
      const [sessionId, fileName] = parts;
      const session = touchRestreamSession(sessionId);
      if (!session) {
        return new Response("Restream session not found or expired", { status: 404, headers });
      }
      const segment = await readRestreamSegment(session, fileName);
      return new Response(new Uint8Array(segment), {
        status: 200,
        headers: { ...headers, "Content-Type": "video/mp2t", "Content-Length": String(segment.length) },
      });
    }

    return new Response("Unknown restream route", { status: 404, headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restream failed";
    console.error("[IPTV][Restream] Request failed", { path: requestUrl.pathname, message });
    return new Response(message, { status: 502, headers });
  }
};
