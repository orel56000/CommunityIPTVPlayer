/**
 * TV-remote (D-pad) spatial navigation.
 *
 * TVs open this app in two ways: a smart-TV browser visiting the deployed
 * site, or any TV browser pointed at the phone/desktop relay's LAN address
 * (http://<device-ip>:11471). Either way the user only has arrows, OK and
 * Back — no pointer — so arrows must MOVE FOCUS between controls instead of
 * seeking/changing volume the way the desktop player binds them.
 *
 * Design constraints:
 * - One capture-phase keydown listener on window. Capture is load-bearing:
 *   the VideoPlayer claims arrow keys for seek/volume in a document-level
 *   bubble listener, and in TV mode spatial navigation must win those keys
 *   (we stopPropagation on every handled press).
 * - No focus-trap bookkeeping: the navigation scope is simply the topmost
 *   visible aria-modal dialog when one is open, else the whole body — cheap
 *   modal containment without touching the overlay components.
 * - Everything here is best-effort. TV browsers are old and weird; a failure
 *   inside the engine must never break the app's own key handling, so the
 *   handler body is wrapped in try/catch and DOM probes are defensive.
 *
 * When active we set `<html data-tvnav="1">` so index.css can draw a strong
 * 3-meter-visible focus ring without affecting desktop users.
 */

type Direction = "left" | "right" | "up" | "down";
type TvKey = Direction | "ok" | "back";

const TV_UA_RE =
  /smart-?tv|tizen|web0s|webos|netcast|viera|bravia|googletv|crkey|hbbtv|aft[a-z]{0,3}\b|roku/i;
const RELAY_PORT = "11471";
const LOOPBACK_RE = /^127\.0\.0\.1$|^localhost$/i;

const CANDIDATE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex], [role="button"]';
const SLIDER_SELECTOR = '[role="slider"], input[type="range"]';
/** Elements where Enter must stay native (typing/submitting/opening a picker). */
const NATIVE_ENTER_TAGS = new Set(["SELECT", "TEXTAREA"]);
/** Input types where Up/Down are not text-caret keys, so they may still navigate. */
const NON_TEXT_INPUT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "color",
  "range",
]);

/** Candidate centers may sit up to this far behind the direction's half-plane. */
const HALF_PLANE_TOLERANCE = 8;
/** Penalty per pixel of orthogonal center misalignment. */
const ORTHO_WEIGHT = 2.5;
/** Score multiplier (reward) when orthogonal extents overlap the current rect. */
const OVERLAP_FACTOR = 0.35;
/** Rects within this many px of the topmost row count as the same row. */
const ROW_TOLERANCE = 12;

let initialized = false;
let active = false;

const isTauriRuntime = (): boolean => {
  const win = window as typeof window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return Boolean(win.__TAURI__ || win.__TAURI_INTERNALS__);
};

/**
 * TV heuristics: explicit ?tv=1/?tv=0 override, then smart-TV user agents,
 * then "another device opened the relay's LAN address" (port 11471, not
 * loopback, not the bundled Tauri window) — that combination means e.g. a TV
 * browser pointed at the phone's IP, where the user only has a remote.
 */
const detectTvEnvironment = (): boolean => {
  try {
    const tv = new URLSearchParams(window.location.search).get("tv");
    if (tv === "0") return false;
    if (tv === "1") return true;
    if (TV_UA_RE.test(navigator.userAgent)) return true;
    return (
      window.location.port === RELAY_PORT &&
      !LOOPBACK_RE.test(window.location.hostname) &&
      !isTauriRuntime()
    );
  } catch {
    return false;
  }
};

const applyDatasetFlag = (): void => {
  if (typeof document === "undefined") return;
  if (active) document.documentElement.dataset.tvnav = "1";
  else delete document.documentElement.dataset.tvnav;
};

export const isTvNavigationActive = (): boolean => active;

/** Force TV navigation on/off (e.g. a settings toggle). Takes effect live. */
export const setTvNavigationActive = (on: boolean): void => {
  active = on;
  applyDatasetFlag();
};

