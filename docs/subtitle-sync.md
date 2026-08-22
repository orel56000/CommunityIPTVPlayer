# Automatic subtitle sync

Subtitles that run early or late are the most common complaint about a
downloaded `.srt`. The player has always had two manual answers — nudge the
delay, or match a line by ear — and now has a third that needs no input at all:

```
Subtitles ▸
┌────────────────────────────────────┐
│ Delay                          0s  │
│ ┌────────────────────────────────┐ │
│ │        Sync subtitles          │ │
│ └────────────────────────────────┘ │
│ Subtitles synchronized: +2.4s      │
│ ┌────────────────────────────────┐ │
│ │           Undo sync            │ │
│ └────────────────────────────────┘ │
│ ┌────────────────────────────────┐ │
│ │   Match a line to the video…   │ │
│ └────────────────────────────────┘ │
│  -1   -0.5   +0.5   +1    Reset    │
└────────────────────────────────────┘
```

It listens to the video, works out where the speech is, and slides the
subtitles until the two line up.

## Where the algorithm comes from

This is a port of [ffsubsync](https://github.com/smacke/ffsubsync) (MIT, ©
2019 Stephen Macke), not an approximation of it. The method:

1. **Reference speech.** Reduce the video to one number per 10 ms — 1 where
   someone is speaking, 0 where nobody is.
2. **Subtitle speech.** Do the same to the subtitle file: 1 while a line is on
   screen, 0 between lines. No text is read, no language is assumed. This is
   why it works on a Hungarian subtitle over a Korean film.
3. **Cross-correlate.** Slide one signal past the other with an FFT and take
   the peak. That lag is the delay.
4. **Framerate.** Repeat for each plausible framerate mismatch (a 25 fps
   subtitle against a 24 fps encode drifts further out the longer it runs) and
   keep whichever fits best.

Both signals are mapped to ±1 before correlating, so silence agreeing with
silence counts too. That is why the reference must cover the whole timeline
rather than a sampled slice of it, and why the answer is always a small shift
rather than a large one.

**Sign convention:** a positive offset moves the subtitles LATER. `+2.4s` means
they were showing 2.4 seconds early.

## The two engines

The app runs with or without its local helper, and the feature works either
way. `subtitleSync.ts` picks an engine using the app's existing backend probe —
there is no second health check.

| | Native (helper app connected) | Web only |
| --- | --- | --- |
| Chosen when | a helper is connected AND the video is an `http(s)` URL it can fetch | a dropped file, a `blob:` URL, or no helper |
| Audio | the bundled FFmpeg, server-side | `ffmpeg.wasm`, in the browser |
| Alignment | real **ffsubsync** if installed, otherwise the port | the port |
| Bytes through the browser | ~1 MB of speech signal | none — the file is read in place |

### Native

`POST /api/subsync` hands the whole job to an installed ffsubsync. That is the
original implementation rather than a port of it, so where it exists it is
authoritative — its WebRTC voice detector, its embedded-subtitle fast path, its
scoring. The relay finds it by probing `ffsubsync`, `subsync`, `ffs` and
`python3 -m ffsubsync.ffsubsync` once at startup; `CTV_FFSUBSYNC` overrides.
Nothing is bundled and nothing is installed on the user's behalf.

Without ffsubsync, `GET /api/subsync/reference` decodes the audio with the
bundled FFmpeg and returns **only the speech signal** — one byte per 10 ms,
about 1 MB for a three-hour film — and the frontend finishes with the same
TypeScript aligner web-only mode uses. What the backend contributes there is
what only it can: pulling a multi-gigabyte provider stream without any of it
passing through the tab.

Both routes are loopback-only and validate their target with the relay's
existing `parse_proxy_target`, so they cannot be aimed at the LAN — and both
strip the provider URL out of anything they report, since an Xtream address
carries the user's username and password in its path.

A page served to a LAN device by this relay gets a 403 from them, which the
frontend treats as "the backend declined" and finishes in the browser instead.

### Web

`ffmpeg.wasm` is fetched **only when someone actually presses the button**, and
for a dropped file it is *mounted*, never copied: FFmpeg reads it lazily
through the browser's own file handle, so seeking to the 90-minute mark reads
the bytes around the 90-minute mark. Audio comes out in 100-second windows,
mono, at 16 kHz, with the video stream never decoded (`-vn`); each window is
detected and released before the next is asked for. Peak memory is one window
(~3 MB) plus the finished signal (~8 MB for three hours) — never the film.

Windows are **placed** on the timeline by their start time rather than
concatenated. Each is a separate FFmpeg invocation and may come back a little
short; appending them would let every discrepancy shift everything after it,
and the shifts accumulate until a long film's late scenes sit seconds from
where they really are.

A **URL** cannot be read lazily from inside wasm — whatever is fetched is held
— so that path pulls a bounded prefix (192 MB, roughly fifteen minutes) and
finds the offset from the front of the film. A local file has no such limit.

Detection and correlation run in a **Web Worker**, so playback does not stutter
while a 2²¹-point transform runs. If a worker cannot be created at all, the
same functions run on the main thread instead.

## Before any of that: another subtitle track

ffsubsync's own default (`subs_then_webrtc`) tries the video's embedded
subtitles first and only listens to the audio if there are none. Both engines
do the same. If the video carries a correctly-timed track — an HLS rendition,
an in-band track, a second file dropped on the player — aligning against it is
exact, instant, and decodes nothing at all.

## When it refuses

