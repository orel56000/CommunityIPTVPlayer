/**
 * Unit tests for credential redaction.
 *
 * Security-critical: debug mode POSTs every fetched URL into a log buffer, and
 * Xtream URLs carry the subscriber's username/password. Anything that escapes
 * redaction here ends up in that log verbatim.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactUrl } from "./redactUrl.ts";

describe("redactUrl", () => {
  it("redacts username/password query params", () => {
    const out = redactUrl("http://provider.tv/player_api.php?username=alice&password=hunter2&action=get_series");
    assert.ok(!out.includes("alice"), out);
    assert.ok(!out.includes("hunter2"), out);
    assert.ok(out.includes("username=***"), out);
    assert.ok(out.includes("password=***"), out);
    // Non-sensitive params survive, so the log stays useful.
    assert.ok(out.includes("action=get_series"), out);
  });

  it("redacts credentials nested inside a relay /api/stream?url= wrapper", () => {
    const provider = "http://provider.tv/live/alice/hunter2/6935.ts";
    const out = redactUrl(`/api/stream?url=${encodeURIComponent(provider)}`);
    assert.ok(!out.includes("alice"), out);
    assert.ok(!out.includes("hunter2"), out);
    assert.ok(out.includes("%2F***%2F***%2F") || out.includes("/***/***/"), out);
  });

  it("redacts credentials carried as /live/<user>/<pass>/ path segments", () => {
    const out = redactUrl("http://provider.tv/live/alice/hunter2/6935.ts");
    assert.equal(out, "http://provider.tv/live/***/***/6935.ts");
  });

  it("redacts movie and series path shapes too", () => {
    assert.equal(redactUrl("http://p.tv/movie/u/p/1.mkv"), "http://p.tv/movie/***/***/1.mkv");
    assert.equal(redactUrl("http://p.tv/series/u/p/2.mp4"), "http://p.tv/series/***/***/2.mp4");
  });

  it("is case-insensitive on param names", () => {
    const out = redactUrl("http://p.tv/api?USERNAME=alice&PassWord=hunter2");
    assert.ok(!out.includes("alice"), out);
    assert.ok(!out.includes("hunter2"), out);
  });

  it("keeps relative URLs relative", () => {
    assert.equal(redactUrl("/api/server-info"), "/api/server-info");
    assert.equal(redactUrl("/api/backup"), "/api/backup");
  });

  it("leaves a credential-free URL untouched in substance", () => {
    const out = redactUrl("http://127.0.0.1:11471/health");
    assert.equal(out, "http://127.0.0.1:11471/health");
  });

  it("does not mangle a path that merely starts with a similar word", () => {
    // Only the 3-segment /live/<a>/<b>/ shape is credential-shaped.
    assert.equal(redactUrl("http://p.tv/livestream.m3u8"), "http://p.tv/livestream.m3u8");
  });

  it("returns a placeholder rather than echoing an unparseable input", () => {
    assert.equal(redactUrl("http://[::bad::url]/x"), "<unparseable url>");
  });

  it("stops recursing at the depth limit instead of looping forever", () => {
    // Deeply nested wrappers must still terminate and must not leak at any level.
    const inner = "http://p.tv/player_api.php?username=alice&password=hunter2";
    const mid = `http://relay/api/stream?url=${encodeURIComponent(inner)}`;
    const outer = `http://relay/api/stream?url=${encodeURIComponent(mid)}`;
    const out = redactUrl(outer);
    assert.ok(!out.includes("alice"), out);
    assert.ok(!out.includes("hunter2"), out);
  });
});
