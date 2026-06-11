import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { parseProxyTarget } from "./api/proxyShared";

const copyHeader = (source: Headers, target: import("node:http").OutgoingHttpHeaders, name: string): void => {
  const value = source.get(name);
  if (value) target[name] = value;
};

export default defineConfig({
  plugins: [
    react(),
    {
      name: "local-stream-proxy",
      configureServer(server) {
        server.middlewares.use("/api/proxy", async (req, res) => {
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
            if (req.headers.accept) upstreamHeaders.set("accept", req.headers.accept);
            if (req.headers["accept-language"]) upstreamHeaders.set("accept-language", req.headers["accept-language"]);
            upstreamHeaders.set("referer", `${target.protocol}//${target.host}/`);

            const upstream = await fetch(target.toString(), {
              method: "GET",
              headers: upstreamHeaders,
              redirect: "follow",
              cache: "no-store",
            });

            res.statusCode = upstream.status;
            const responseHeaders: import("node:http").OutgoingHttpHeaders = {
              "access-control-allow-origin": "*",
              "cross-origin-resource-policy": "cross-origin",
            };
            copyHeader(upstream.headers, responseHeaders, "content-type");
            copyHeader(upstream.headers, responseHeaders, "content-length");
            copyHeader(upstream.headers, responseHeaders, "cache-control");
            copyHeader(upstream.headers, responseHeaders, "etag");
            copyHeader(upstream.headers, responseHeaders, "last-modified");
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
            if (!res.headersSent) res.writeHead(500);
            res.end("Proxy request failed");
          }
        });

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
            copyHeader(upstream.headers, responseHeaders, "etag");
            copyHeader(upstream.headers, responseHeaders, "last-modified");
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
            if (!res.headersSent) res.writeHead(500);
            res.end("Proxy request failed");
          }
        });
      },
    },
  ],
});