const tvKeyFromEvent = (event: KeyboardEvent, editableTarget: boolean): TvKey | null => {
  switch (event.key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "Enter":
      return "ok";
    // Escape is deliberately NOT back — the app already uses it directly.
    case "GoBack":
    case "BrowserBack":
    case "XF86Back":
      return "back";
    default:
      break;
  }
  // Legacy TV browsers report remote keys only through keyCode.
  switch (event.keyCode) {
    case 37:
      return "left";
    case 39:
      return "right";
    case 38:
      return "up";
    case 40:
      return "down";
    case 13:
      return "ok";
    case 461: // LG webOS BACK
    case 10009: // Samsung Tizen RETURN
      return "back";
    case 8: // Backspace doubles as back, but never while editing text
      return editableTarget ? null : "back";
    default:
      return null;
  }
};

const isEditableTarget = (el: Element): boolean => {
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el instanceof HTMLElement && el.isContentEditable;
};

const getFocusedElement = (): Element | null => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  return el;
};

/** Topmost visible aria-modal dialog, if any — its content is the whole world. */
const getTopDialog = (): Element | null => {
  let top: Element | null = null;
  for (const dialog of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
    // The closed MobileMenu drawer keeps role=dialog while hidden only by a
    // translate inside an aria-hidden wrapper — a transformed element still
    // has client rects, so it needs both checks or it bricks navigation.
    if (dialog.closest('[aria-hidden="true"]')) continue;
    const rect = dialog.getBoundingClientRect();
    const visible =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    if (visible) top = dialog;
  }
  return top;
};

/**
 * While the player is fullscreen, the rest of the app is still laid out —
 * invisible behind the video — so navigation must be confined to the player.
 * Covers both native fullscreen and VideoPlayer's CSS fallback (the container
 * goes `position: fixed` only in that state).
 */
const getFullscreenScope = (): Element | null => {
  if (document.fullscreenElement) return document.fullscreenElement;
  const container = getPlayerContainer();
  if (container && window.getComputedStyle(container).position === "fixed") return container;
  return null;
};

const getNavigationScope = (): Element => getTopDialog() ?? getFullscreenScope() ?? document.body;

/**
 * The container whose focus means "we are inside the video player". The app
 * has no dedicated marker, but the player viewport is the focusable
 * (tabIndex) ancestor of the lone <video> element.
 */
const getPlayerContainer = (): HTMLElement | null => {
  try {
    const explicit = document.querySelector<HTMLElement>("[data-player-root]");
    if (explicit) return explicit;
    const video = document.querySelector("video");
    const container = video?.closest("[tabindex]");
    return container instanceof HTMLElement ? container : null;
  } catch {
    return null;
  }
};

const collectCandidates = (scope: Element, current: Element | null): HTMLElement[] => {
  const out: HTMLElement[] = [];
  // The player viewport wrapper is focusable (tabIndex=0 for desktop Tab flow)
  // but must not be a D-pad stop: it spans the whole player, so it wins most
  // approaches, and once focused its descendants (the entire control bar) are
  // excluded as descendants-of-current — a spatial dead-end. Skip the wrapper;
  // its inner controls are candidates themselves.
  const playerContainer = getPlayerContainer();
  for (const el of scope.querySelectorAll(CANDIDATE_SELECTOR)) {
    if (!(el instanceof HTMLElement)) continue;
    if (el === playerContainer) continue;
    // Never move to our own ancestors/descendants — their rects overlap the
    // current one and would win every direction with a near-zero score.
    if (current && (el === current || el.contains(current) || current.contains(el))) continue;
    // tabindex="-1" is click-only focus; not a D-pad stop.
    if (el.getAttribute("tabindex") === "-1") continue;
    if (el.matches(":disabled")) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.getClientRects().length === 0) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.pointerEvents === "none") continue;
    out.push(el);
  }
  return out;
};

