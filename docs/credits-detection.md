# End-credits detection

When an episode reaches its end credits the player offers the next episode. The
card sits above the controls, bottom-right of the video:

```
┌──────────────────────────────────┐
│ CREDITS · UP NEXT              × │
│ S1E2 · The One With The Thing    │
│ ┌──────────────────────────────┐ │
│ │        ▶| Play next          │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
```

No machine learning, no external API, no OCR, no server-side video processing.
Everything is measured locally from the `<video>` element that is already
playing, only during the final stretch of the video.

## Files

| File | Role |
| --- | --- |
| [`src/types/credits.ts`](../src/types/credits.ts) | Config, signal and result interfaces |
| [`src/utils/creditsDetection.ts`](../src/utils/creditsDetection.ts) | Pure scoring engine — no DOM |
| [`src/utils/creditsDetection.test.ts`](../src/utils/creditsDetection.test.ts) | Unit tests for the engine (`npm test`) |
| [`src/utils/creditsMarkers.ts`](../src/utils/creditsMarkers.ts) | Marker parsing + local learning store |
| [`src/hooks/useCreditsDetection.ts`](../src/hooks/useCreditsDetection.ts) | Measurement: canvas, Web Audio tap, subtitle cues |
| [`src/components/player/CreditsOverlay.tsx`](../src/components/player/CreditsOverlay.tsx) | The suggestion card |
| [`src/components/player/CreditsDebugPanel.tsx`](../src/components/player/CreditsDebugPanel.tsx) | Dev-only readout |

The split is deliberate: the hook *measures*, the engine *decides*, the
components *render*. The player UI carries none of the heuristics, and the
engine is testable without a browser.

## Marker priority

A known timestamp always beats a guess. `resolveMarkerCreditsStart` takes the
first source that supplies a usable `creditsStart`:

1. **`manual`** — a timestamp set for this exact item.
2. **`backend` / playlist** — attributes on the playlist entry itself, read by
   `parseMarkersFromItem`. A provider can ship the answer with the M3U:

   ```
   #EXTINF:-1 tvg-name="Show S01E04" credits-start="2580" credits-end="2700",Show S01E04
   ```

   Recognised keys (case-insensitive): `credits-start` / `creditsStart` /
   `tvg-credits-start` / `outro-start`, and the matching `credits-end`,
   `intro-start`, `intro-end`. Values are seconds (`2580`) or `HH:MM:SS`
   (`43:00`). To wire a real backend, resolve its markers into the item's
   `metadata` at import time, or pass them straight to `useCreditsDetection`'s
   `markers.backend` — no other code changes are needed.
3. **`learned`** — aggregated from this device's own history (below).
4. **heuristic** — the weighted scoring described next.
5. **fallback** — with nothing measurable at all, suggest the next episode once
   `fallbackRemainingSeconds` (45s) remain.

A marker **short-circuits the heuristic entirely**: `useCreditsDetection` skips
sampling and just watches the clock. It is exact, cheaper, and re-deriving it
from pixels every episode could only make it worse. Markers outside
`(duration/2, duration)` are rejected as bad data and the next source is tried.

## Signals and scoring

Sampling runs every `sampleIntervalMs` (1.5s) inside the scan window — the last
`scanLastPercent` (20%) of the video, but never earlier than
`maximumRemainingSeconds` (15 min) before the end. Samples are skipped while
paused, seeking, or buffering, so a stall pauses the run rather than resetting
it. All thresholds are in **media time**, so playback speed needs no special
handling.

| Signal | Weight | Source | Fires when |
| --- | --- | --- | --- |
| `nearEnd` | 20 | always | inside the scan window |
| `subtitleSilence` | 20 | subtitles | no dialogue cue for 25s |
| `dialogueDrop` | 10 | subtitles | recent cue density ≤ 35% of the prior window |
| `darkFrame` | 15 | visual | ≥55% very dark pixels, or luma ≤ 45% of the title's baseline |
| `lowMotion` | 15 | visual | frame delta below absolute or baseline-relative threshold |
| `audioTransition` | 10 | audio | level steady (low coefficient of variation) and not silent |
| `fadeToBlack` | 10 | visual | luma halved to near-black over ~4.5s |

Two things separate this from a naive weighted sum:

**The score is normalised over the signals that are actually measurable.** Most
IPTV VOD has no subtitle track and no Web Audio tap, so a fixed `/100`
denominator could never reach the threshold and the detector would be dead code.
With visual signals only the denominator is 60, and a dark, static frame in the
scan window scores `50/60 = 83`. `scoreSignals` also returns `usable: false`
when the available weight is under `minimumAvailableWeight` (45) — otherwise a
stream with nothing but `nearEnd` would score a meaningless 100 the moment the
window opened. That case falls through to the plain end-of-video threshold.

**Brightness and motion are compared against a per-title baseline**, taken as
the median of the first `baselineSamples` (12) frames of the scan window, not
against absolute constants. Credits are "much darker and stiller than *this*
show", which survives a dark-graded drama and a bright sitcom alike. Absolute
thresholds remain as a floor for when no baseline has formed yet.

