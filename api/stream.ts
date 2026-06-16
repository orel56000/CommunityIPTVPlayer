import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { applyIptvStreamHeaders, parseProxyTarget } from "./proxyShared.js";

// Same-origin relay: the browser requests /api/stream?url=<upstream>; this
// fetches the upstream server-side (player User-Agent, follows redirects) and
// pipes the bytes back, removing the browser's CORS / mixed-content limits.
//
// Uses the classic Node (req, res) handler + stream.pipe — the most reliable
// form on Vercel's Node runtime for streaming/large responses. (The Web-style
// Request->Response handler returned 500 here.)
//
// NOTE: works for finite content (VOD with range requests). A never-ending
// live .ts will hit maxDuration; live uses the ffmpeg restream instead.
export const config = {
  maxDuration: 60,
};

const firstHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const copyHeader = (from: Headers, res: ServerResponse, name: string): void => {
  const value = from.get(name);
  if (value) res.setHeader(name, value);
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reqUrl = new URL(req.url ?? "", "http://localhost");
  const result = parseProxyTarget(reqUrl.searchParams.get("url"));
  if (!result.ok) {
    res.statusCode = result.status;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(result.message);
    return;
  }
  const { target } = result;

  const upstreamHeaders = new Headers();
  const range = firstHeader(req.headers.range);
  const accept = firstHeader(req.headers.accept);
  if (range) upstreamHeaders.set("range", range);
  if (accept) upstreamHeaders.set("accept", accept);
  upstreamHeaders.set("referer", `${target.protocol}//${target.host}/`);
  applyIptvStreamHeaders(upstreamHeaders, target);

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
      cache: "no-store",
    });
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(`Relay could not reach the provider: ${error instanceof Error ? error.message : "fetch failed"}`);
    return;
  }

  res.statusCode = upstream.status;
  copyHeader(upstream.headers, res, "content-type");
  copyHeader(upstream.headers, res, "content-length");
  copyHeader(upstream.headers, res, "accept-ranges");
  copyHeader(upstream.headers, res, "content-range");
  copyHeader(upstream.headers, res, "cache-control");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!upstream.body) {
    res.end();
    return;
  }

  const nodeStream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
  nodeStream.on("error", () => {
    if (!res.headersSent) res.statusCode = 502;
    res.end();
  });
  req.on("close", () => nodeStream.destroy());
  nodeStream.pipe(res);
}
