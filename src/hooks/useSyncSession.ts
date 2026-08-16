/**
 * Drives one side of the master/follower playback sync (see syncSession.ts).
 *
 * Master: publishes a "now playing" command whenever its current item changes,
 * re-publishes with a fresh position every 15s while playing (so a follower
 * that joins mid-episode starts close to live — existing followers ignore
 * same-item commands, so this never restarts them), and polls the relay to
 * apply follower playback reports through the normal progress pipeline —
 * which is exactly how "watched on the TV" becomes "marked watched here".
 *
 * Follower: posts its own playback report every 2s and applies any new master
 * command that arrives in the same round-trip. Episode auto-advance runs
 * locally on the follower (it has the playlists via the relay backup restore),
 * so a paused or sleeping master never stalls the TV.
 *
 * All callbacks are read through a ref so the polling intervals survive
 * re-renders without being torn down.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { PlaylistItem } from "../types/models";
import {
  fetchSyncState,
  followerDeviceName,
  getFollowerId,
  isRemoteLanClient,
  ownsSyncRelay,
  postSyncCommand,
  postSyncReport,
  type RemoteMode,
  type SyncCommand,
  type SyncFollowerReport,
} from "../utils/syncSession";

const FOLLOWER_TICK_MS = 2000;
const MASTER_POLL_MS = 4000;
const MASTER_REFRESH_MS = 15000;
/** Don't re-apply a follower report unless it moved this far (mirrors App's own 5s progress throttle). */
const APPLY_DELTA_SEC = 5;

export type SyncRole = "master" | "follower" | "off";

export interface SyncSessionInputs {
  /** Relay reachable (backendConnection.connected). */
  connected: boolean;
  /**
   * Which backend the app is pointed at ("" = its own relay). `role` is derived
   * from this via ownsSyncRelay, and switching back to this app's own relay
   * moves it WITHOUT moving `connected` — so it has to be a tracked input, or
   * the role memo keeps a stale "off" for the rest of the session.
   */
  savedBackendOrigin: string;
  /** The remote device's chosen mode; null while the chooser is up, "regular" for the master itself. */
  remoteMode: RemoteMode | null;
  currentItem: PlaylistItem | null;
  isPlaying: boolean;
  /** Master: snapshot a command for an item (null when it can't be built yet). */
  buildCommand: (item: PlaylistItem) => SyncCommand | null;
  /** Latest live playback position (updated every timeupdate, pre-throttle). */
  getLivePosition: () => { positionSec: number; durationSec: number };
  /** Follower: start playing what the master commanded. */
  playRemoteItem: (command: SyncCommand) => void;
  /** Master: fold a follower's playback into local progress/watched state. */
  applyRemoteProgress: (report: SyncFollowerReport) => void;
}

export const useSyncSession = (inputs: SyncSessionInputs) => {
  const [followers, setFollowers] = useState<SyncFollowerReport[]>([]);

  const role: SyncRole = useMemo(() => {
    if (!inputs.connected) return "off";
    if (isRemoteLanClient()) return inputs.remoteMode === "sync" ? "follower" : "off";
    return ownsSyncRelay(inputs.savedBackendOrigin) ? "master" : "off";
  }, [inputs.connected, inputs.remoteMode, inputs.savedBackendOrigin]);

  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  // ---- master: publish on item change -------------------------------------
  const currentItemId = inputs.currentItem?.id ?? null;
  useEffect(() => {
    if (role !== "master" || !currentItemId) return;
    const { currentItem, buildCommand } = inputsRef.current;
    if (!currentItem || currentItem.id !== currentItemId) return;
    const command = buildCommand(currentItem);
    if (command) void postSyncCommand(command);
  }, [role, currentItemId]);

  // ---- master: periodic position refresh + follower poll ------------------
  useEffect(() => {
    if (role !== "master") return;

    // Throttle bookkeeping per follower: last applied timestamp + position.
    const lastApplied = new Map<string, { at: number; positionSec: number }>();

    const poll = async () => {
      const state = await fetchSyncState();
      if (!state) {
        setFollowers([]);
        return;
      }
      setFollowers(state.followers);

      // Apply at most ONE report per tick: the progress helpers read props
      // captured at render, so two updates in one tick would lose the first
      // (see useContinueWatching's own warning). One per 4s is plenty.
      for (const report of state.followers) {
        if (!report.itemId || !(report.durationSec > 0)) continue;
        const at = report.at ?? 0;
        const seen = lastApplied.get(report.id);
        if (seen && at <= seen.at) continue;
        const completed = report.positionSec / report.durationSec >= 0.93;
        const wasCompleted = seen ? seen.positionSec / report.durationSec >= 0.93 : false;
        if (seen && Math.abs(report.positionSec - seen.positionSec) < APPLY_DELTA_SEC && !(completed && !wasCompleted)) {
          continue;
        }
        lastApplied.set(report.id, { at, positionSec: report.positionSec });
        inputsRef.current.applyRemoteProgress(report);
        break;
      }
    };

    const refresh = () => {
      const { currentItem, isPlaying, buildCommand, getLivePosition } = inputsRef.current;
      if (!currentItem || !isPlaying) return;
      const command = buildCommand(currentItem);
      if (!command) return;
      const live = getLivePosition();
      if (live.durationSec > 0) {
        command.positionSec = live.positionSec;
        command.durationSec = live.durationSec;
      }
      void postSyncCommand(command);
    };

    void poll();
    const pollTimer = window.setInterval(() => void poll(), MASTER_POLL_MS);
    const refreshTimer = window.setInterval(refresh, MASTER_REFRESH_MS);
    return () => {
      window.clearInterval(pollTimer);
      window.clearInterval(refreshTimer);
      setFollowers([]);
    };
  }, [role]);

  // ---- follower: report + obey --------------------------------------------
  useEffect(() => {
    if (role !== "follower") return;

    const id = getFollowerId();
    const name = followerDeviceName();
    // 0 = "apply whatever command exists on join" — joining sync mode means
    // start showing what the master is showing, even if it started earlier.
    let appliedSeq = 0;
    let inFlight = false;

    const tick = async () => {
      if (inFlight) return; // a slow relay response must not stack requests
      inFlight = true;
      try {
        const { currentItem, isPlaying, getLivePosition } = inputsRef.current;
        const live = getLivePosition();
        const response = await postSyncReport({
          id,
          name,
          itemId: currentItem?.id ?? null,
          playlistId: currentItem?.playlistId ?? null,
          playlistName: null,
          shareId: currentItem ? (currentItem.shareId ?? null) : null,
          title: currentItem?.title ?? null,
          positionSec: currentItem ? live.positionSec : 0,
          durationSec: currentItem ? live.durationSec : 0,
          playing: isPlaying,
        });
        if (!response || !response.command) return;
        const seq = response.command.seq ?? response.seq;
        if (seq === appliedSeq) return;
        appliedSeq = seq;
        // Same item = a position-refresh republish (or our own auto-advance
        // echoed back) — never restart playback for it.
        if (response.command.item?.id === inputsRef.current.currentItem?.id) return;
        inputsRef.current.playRemoteItem(response.command);
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), FOLLOWER_TICK_MS);
    return () => window.clearInterval(timer);
  }, [role]);

  return { role, followers };
};