A confidently wrong sync is worse than no sync, so an alignment the code does
not trust is reported and **not applied**:

- the subtitles line up worse than they would by chance;
- the match is weak — confidence is a skill score, `(coverage − density) /
  (1 − density)`, where 1 is perfect and 0 is no better than guessing;
- the shift or the framerate correction is implausible;
- two framerate hypotheses fit equally well *and* disagree about where the
  lines belong.

ffsubsync writes its answer out regardless and leaves `--skip-sync-on-low-quality`
opt-in. This inverts that. The raw correlation score is kept in the result for
the debug log but never shown: it is unnormalized and grows with file length,
so it means nothing to a person.

The last of those checks is skipped for a piecewise result, and only there. It
asks whether the single-offset search could tell two framerate hypotheses
apart, and a subtitle whose offset changes partway through is exactly the case
where it cannot — a steady stretch approximates a mid-file jump well enough to
tie with it. The piecewise pass has already chosen between them under its own
objective, and confidence is still measured on what actually ships.

## Undo, and your file

Nothing is written to disk. A sync replaces the cues **in memory** for the
current playback only; the `.srt` on disk is untouched, and *Undo sync* puts
the previous timings back. An embedded track becomes a new "(synced)" entry
rather than being edited in place — the player re-mirrors embedded tracks from
their source every two seconds and would otherwise revert the work.

The manual delay still works afterwards, as an adjustment on top.

## Files

| File | Role |
| --- | --- |
| [`src/types/subtitleSync.ts`](../src/types/subtitleSync.ts) | The engine contract both sides answer to |
| [`src/utils/subsyncFft.ts`](../src/utils/subsyncFft.ts) | Radix-2 FFT |
| [`src/utils/subsyncSpeech.ts`](../src/utils/subsyncSpeech.ts) | Cues → the 100 Hz speech signal |
| [`src/utils/subsyncAlign.ts`](../src/utils/subsyncAlign.ts) | Cross-correlation, framerate search, quality gate |
| [`src/utils/subsyncSplit.ts`](../src/utils/subsyncSplit.ts) | Piecewise (alass-style) alignment |
| [`src/utils/subsyncVad.ts`](../src/utils/subsyncVad.ts) | Voice activity detection over PCM |
| [`src/utils/subsyncEngine.ts`](../src/utils/subsyncEngine.ts) | The shared pipeline both engines run |
| [`src/utils/subsyncAudio.ts`](../src/utils/subsyncAudio.ts) | ffmpeg.wasm extraction, in windows |
| [`src/utils/subtitleSync.ts`](../src/utils/subtitleSync.ts) | The two engines, and which one to use |
| [`src/workers/subsync.worker.ts`](../src/workers/subsync.worker.ts) | Worker shell — no algorithm of its own |
| [`src-tauri/src/subsync.rs`](../src-tauri/src/subsync.rs) | Native ffsubsync + reference extraction |

Everything in `src/utils/subsync*.ts` is pure and DOM-free, and is covered by
`npm test`; the Rust side by `cargo test`.

## Mid-file drift

ffsubsync also implements alass-style piecewise alignment — every cue may take
its own offset, at a fixed cost per change — which is what fixes a subtitle
that goes wrong only after an ad break or an inserted scene. It is ported in
full (`subsyncSplit.ts`), and off by default: it is slower, and it makes the
reported offset a median rather than a shift. Pass `splitPenaltySeconds` on a
`SubtitleSyncInput` to enable it.

## Self-hosting the decoder

The wasm core comes from unpkg by default, pinned to a version **and to a
SHA-256 of its bytes** — it is third-party code that gets executed, and a
version number says which bytes were meant, not which arrived. A mismatch is
fatal rather than a warning. (`<script integrity>` cannot cover this: the core
is loaded from inside a worker, not from a tag.)

To serve it yourself — for offline use, or a strict CSP — drop the **ESM**
build's `ffmpeg-core.js` and `ffmpeg-core.wasm` into `public/ffmpeg/`; they are
picked up automatically and not hash-checked, since they are then same-origin.
The UMD build does not work here (Vite builds ffmpeg's worker as an ES module,
where `importScripts` does not exist). `VITE_FFMPEG_CORE_URL` overrides both.

## Fidelity

The port is checked against the real thing rather than against memory. The FFT
aligner, the subtitle rasterizer, the metadata classifier and the piecewise
aligner were all diffed sample-for-sample against ffsubsync's Python output,
and the voice detector against `auditok` 0.1.5. Three divergences are
deliberate and commented where they occur:

- **Negative timestamps.** ffsubsync writes them into the file, where they
  become malformed SRT. Our sink is a `VTTCue`, which rejects them, so a cue
  pushed entirely before zero is dropped and a straddling one is clamped —
  which is what the player's manual delay has always done.
- **A leaking VAD marker.** ffsubsync writes the auditok detector's token
  boundaries by assignment, so a token truncated at its five-second cap has its
  end marker overwritten by the next token's start, and everything after it in
  that block reads as speech. Accumulating instead keeps the boundary.
- **A wrapping slice bound.** The correlation masks lags outside the tolerance
  with `convolve[: n-1-max-S] = -inf`. When the reference is shorter than the
  tolerance — a one-minute clip against the sixty-second default — that bound
  goes negative, and a negative stop in a Python slice is resolved against the
  END of the array, masking a huge prefix instead of nothing. Clamping at zero
  masks nothing there, which is what the line plainly means to do. Where the
  bound is positive the two are identical.
