/**
 * Cloudflare Worker port of api/stream.ts (the Vercel serverless relay).
 *
 * Same contract: the browser requests /api/stream?url=<upstream>, we fetch the
 * upstream edge-side with player headers and pipe the bytes back, so the
 * browser is not subject to the provider's CORS / mixed-content rules.
 *
 * The Vercel version uses the Node (req, res) + stream.pipe form because the
 * Web-style handler returned 500 there. Workers is Web-standard natively, so we
 * hand `upstream.body` straight to the Response and the runtime streams it.
 *
 * Deliberately NOT ported: /api/restream (ffmpeg). Workers cannot spawn native
 * binaries. Live TV routes to the local helper app on 127.0.0.1:11471 via
 * relayDiscovery.ts, exactly as it does on the Vercel deployment.
 */
import { applyIptvStreamHeaders, parseProxyTarget } from "../api/proxyShared";

/**
 * Upstream headers worth forwarding — range/seek support depends on these.
 *
 * Known gap vs the Vercel relay: if an origin gzips AND the client sends Range,
 * the body comes back empty. Those origins range over the *compressed* bytes,
 * and the Workers runtime decompresses before we ever see the response (by
 * which point `content-encoding` is already gone, so it cannot be passed
 * through). Unreachable for IPTV: providers serve .ts/.mp4 uncompressed, and
 * .m3u8 manifests are fetched without Range. Verified byte-identical to a
 * direct fetch for full, leading, and mid-file ranges on real media.
 */
const PASS_THROUGH = [
  "content-type",
  "content-length",
  "content-encoding",
  "accept-ranges",
  "content-range",
  "cache-control",
] as const;

const corsHeaders = (): Headers => {
  const headers = new Headers();
  headers.set("access-control-allow-origin", "*");
  return headers;
};

const fail = (status: number, message: string): Response =>
  new Response(message, { status, headers: corsHeaders() });

const preflight = (): Response => {
  const headers = corsHeaders();
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS");
  headers.set("access-control-allow-headers", "range, accept");
  headers.set("access-control-max-age", "86400");
  return new Response(null, { status: 204, headers });
};

const relay = async (request: Request): Promise<Response> => {
  const result = parseProxyTarget(new URL(request.url).searchParams.get("url"));
  if (!result.ok) return fail(result.status, result.message);
  const { target } = result;

  const upstreamHeaders = new Headers();
  const range = request.headers.get("range");
  const accept = request.headers.get("accept");
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
      // Default-enabled since compatibility_date 2024-11-11.
      cache: "no-store",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "fetch failed";
    return fail(502, `Relay could not reach the provider: ${reason}`);
  }

  const headers = corsHeaders();
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
};

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Force HTTPS. Provider credentials ride inside /api/stream?url=<...>
    // (Xtream URLs embed username/password), so a plaintext hop would leak
    // them. The zone-level "Always Use HTTPS" toggle would do this one hop
    // earlier and for free — this is the belt-and-braces version.
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }

    const { pathname } = url;

    // Only /api/* reaches the Worker (see run_worker_first in wrangler.jsonc);
    // everything else is served straight from the asset store, with unmatched
    // paths falling back to index.html for React Router.
    if (pathname === "/api/stream") {
      if (request.method === "OPTIONS") return preflight();
      if (request.method !== "GET" && request.method !== "HEAD") {
        return fail(405, "Method not allowed");
      }
      return relay(request);
    }

    // /api/restream is intentionally absent — ffmpeg cannot run here. Live TV
    // routes to the local helper on 127.0.0.1:11471 via relayDiscovery.ts.
    if (pathname.startsWith("/api/")) return fail(404, "Not found");

    return env.ASSETS.fetch(request);
  },
};