const focusElement = (el: HTMLElement): void => {
  try {
    el.focus({ preventScroll: true });
    // The app scrolls inside overflow containers, never the window; "nearest"
    // scrolls just the enclosing rail/panel. This is also what nudges the
    // IntersectionObserver-driven infinite lists into loading more rows.
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    try {
      el.focus();
    } catch {
      /* nothing focusable after all */
    }
  }
};

/** Topmost-leftmost candidate in the viewport — the entry point for focus. */
const focusStartingCandidate = (candidates: HTMLElement[]): void => {
  if (candidates.length === 0) return;
  const items = candidates.map((el) => ({ el, rect: el.getBoundingClientRect() }));
  const inViewport = items.filter(
    ({ rect }) =>
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth,
  );
  const pool = inViewport.length > 0 ? inViewport : items;
  let minTop = Infinity;
  for (const { rect } of pool) minTop = Math.min(minTop, rect.top);
  const topRow = pool.filter(({ rect }) => rect.top <= minTop + ROW_TOLERANCE);
  let best = topRow[0];
  for (const item of topRow) {
    if (item.rect.left < best.rect.left) best = item;
  }
  focusElement(best.el);
};

/**
 * Best candidate in `dir` from `currentRect`: centers must lie in the
 * direction's half-plane (8px tolerance); score = primary-axis distance +
 * 2.5x orthogonal misalignment, rewarded (x0.35) when the candidate's
 * orthogonal extent overlaps the current rect — same row/column wins.
 */
const pickInDirection = (
  dir: Direction,
  currentRect: DOMRect,
  candidates: HTMLElement[],
): HTMLElement | null => {
  const ccx = currentRect.left + currentRect.width / 2;
  const ccy = currentRect.top + currentRect.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let primary: number;
    let ortho: number;
    let overlaps: boolean;
    if (dir === "left" || dir === "right") {
      primary = dir === "left" ? ccx - cx : cx - ccx;
      ortho = Math.abs(cy - ccy);
      overlaps = rect.bottom > currentRect.top && rect.top < currentRect.bottom;
    } else {
      primary = dir === "up" ? ccy - cy : cy - ccy;
      ortho = Math.abs(cx - ccx);
      overlaps = rect.right > currentRect.left && rect.left < currentRect.right;
    }
    if (primary < -HALF_PLANE_TOLERANCE) continue;
    let score = Math.max(primary, 0) + ORTHO_WEIGHT * ortho;
    if (overlaps) score *= OVERLAP_FACTOR;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return best;
};

/**
 * While focus is inside the player, fake pointer movement on its container so
 * the auto-hiding control bar stays visible during D-pad navigation. Purely
 * cosmetic — never allowed to throw.
 */
const nudgePlayerControls = (current: Element | null): void => {
  if (!current) return;
  try {
    const container = getPlayerContainer();
    if (!container || !container.contains(current)) return;
    container.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    if (typeof PointerEvent !== "undefined") {
      container.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    }
  } catch {
    /* cosmetic only */
  }
};

const handleArrow = (event: KeyboardEvent, dir: Direction): void => {
  const current = getFocusedElement();
  // Sliders own Left/Right (volume, zoom, the seek scrubber); Up/Down still
  // move focus away spatially. No preventDefault — the slider consumes them.
  if (current && (dir === "left" || dir === "right") && current.matches(SLIDER_SELECTOR)) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  nudgePlayerControls(current);
  const candidates = collectCandidates(getNavigationScope(), current);
  if (!current) {
    focusStartingCandidate(candidates);
    return;
  }
  const winner = pickInDirection(dir, current.getBoundingClientRect(), candidates);
  if (winner) focusElement(winner);
};

const handleEnter = (event: KeyboardEvent): void => {
  const current = getFocusedElement();
  if (!current) {
    event.preventDefault();
    event.stopPropagation();
    focusStartingCandidate(collectCandidates(getNavigationScope(), null));
    return;
  }
  // Text-entry and picker elements keep their native Enter behavior.
  if (NATIVE_ENTER_TAGS.has(current.tagName)) return;
  if (current instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(current.type)) return;
  // Everything else gets an explicit click. Buttons/links would normally get
  // one from the browser's own Enter default, but several TV browsers (and
  // the embedded preview pane) don't deliver that default reliably — so we
  // click ourselves and preventDefault to make sure it fires exactly once.
  event.preventDefault();
  event.stopPropagation();
  if (current instanceof HTMLElement) current.click();
};

