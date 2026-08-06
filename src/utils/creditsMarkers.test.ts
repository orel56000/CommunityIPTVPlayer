/**
 * Unit tests for credits marker parsing, identity, and local learning.
 *
 * `readRecords`/`writeRecords` (localStorage I/O) aren't exercised here — there
 * is no `window` under Node's test runner. `getLearnedMarkers` takes an
 * explicit `records` override for exactly this reason, and the merge logic
 * that `recordCreditsFeedback` uses is factored out into the pure, I/O-free
 * `mergeCreditsFeedback`, so both are fully testable without a DOM.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CreditsFeedbackRecord } from "../types/credits.ts";
import type { PlaylistItem } from "../types/models.ts";
import {
  creditsContentId,
  creditsGroupId,
  getLearnedMarkers,
  mergeCreditsFeedback,
  parseMarkersFromItem,
  parseTimestamp,
} from "./creditsMarkers.ts";

const record = (overrides: Partial<CreditsFeedbackRecord> = {}): CreditsFeedbackRecord => ({
  contentId: "ep1",
  groupId: "series:show",
  durationSec: 1320,
  detectedCreditsStart: null,
  userMarkedAt: null,
  userSkippedAt: null,
  userDismissed: false,
  reachedVideoEnd: false,
  updatedAt: 1000,
  ...overrides,
});

const item = (overrides: Partial<PlaylistItem> = {}): PlaylistItem =>
  ({
    id: "id1",
    sourceId: "src1",
    playlistId: "pl1",
    displayName: "Show S01E01",
    title: "Show S01E01",
    url: "http://example.com/1.mp4",
    streamUrl: "http://example.com/1.mp4",
    kind: "series_episode",
    section: "series",
    duration: null,
    rawAttributes: {},
    metadata: {},
    ...overrides,
  }) as PlaylistItem;

describe("parseTimestamp", () => {
  it("parses plain seconds, including decimals", () => {
    assert.equal(parseTimestamp("2580"), 2580);
    assert.equal(parseTimestamp("2580.5"), 2580.5);
  });

  it("parses MM:SS and HH:MM:SS", () => {
    assert.equal(parseTimestamp("43:00"), 2580);
    assert.equal(parseTimestamp("01:03:00"), 3780);
  });

  it("rejects garbage", () => {
    assert.equal(parseTimestamp(""), null);
    assert.equal(parseTimestamp("not a time"), null);
    assert.equal(parseTimestamp("1:2:3:4"), null);
    assert.equal(parseTimestamp("-5"), null);
  });
});

describe("parseMarkersFromItem", () => {
  it("reads credits-start from EXTINF-style attributes", () => {
    const markers = parseMarkersFromItem(item({ rawAttributes: { "credits-start": "2580" } }));
    assert.deepEqual(markers, { creditsStart: 2580 });
  });

  it("understands HH:MM:SS and the alternate key spellings", () => {
    const markers = parseMarkersFromItem(item({ metadata: { "tvg-credits-start": "43:00" } }));
    assert.deepEqual(markers, { creditsStart: 2580 });
  });

  it("reads multiple marker fields at once", () => {
    const markers = parseMarkersFromItem(
      item({ rawAttributes: { "intro-start": "0", "intro-end": "90", "credits-start": "2580" } }),
    );
    assert.deepEqual(markers, { introStart: 0, introEnd: 90, creditsStart: 2580 });
  });

  it("returns null when nothing is present", () => {
    assert.equal(parseMarkersFromItem(item()), null);
    assert.equal(parseMarkersFromItem(null), null);
  });
});

describe("identity", () => {
  it("prefers shareId for content id, falls back to id", () => {
    assert.equal(creditsContentId(item({ shareId: "share1", id: "id1" })), "share1");
    assert.equal(creditsContentId(item({ shareId: undefined, id: "id1" })), "id1");
    assert.equal(creditsContentId(null), null);
  });

  it("groups series episodes by series title, case-insensitively", () => {
    const a = creditsGroupId(item({ section: "series", seriesTitle: "My Show" }));
    const b = creditsGroupId(item({ section: "series", seriesTitle: "my show" }));
    assert.equal(a, b);
    assert.equal(a, "series:my show");
  });

  it("prefers parentSeriesId over seriesTitle when both are present", () => {
    const id = creditsGroupId(item({ section: "series", parentSeriesId: "abc123", seriesTitle: "My Show" }));
    assert.equal(id, "series:abc123");
  });

  it("gives movies their own single-item bucket, not a shared series bucket", () => {
    const id = creditsGroupId(item({ section: "movies", shareId: "movie1" }));
    assert.equal(id, "item:movie1");
  });
});

describe("mergeCreditsFeedback", () => {
  it("creates a fresh record when there is no existing one", () => {
    const merged = mergeCreditsFeedback(undefined, { contentId: "ep1", groupId: "series:show", durationSec: 1320 }, 500);
    assert.equal(merged.contentId, "ep1");
    assert.equal(merged.userMarkedAt, null);
    assert.equal(merged.userDismissed, false);
    assert.equal(merged.updatedAt, 500);
  });

  it("does not let a later partial update erase an earlier field", () => {
    const first = mergeCreditsFeedback(
      undefined,
      { contentId: "ep1", groupId: "series:show", durationSec: 1320, userSkippedAt: 1200 },
      100,
    );
    const second = mergeCreditsFeedback(first, { contentId: "ep1", groupId: "series:show", durationSec: 1320, reachedVideoEnd: true }, 200);
    assert.equal(second.userSkippedAt, 1200, "the earlier skip time must survive an unrelated later update");
    assert.equal(second.reachedVideoEnd, true);
    assert.equal(second.updatedAt, 200);
  });

  it("treats userDismissed and reachedVideoEnd as sticky booleans (OR, not overwrite)", () => {
    const first = mergeCreditsFeedback(
      undefined,
      { contentId: "ep1", groupId: "series:show", durationSec: 1320, userDismissed: true },
      100,
    );
    const second = mergeCreditsFeedback(first, { contentId: "ep1", groupId: "series:show", durationSec: 1320 }, 200);
    assert.equal(second.userDismissed, true, "a later call with no opinion must not un-dismiss");
  });

  it("lets a later call overwrite userMarkedAt (correcting an earlier mark)", () => {
    const first = mergeCreditsFeedback(
      undefined,
      { contentId: "ep1", groupId: "series:show", durationSec: 1320, userMarkedAt: 1100 },
      100,
    );
    const second = mergeCreditsFeedback(
      first,
      { contentId: "ep1", groupId: "series:show", durationSec: 1320, userMarkedAt: 1150 },
      200,
    );
    assert.equal(second.userMarkedAt, 1150);
  });
});

describe("getLearnedMarkers", () => {
  const duration = 1320; // 22 min

  it("returns null below the sample threshold for inferred (skip/end) signals", () => {
    const records = [
      record({ contentId: "e1", userSkippedAt: 1200 }),
      record({ contentId: "e2", userSkippedAt: 1205 }),
    ];
    assert.equal(getLearnedMarkers("series:show", duration, records), null);
  });

  it("learns from 3 agreeing inferred samples", () => {
    const records = [
      record({ contentId: "e1", userSkippedAt: 1200 }),
      record({ contentId: "e2", userSkippedAt: 1205 }),
      record({ contentId: "e3", userSkippedAt: 1195 }),
    ];
    const markers = getLearnedMarkers("series:show", duration, records);
    assert.ok(markers?.creditsStart != null);
    assert.equal(Math.round(markers!.creditsStart!), 1200);
  });

  it("trusts a single manual mark — no need to wait for 3 episodes", () => {
    const records = [record({ contentId: "e1", userMarkedAt: 1180 })];
    const markers = getLearnedMarkers("series:show", duration, records);
    assert.deepEqual(markers, { creditsStart: 1180 });
  });

  it("prefers manual marks over inferred signals even when both exist", () => {
    const records = [
      record({ contentId: "e1", userMarkedAt: 1180 }),
      record({ contentId: "e2", userSkippedAt: 1000 }),
      record({ contentId: "e3", userSkippedAt: 1000 }),
      record({ contentId: "e4", userSkippedAt: 1000 }),
    ];
    const markers = getLearnedMarkers("series:show", duration, records);
    assert.equal(markers?.creditsStart, 1180, "3 agreeing skips exist but the manual mark must still win");
  });

  it("counts a manual mark even on a record the user later dismissed", () => {
    // A dismissal is about the "up next" overlay, not a retraction of the mark.
    const records = [record({ contentId: "e1", userMarkedAt: 1180, userDismissed: true })];
    const markers = getLearnedMarkers("series:show", duration, records);
    assert.deepEqual(markers, { creditsStart: 1180 });
  });

  it("excludes a dismissed record from the inferred (non-manual) path", () => {
    const records = [
      record({ contentId: "e1", userSkippedAt: 1200 }),
      record({ contentId: "e2", userSkippedAt: 1205 }),
      record({ contentId: "e3", userSkippedAt: 1195, userDismissed: true }),
    ];
    assert.equal(getLearnedMarkers("series:show", duration, records), null);
  });

  it("falls back to reachedVideoEnd + detectedCreditsStart when there was no skip", () => {
    const records = [
      record({ contentId: "e1", detectedCreditsStart: 1200, reachedVideoEnd: true }),
      record({ contentId: "e2", detectedCreditsStart: 1202, reachedVideoEnd: true }),
      record({ contentId: "e3", detectedCreditsStart: 1198, reachedVideoEnd: true }),
    ];
    const markers = getLearnedMarkers("series:show", duration, records);
    assert.ok(markers?.creditsStart != null);
  });

  it("refuses to learn from manual marks that disagree beyond the spread tolerance", () => {
    // Both plausible (second-half) marks, but 280s apart from-the-end — with a
    // 2-sample median exactly between them, neither is within the 25s
    // tolerance of it, so the agreement check excludes both.
    const records = [
      record({ contentId: "e1", userMarkedAt: 1180 }), // 140s from the end
      record({ contentId: "e2", userMarkedAt: 900 }), // 420s from the end — e.g. a mis-click
    ];
    const markers = getLearnedMarkers("series:show", duration, records);
    assert.equal(markers, null);
  });

  it("ignores movies (single-item buckets) and unknown groups", () => {
    assert.equal(getLearnedMarkers("item:movie1", duration, [record({ groupId: "item:movie1", userMarkedAt: 1180 })]), null);
    assert.equal(getLearnedMarkers(null, duration, []), null);
  });

  it("rejects a marker outside the plausible second-half-of-runtime window", () => {
    // durationSec - fromEnd must land in the back half of the episode.
    const records = [record({ contentId: "e1", userMarkedAt: 10, durationSec: duration })];
    assert.equal(getLearnedMarkers("series:show", duration, records), null);
  });
});
