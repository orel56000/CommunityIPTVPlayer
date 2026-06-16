import { applyIptvStreamHeaders, parseProxyTarget } from "./proxyShared.js";

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

  const upstream = await fetch(target.toString(), {
    method: "GET",
    headers: upstreamRequestHeaders,
    redirect: "follow",
    cache: "no-store",
  });

  const responseHeaders = new Headers();
  copyHeader(upstream.headers, responseHeaders, "content-type");
  copyHeader(upstream.headers, responseHeaders, "content-length");
  copyHeader(upstream.headers, responseHeaders, "accept-ranges");
  copyHeader(upstream.headers, responseHeaders, "content-range");
  copyHeader(upstream.headers, responseHeaders, "cache-control");
  copyHeader(upstream.headers, responseHeaders, "expires");
  copyHeader(upstream.headers, responseHeaders, "etag");
  copyHeader(upstream.headers, responseHeaders, "last-modified");
  responseHeaders.set("Access-Control-Allow-Origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
