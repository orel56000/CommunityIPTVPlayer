/**
 * Unit tests for season/series watched aggregation. The season badge, the
 * series badge, and the mark-all buttons all derive from these two functions,
 * so a bug here shows up as a badge that contradicts the episode rows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nextWatchedTarget, watchedStateFor, type WatchedState } from "./watchedState.ts";
import type { PlaybackProgress } from "../types/models.ts";

const progress = (itemId: string, completed: boolean): PlaybackProgress => ({
  itemId,
  playlistId: "pl",
  positionSec: completed ? 0 : 12,
  durationSec: 100,
  completed,
  updatedAt: 1,
});

const mapOf = (...entries: PlaybackProgress[]): Map<string, PlaybackProgress> =>
  new Map(entries.map((e) => [e.itemId, e]));

const eps = (...ids: string[]) => ids.map((id) => ({ id }));

describe("watchedStateFor", () => {
  it("reports none when nothing is watched", () => {
    assert.equal(watchedStateFor(eps("a", "b"), mapOf(progress("a", false))), "none");
  });

  it("reports all when every episode is completed", () => {
    const map = mapOf(progress("a", true), progress("b", true));
    assert.equal(watchedStateFor(eps("a", "b"), map), "all");
  });

  it("reports partial when only some are completed", () => {
    const map = mapOf(progress("a", true), progress("b", false));
    assert.equal(watchedStateFor(eps("a", "b"), map), "partial");
  });

  it("treats in-progress-but-not-completed as not watched", () => {
    // A half-watched episode still counts as unwatched for the badge — the
    // progress bar on the row is what conveys partial playback.
    assert.equal(watchedStateFor(eps("a"), mapOf(progress("a", false))), "none");
  });

  it("treats an episode with no progress entry at all as not watched", () => {
    assert.equal(watchedStateFor(eps("a", "b"), mapOf(progress("a", true))), "partial");
  });

  it("returns none for an empty group rather than claiming it is fully watched", () => {
    // Guards the season tab for a season whose episodes have not loaded yet:
    // an empty list must not render as a green "all watched" check.
    assert.equal(watchedStateFor([], mapOf(progress("a", true))), "none");
  });

  it("ignores progress entries for episodes outside the group", () => {
    const map = mapOf(progress("a", true), progress("zzz", true));
    assert.equal(watchedStateFor(eps("a", "b"), map), "partial");
  });

  it("handles a single-episode group at both extremes", () => {
    assert.equal(watchedStateFor(eps("a"), mapOf(progress("a", true))), "all");
    assert.equal(watchedStateFor(eps("a"), new Map()), "none");
  });
});

describe("nextWatchedTarget", () => {
  it("turns a fully-watched group off", () => {
    assert.equal(nextWatchedTarget("all"), false);
  });

  it("fills in a partial or empty group", () => {
    const cases: WatchedState[] = ["none", "partial"];
    for (const state of cases) assert.equal(nextWatchedTarget(state), true, state);
  });
});
