import test from "node:test";
import assert from "node:assert/strict";
import {
  LOCAL_PLAYLIST_ID,
  buildLocalVideoItem,
  fileExtension,
  formatFileSize,
  guessVideoMime,
  isLocalItem,
  isSubtitleFile,
  isVideoFile,
  titleFromFileName,
} from "./localMedia.ts";

test("fileExtension", async (t) => {
  await t.test("lowercases and ignores the path", () => {
    assert.equal(fileExtension("Movie.MKV"), "mkv");
    assert.equal(fileExtension("a.b.c.mp4"), "mp4");
  });

  await t.test("is empty when there is no extension", () => {
    assert.equal(fileExtension("README"), "");
    assert.equal(fileExtension(".hidden"), "hidden");
  });
});

test("isVideoFile", async (t) => {
  await t.test("accepts an extension even with no MIME type", () => {
    // Dropped .mkv/.avi routinely arrive with type: "".
    assert.equal(isVideoFile({ name: "show.mkv", type: "" }), true);
    assert.equal(isVideoFile({ name: "clip.AVI", type: "" }), true);
  });

  await t.test("accepts a video MIME even with an unknown extension", () => {
    assert.equal(isVideoFile({ name: "stream", type: "video/mp4" }), true);
  });

  await t.test("rejects non-video files", () => {
    assert.equal(isVideoFile({ name: "notes.txt", type: "text/plain" }), false);
    assert.equal(isVideoFile({ name: "subs.srt", type: "" }), false);
  });
});

test("isSubtitleFile", async (t) => {
  await t.test("matches the subtitle extensions", () => {
    for (const name of ["a.srt", "a.vtt", "a.ass", "a.SSA"]) {
      assert.equal(isSubtitleFile({ name, type: "" }), true, name);
    }
  });

  await t.test("matches text/vtt without an extension", () => {
    assert.equal(isSubtitleFile({ name: "captions", type: "text/vtt" }), true);
  });

  await t.test("does not claim videos", () => {
    assert.equal(isSubtitleFile({ name: "movie.mp4", type: "video/mp4" }), false);
  });
});

test("guessVideoMime", async (t) => {
  await t.test("prefers the file's own type", () => {
    assert.equal(guessVideoMime({ name: "x.mkv", type: "video/webm" }), "video/webm");
  });

  await t.test("falls back to the extension", () => {
    assert.equal(guessVideoMime({ name: "x.mkv", type: "" }), "video/x-matroska");
    assert.equal(guessVideoMime({ name: "x.mov", type: "" }), "video/quicktime");
  });

  await t.test("is empty when nothing is known", () => {
    assert.equal(guessVideoMime({ name: "x.qqq", type: "" }), "");
  });
});

test("formatFileSize", async (t) => {
  await t.test("scales through the units", () => {
    assert.equal(formatFileSize(512), "512 B");
    assert.equal(formatFileSize(1024), "1.0 KB");
    assert.equal(formatFileSize(1024 * 1024 * 1.5), "1.5 MB");
    assert.equal(formatFileSize(1024 ** 3 * 12), "12 GB");
  });

  await t.test("drops the decimal at 10 and above", () => {
    assert.equal(formatFileSize(1024 * 10), "10 KB");
    assert.equal(formatFileSize(1024 * 9.9), "9.9 KB");
  });

  await t.test("is empty for nonsense input", () => {
    assert.equal(formatFileSize(Number.NaN), "");
    assert.equal(formatFileSize(-1), "");
  });
});

test("titleFromFileName", async (t) => {
  await t.test("drops the extension", () => {
    assert.equal(titleFromFileName("The Movie (2019).mkv"), "The Movie (2019)");
  });

  await t.test("keeps a dotfile name intact", () => {
    assert.equal(titleFromFileName(".mkv"), ".mkv");
  });

  await t.test("falls back to the raw name when the base is blank", () => {
    assert.equal(titleFromFileName("   .mp4"), "   .mp4");
  });
});

test("buildLocalVideoItem", async (t) => {
  const file = { name: "Sample.mkv", size: 1024 * 1024 * 700, type: "", lastModified: 1700000000000 };
  const item = buildLocalVideoItem(file, "blob:http://localhost/abc");

  await t.test("lands in the local playlist so persistence skips it", () => {
    assert.equal(item.playlistId, LOCAL_PLAYLIST_ID);
    assert.equal(isLocalItem(item), true);
    assert.equal(isLocalItem({ playlistId: "real" }), false);
    assert.equal(isLocalItem(null), false);
  });

  await t.test("plays from the blob URL", () => {
    assert.equal(item.streamUrl, "blob:http://localhost/abc");
    assert.equal(item.url, "blob:http://localhost/abc");
  });

  await t.test("shows the file's own details instead of playlist data", () => {
    assert.equal(item.title, "Sample");
    assert.deepEqual(item.metadata, {
      file: "Sample.mkv",
      size: "700 MB",
      format: "video/x-matroska",
    });
  });

  await t.test("ids are stable per file but distinct across files", () => {
    assert.equal(buildLocalVideoItem(file, "blob:other").id, item.id);
    assert.notEqual(buildLocalVideoItem({ ...file, size: 5 }, "blob:x").id, item.id);
  });

  await t.test("omits format when the type cannot be guessed", () => {
    const odd = buildLocalVideoItem({ name: "clip.qqq", size: 10, type: "", lastModified: 1 }, "blob:x");
    assert.equal("format" in odd.metadata, false);
  });
});
