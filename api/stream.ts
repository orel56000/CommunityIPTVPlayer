import { applyIptvStreamHeaders, parseProxyTarget } from "./proxyShared.js";

// Same-origin relay: the browser requests /api/stream?url=<upstream>, this
// function fetches the upstream stream server-side (player User-Agent, follows
// redirects) and pipes the bytes back. That removes the browser's CORS / mixed
// content limits. NOTE: on a cloud host the upstream sees THIS server's IP, so
// providers that lock to a residential IP will reject it (works from localhost).
export const config = {
  runtime: "nodejs",
  maxDuration: 60,
};

const copyHeader = (from: Headers, to: Headers, name: string): void => {
  const value = from.get(name);
  if (value) to.set(name, value);
};

export default async function handler(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const result = parseProxyTarget(requestUrl.searchParams.get("url"));
  if (!result.ok) {
    return new Response(result.message, { status: result.status });
  }
  const { target } = result;

  const upstreamRequestHeaders = new Headers();
  copyHeader(request.headers, upstreamRequestHeaders, "range");
  copyHeader(request.headers, upstreamRequestHeaders, "accept");
  upstreamRequestHeaders.set("referer", `${target.protocol}//${target.host}/`);
  applyIptvStreamHeaders(upstreamRequestHeaders, target);

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers: upstreamRequestHeaders,
      redirect: "follow",
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upstream fetch failed";
    return new Response(`Relay could not reach the provider: ${message}`, {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const responseHeaders = new Headers();
  copyHeader(upstream.headers, responseHeaders, "content-type");
  copyHeader(upstream.headers, responseHeaders, "content-length");
  copyHeader(upstream.headers, responseHeaders, "accept-ranges");
  copyHeader(upstream.headers, responseHeaders, "content-range");
  copyHeader(upstream.headers, responseHeaders, "cache-control");
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
