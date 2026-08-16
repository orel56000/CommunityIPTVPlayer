/**
 * Unit tests for subtitle parsing. These files come from strangers on the
 * internet, so the parser has to survive BOM headers, CRLF, reversed
 * timings, wrong extensions and ASS override tags without throwing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectSubtitleFormat,
  formatOffset,
  parseSubtitles,
  parseTimecode,
  shiftCues,
  type SubtitleCue,
} from "./subtitles.ts";

describe("parseTimecode", () => {
  it("reads SRT comma milliseconds and VTT dot milliseconds alike", () => {
    assert.equal(parseTimecode("00:00:01,500"), 1.5);
    assert.equal(parseTimecode("00:00:01.500"), 1.5);
    assert.equal(parseTimecode("01:02:03,250"), 3723.25);
  });

  it("accepts VTT's optional hours", () => {
    assert.equal(parseTimecode("02:03.500"), 123.5);
  });

  it("treats ASS two-digit fractions as CENTIseconds, not milliseconds", () => {
    // 0:00:01.50 is one and a HALF seconds. Reading it as 50ms would drift
    // every subtitle in an ASS file by up to ~1s.
    assert.equal(parseTimecode("0:00:01.50"), 1.5);
    assert.equal(parseTimecode("0:00:01.05"), 1.05);
  });

  it("rejects junk instead of returning NaN", () => {
    for (const bad of ["", "abc", "1:2:3:4", "--:--:--"]) {
      assert.equal(parseTimecode(bad), null, bad);
    }
  });
});

describe("parseSubtitles — SRT", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:04,000",
    "Hello world",
    "",
    "2",
    "00:00:05,500 --> 00:00:07,000",
    "Second line",
    "and a third",
  ].join("\n");

  it("parses indexed blocks with multi-line text", () => {
    const cues = parseSubtitles(srt, "movie.srt");
    assert.equal(cues.length, 2);
    assert.deepEqual(cues[0], { start: 1, end: 4, text: "Hello world" });
    assert.equal(cues[1].text, "Second line\nand a third");
  });

  it("survives a BOM and CRLF line endings", () => {
    const cues = parseSubtitles("﻿" + srt.replace(/\n/g, "\r\n"));
    assert.equal(cues.length, 2);
    assert.equal(cues[0].text, "Hello world");
  });

  it("gives reversed or zero-length timings a usable duration", () => {
    const cues = parseSubtitles("1\n00:00:10,000 --> 00:00:05,000\nBroken timing");
    assert.equal(cues.length, 1);
    assert.ok(cues[0].end > cues[0].start, "must still be showable");
  });

  it("drops blocks with no text rather than emitting empty cues", () => {
    const cues = parseSubtitles("1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nReal");
    assert.equal(cues.length, 1);
    assert.equal(cues[0].text, "Real");
  });

  it("sorts out-of-order cues by start time", () => {
    const jumbled = "1\n00:00:09,000 --> 00:00:10,000\nLate\n\n2\n00:00:01,000 --> 00:00:02,000\nEarly";
    const cues = parseSubtitles(jumbled);
    assert.deepEqual(cues.map((c) => c.text), ["Early", "Late"]);
  });
});

describe("parseSubtitles — real-world damage", () => {
  it("splits on separator lines that contain spaces or tabs", () => {
    // Plenty of files in the wild have a stray space on the "blank" line.
    // Splitting on /\n{2,}/ alone glues the whole file into one cue.
    const dirty = "1\n00:00:01,000 --> 00:00:02,000\nFirst\n \n2\n00:00:03,000 --> 00:00:04,000\nSecond\n\t\n3\n00:00:05,000 --> 00:00:06,000\nThird";
    const cues = parseSubtitles(dirty);
    assert.equal(cues.length, 3);
    assert.deepEqual(cues.map((c) => c.text), ["First", "Second", "Third"]);
  });

  it("handles doubled carriage returns (\\r\\r\\n)", () => {
    // A doubled CR still means ONE line break; treating each as its own
    // newline makes every line a separate block and yields no cues at all.
    const doubled = "1\r\r\n00:00:01,000 --> 00:00:02,000\r\r\nHello\r\r\n\r\r\n2\r\r\n00:00:03,000 --> 00:00:04,000\r\r\nWorld";
    const cues = parseSubtitles(doubled);
    assert.equal(cues.length, 2);
    assert.deepEqual(cues.map((c) => c.text), ["Hello", "World"]);
  });
});

describe("parseSubtitles — ASS specifics", () => {
  it("treats \\h as a hard space, not a line break", () => {
    const ass = "[Events]\nFormat: Start, End, Text\nDialogue: 0:00:01.00,0:00:02.00,Mr.\\hSmith arrives";
    assert.equal(parseSubtitles(ass)[0].text, "Mr. Smith arrives");
  });

  it("drops drawing-mode shape commands instead of printing them", () => {
    // {\p1}...{\p0} wraps vector coordinates for typesetting, not dialogue.
    const ass = [
      "[Events]",
      "Format: Start, End, Text",
      "Dialogue: 0:00:01.00,0:00:02.00,{\\p1}m 128 32 l 384 32 384 96{\\p0}",
      "Dialogue: 0:00:03.00,0:00:04.00,{\\p1}m 0 0 l 9 9{\\p0}Real dialogue",
    ].join("\n");
    const cues = parseSubtitles(ass);
    // The pure-shape line has no text left, so it is dropped entirely.
    assert.deepEqual(cues.map((c) => c.text), ["Real dialogue"]);
  });
});

describe("parseSubtitles — WebVTT", () => {
  it("skips the header, NOTE/STYLE blocks and cue settings", () => {
    const vtt = [
      "WEBVTT - Some title",
      "",
      "NOTE this is a comment",
      "we should ignore it",
      "",
      "STYLE",
      "::cue { color: red }",
      "",
      "intro",
      "00:00:01.000 --> 00:00:04.000 align:start position:10%",
      "Hello <i>there</i>",
    ].join("\n");
    const cues = parseSubtitles(vtt, "sub.vtt");
    assert.equal(cues.length, 1);
    assert.deepEqual(cues[0], { start: 1, end: 4, text: "Hello <i>there</i>" });
  });

  it("strips <font> tags a VTT cue would render literally", () => {
    const cues = parseSubtitles('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<font color="#ff0000">Red</font>');
    assert.equal(cues[0].text, "Red");
  });
});

describe("parseSubtitles — ASS/SSA", () => {
  const ass = [
    "[Script Info]",
    "Title: Example",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname",
    "Style: Default,Arial",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,{\\an8}Hello {\\i1}world{\\i0}",
    "Dialogue: 0,0:00:05.50,0:00:07.00,Default,,0,0,0,,First\\NSecond",
  ].join("\n");

  it("reads Dialogue rows using the Format column order", () => {
    const cues = parseSubtitles(ass, "anime.ass");
    assert.equal(cues.length, 2);
    assert.deepEqual(cues[0], { start: 1, end: 4, text: "Hello world" });
  });

  it("converts \\N to a real line break", () => {
    const cues = parseSubtitles(ass);
    assert.equal(cues[1].text, "First\nSecond");
  });

  it("keeps commas that belong to the dialogue text", () => {
    const withComma = [
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Wait, what?",
    ].join("\n");
    assert.equal(parseSubtitles(withComma)[0].text, "Wait, what?");
  });

  it("honours a reordered Format line", () => {
    const reordered = [
      "[Events]",
      "Format: Start, End, Text",
      "Dialogue: 0:00:02.00,0:00:03.00,Reordered",
    ].join("\n");
    assert.deepEqual(parseSubtitles(reordered)[0], { start: 2, end: 3, text: "Reordered" });
  });

  it("ignores Dialogue lines outside the [Events] section", () => {
    const stray = ["[Script Info]", "Dialogue: 0,0:00:01.00,0:00:02.00,,,0,0,0,,Nope", "[Events]", "Format: Start, End, Text", "Dialogue: 0:00:05.00,0:00:06.00,Yes"].join("\n");
    const cues = parseSubtitles(stray);
    assert.deepEqual(cues.map((c) => c.text), ["Yes"]);
  });
});

describe("detectSubtitleFormat", () => {
  it("sniffs content over a misleading file extension", () => {
    // Files renamed .srt but actually VTT/ASS are common in the wild.
    assert.equal(detectSubtitleFormat("WEBVTT\n\n00:00.000 --> 00:01.000\nx", "sub.srt"), "vtt");
    assert.equal(detectSubtitleFormat("[Script Info]\nTitle: x", "sub.srt"), "ass");
    assert.equal(detectSubtitleFormat("1\n00:00:01,000 --> 00:00:02,000\nx", "sub.txt"), "srt");
  });

  it("falls back to the extension when the content is inconclusive", () => {
    assert.equal(detectSubtitleFormat("", "sub.vtt"), "vtt");
    assert.equal(detectSubtitleFormat("", "sub.ssa"), "ass");
  });
});

describe("shiftCues", () => {
  const cues: SubtitleCue[] = [
    { start: 1, end: 2, text: "a" },
    { start: 10, end: 12, text: "b" },
  ];

  it("moves every cue later by a positive offset", () => {
    assert.deepEqual(shiftCues(cues, 1.5), [
      { start: 2.5, end: 3.5, text: "a" },
      { start: 11.5, end: 13.5, text: "b" },
    ]);
  });

  it("clamps a negative shift at zero instead of going negative", () => {
    // Negative start times throw when handed to VTTCue.
    const shifted = shiftCues(cues, -1.5);
    assert.equal(shifted[0].start, 0);
    assert.ok(shifted.every((c) => c.start >= 0));
  });

  it("drops cues pushed entirely before the start of the media", () => {
    assert.deepEqual(shiftCues(cues, -5).map((c) => c.text), ["b"]);
  });

  it("returns a copy, never the original array", () => {
    const same = shiftCues(cues, 0);
    assert.notEqual(same, cues);
    assert.deepEqual(same, cues);
  });
});

describe("formatOffset", () => {
  it("signs and rounds for display", () => {
    assert.equal(formatOffset(0), "0s");
    assert.equal(formatOffset(1.5), "+1.5s");
    assert.equal(formatOffset(-0.5), "-0.5s");
    assert.equal(formatOffset(0.0001), "0s");
  });
});