const handleBack = (event: KeyboardEvent): void => {
  const dialog = getTopDialog();
  if (dialog) {
    // The app's overlays close on window-level Escape keydown; translate.
    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return;
  }
  // Fullscreen first: TV remotes never send Escape, so without this a user
  // who enters fullscreen has no remote key that leaves it.
  if (document.fullscreenElement) {
    event.preventDefault();
    event.stopPropagation();
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  const container = getPlayerContainer();
  if (container && window.getComputedStyle(container).position === "fixed") {
    // CSS fullscreen — VideoPlayer exits it on Escape at its DOCUMENT-level
    // listener (a window-dispatched event would never reach it).
    event.preventDefault();
    event.stopPropagation();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return;
  }
  const current = getFocusedElement();
  if (container && current && container.contains(current)) {
    // Back out of the player: leave its controls and land on the app chrome.
    event.preventDefault();
    if (current instanceof HTMLElement) current.blur();
    const outside = collectCandidates(document.body, null).filter(
      (el) => !container.contains(el),
    );
    focusStartingCandidate(outside);
    return;
  }
  // Swallow it so the TV browser doesn't navigate away from the app.
  event.preventDefault();
};

const onKeyDown = (event: KeyboardEvent): void => {
  if (!active) return;
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target instanceof Element ? event.target : null;
  const editable = target != null && isEditableTarget(target);
  const key = tvKeyFromEvent(event, editable);
  if (!key) return;
  if (editable && target) {
    // Typing wins, but never completely: without escape hatches an autofocused
    // search input or a <select> is a one-way trap the remote can't leave.
    // "back" always works (Backspace-as-back is already suppressed above), and
    // Up/Down leave single-line inputs and selects — only multi-line editors
    // genuinely use vertical arrows for the caret.
    if (key !== "back") {
      const vertical = key === "up" || key === "down";
      const multiLine =
        target.tagName === "TEXTAREA" || (target instanceof HTMLElement && target.isContentEditable);
      if (multiLine || !vertical) return;
    }
  }
  try {
    if (key === "ok") handleEnter(event);
    else if (key === "back") handleBack(event);
    else handleArrow(event, key);
  } catch {
    /* never let the engine break the app's own key handling */
  }
};

/**
 * Decide activation and install the capture-phase keydown listener. Safe to
 * call more than once — the second call is a no-op. The listener stays
 * installed even when inactive (it returns immediately) so that
 * setTvNavigationActive(true) can switch the engine on later without wiring.
 */
export const initTvNavigation = (): void => {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (initialized) return;
  initialized = true;
  active = detectTvEnvironment();
  applyDatasetFlag();
  window.addEventListener("keydown", onKeyDown, true);

  // The LAN-origin heuristic can't tell a TV from a phone or laptop that
  // opened the same address. When activation came ONLY from the origin (no TV
  // user agent, no explicit ?tv=1), treat it as a guess: real pointer input
  // proves this is not a remote-only device, so drop back to normal behavior
  // (a TV never produces pointer/touch events, so it keeps D-pad nav).
  const tvParam = (() => {
    try {
      return new URLSearchParams(window.location.search).get("tv");
    } catch {
      return null;
    }
  })();
  if (active && tvParam !== "1" && !TV_UA_RE.test(navigator.userAgent)) {
    const pointerEvents = ["pointermove", "pointerdown", "touchstart", "wheel"] as const;
    const disarm = (event: Event): void => {
      // nudgePlayerControls dispatches synthetic pointer events to reveal the
      // player controls — only REAL input may disarm.
      if (!event.isTrusted) return;
      setTvNavigationActive(false);
      for (const type of pointerEvents) window.removeEventListener(type, disarm, true);
    };
    for (const type of pointerEvents) {
      window.addEventListener(type, disarm, { capture: true, passive: true });
    }
  }
};
