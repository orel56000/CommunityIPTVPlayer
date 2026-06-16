import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { applyIptvStreamHeaders, parseProxyTarget } from "./api/proxyShared";

const copyHeader = (
  source: Headers,
  target: import("node:http").OutgoingHttpHeaders,
  name: string,
): void => {
  const value = source.get(name);
  if (value) target[name] = value;
};

// Dev-server equivalents of the serverless endpoints. On localhost the upstream
// sees YOUR residential IP, which is what makes IP-locked providers work here.
export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-stream-server",
      configureServer(server) {
        // ffmpeg restream: pulls the .ts with player headers and remuxes it into
        // browser-playable HLS (api/restream/[...path].ts on Vercel).
        server.middlewares.use("/api/restream", async (req, res) => {
          const { handleRestreamNodeRequest } = await import("./api/restreamHandler");
          const handled = await handleRestreamNodeRequest(req, res);
          if (!handled && !res.headersSent) {
            res.statusCode = 404;
            res.end("Not found");
          }
        });

        // Raw byte relay (api/stream.ts on Vercel) - used for VOD / direct play.
        server.middlewares.use("/api/stream", async (req, res) => {
          try {
            const reqUrl = new URL(req.url ?? "", "http://localhost");
            const result = parseProxyTarget(reqUrl.searchParams.get("url"));
            if (!result.ok) {
              res.statusCode = result.status;
              res.end(result.message);
              return;
            }
            const { target } = result;

            const upstreamHeaders = new Headers();
            if (req.headers.range) upstreamHeaders.set("range", req.headers.range);
            if (req.headers.accept) upstreamHeaders.set("accept", req.headers.accept);
            upstreamHeaders.set("referer", `${target.protocol}//${target.host}/`);
            applyIptvStreamHeaders(upstreamHeaders, target);

            const upstream = await fetch(target.toString(), {
              method: "GET",
              headers: upstreamHeaders,
              redirect: "follow",
              cache: "no-store",
            });

            res.statusCode = upstream.status;
            const responseHeaders: import("node:http").OutgoingHttpHeaders = {
              "access-control-allow-origin": "*",
            };
            copyHeader(upstream.headers, responseHeaders, "content-type");
            copyHeader(upstream.headers, responseHeaders, "content-length");
            copyHeader(upstream.headers, responseHeaders, "accept-ranges");
            copyHeader(upstream.headers, responseHeaders, "content-range");
            copyHeader(upstream.headers, responseHeaders, "cache-control");
            res.writeHead(res.statusCode, responseHeaders);

            if (!upstream.body) {
              res.end();
              return;
            }

            const stream = Readable.fromWeb(upstream.body as WebReadableStream<Uint8Array>);
            stream.on("error", () => {
              if (!res.headersSent) res.writeHead(502);
              res.end();
            });
            req.on("close", () => stream.destroy());
            stream.pipe(res);
          } catch {
            if (!res.headersSent) res.writeHead(502);
            res.end("Relay request failed");
          }
        });
      },
    },
  ],
});