Detection fires when the score holds at or above `triggerScore` (70) for
`requiredConsecutiveSamples` (4) consecutive samples and at least
`minimumCreditsDurationSeconds` (20) of video remain. The reported `detectedAt`
is the **start** of that run, not the sample that confirmed it.

Sound-description cues (`[music]`, `(theme music)`, `♪♪`) are not dialogue.
Filtering them out is what lets a captioned stream detect credits at all — the
track keeps emitting cues while nobody is talking.

## Graceful degradation

Every source disables itself independently:

- **Tainted canvas** — a cross-origin frame throws `SecurityError` on
  `getImageData`. Caught once, visual signals off for the rest of the item.
- **No subtitles** — the common IPTV case. Subtitle signals off. Tracks that do
  exist are switched from `disabled` to `hidden` so their cues load; nothing is
  rendered and the user sees no change.
- **No Web Audio tap** — the detector **never creates** a
  `MediaElementAudioSourceNode`. `createMediaElementSource` can only be called
  once per element, and creating one unprompted risks silencing a cross-origin
  stream. It only taps the `AnalyserNode` the player hangs off its existing gain
  node (built for >100% volume boost), whose output goes nowhere. No audio is
  recorded, buffered, or uploaded.
- **Audio-only stream** (`videoWidth === 0`) — visual signals off.
- **Nothing measurable** — falls back to the end-of-video threshold.

## Edge cases

| Case | Behaviour |
| --- | --- |
| Live streams | Detection never runs — no duration, `canAnalyzeDuration` returns false |
| Missing/infinite duration | Same |
| Trailers, clips, very short videos | Under `minimumDurationSeconds` (10 min): markers only, no heuristics |
| Dark final scene | Baseline-relative thresholds plus the 4-sample streak; a dark shot mid-scene still has motion |
| Post-credit scene, anime preview | 4 consecutive clearly-not-credits samples withdraw the suggestion (`content-resumed`) |
| Credits over active footage | Often not detected — by design. A false suggestion is worse than none |
| User seeks back before the credits | Suggestion and any dismissal are withdrawn; it can fire again |
| Playback speed | Everything is media-time, so rates need no handling |
| Casting | Disabled — playback is not on this element |
| Last episode of a series | Detection still runs (for learning); no card, since there is nothing to advance to |
| Movies | Same: detected, but no next-episode card |

## Autoplay

The overlay only ever *suggests*. **Suggest next episode during credits**
(Settings, on by default) shows the card. **Play the next episode automatically
after 10s** (off by default) adds a countdown, cancellable to the last second;
cancelling leaves the card up for a manual choice. Nothing skips a post-credit
scene out from under the viewer.

## Learning, without a model

`recordCreditsFeedback` stores one anonymous record per episode in
`localStorage` under `iptv:credits-feedback:v1`:

```ts
{ contentId, groupId, durationSec, detectedCreditsStart, userSkippedAt, userDismissed, reachedVideoEnd }
```

`getLearnedMarkers` aggregates the records for one series into a marker. It is
deliberately not a model — a median plus an agreement check:

- Pressing "Play next" is the strongest evidence (`userSkippedAt`). A detection
  the user neither skipped nor dismissed on an episode that then ran to the end
  is weaker but usable. A dismissal teaches only "not that", so it is excluded.
- Each usable timestamp becomes *seconds before the end*, which is what stays
  constant across episodes of differing length.
- At least 3 episodes must agree within ±25s of the median. Otherwise no marker
  is produced and the heuristic keeps running.

Nothing is uploaded, and no audio or video ever leaves the machine — only a
handful of timestamps. Sending these to a backend to build a shared marker per
title would be the natural next step; the aggregation rule above is the one to
apply there too.

## Debug overlay

`config.debug` is wired to `import.meta.env.DEV`, so `npm run dev` shows a
readout in the top-left of the player once analysis starts: score vs threshold,
media time and remaining, consecutive-sample streak, available weight, luma and
motion against their baselines, audio level and variation, seconds since the
last dialogue cue, which signals are active, which sources are available, and
the reason detection fired.

```
CREDITS                    83/70
t              10:35 (-0:24)
streak                      8/4
weight                       60
luma          0.031 / base 0.031
dark%                      1.00
motion        0.000 / base 0.000
audio                   — cv —
no-dialog                     —
[nearEnd] subtitleSilence dialogueDrop
[darkFrame] [lowMotion] audioTransition fadeToBlack
src heuristic · vis y · sub n · aud n
FIRED @ 10:06 (92%)
```

## Tuning

Every threshold lives in `DEFAULT_CREDITS_CONFIG`
([`src/utils/creditsDetection.ts`](../src/utils/creditsDetection.ts)) and can be
overridden per call:

```ts
useCreditsDetection({ /* … */, config: { triggerScore: 60, requiredConsecutiveSamples: 3 } });
```

## Tests

```bash
npm test
```

Runs on Node's built-in test runner (no framework, no extra dependencies) and
covers the scan window, score normalisation and the `usable` guard, frame
metrics, subtitle classification and density, each signal's baseline-relative
behaviour, the detection state machine (streak, reset, withdrawal, fire-once),
and marker priority and validation.
