import { useCallback, useEffect, useRef, useState } from "react";

/** Chromium “Add to Taskbar / Home screen” prompt. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

const DISMISS_KEY = "iptv-install-banner-dismissed-at";
const DISMISS_MS = 45 * 24 * 60 * 60 * 1000;

function readDismissedAt(): number | null {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function isDismissed(): boolean {
  const at = readDismissedAt();
  if (at == null) return false;
  return Date.now() - at < DISMISS_MS;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  if (window.matchMedia("(display-mode: fullscreen)").matches) return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return Boolean(nav.standalone);
}

function isIosTouchDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const iPadOS13Plus = navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1;
  return iOS || iPadOS13Plus;
}

export type InstallBannerVariant = "browser-install" | "ios-homescreen";

export function useInstallAppPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(() => isDismissed());
  const [installed, setInstalled] = useState(false);
  const [showDelayPassed, setShowDelayPassed] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setShowDelayPassed(true), 2400);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const onBeforeInstall: EventListener = (e) => {
      e.preventDefault();
      const ev = e as BeforeInstallPromptEvent;
      deferredRef.current = ev;
      setDeferredPrompt(ev);
    };
    const onInstalled = () => {
      deferredRef.current = null;
      setDeferredPrompt(null);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore
    }
    setDismissed(true);
  }, []);

  const promptInstall = useCallback(async () => {
    const ev = deferredRef.current ?? deferredPrompt;
    if (!ev) return;
    try {
      await ev.prompt();
      await ev.userChoice;
    } catch {
      // User dismissed native dialog or prompt failed.
    } finally {
      deferredRef.current = null;
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  const standalone = isStandaloneDisplay();
  const ios = isIosTouchDevice();
  const variant: InstallBannerVariant | null = deferredPrompt
    ? "browser-install"
    : ios && !standalone
      ? "ios-homescreen"
      : null;

  const visible =
    !standalone &&
    !installed &&
    !dismissed &&
    showDelayPassed &&
    variant !== null &&
    (variant === "browser-install" || variant === "ios-homescreen");

  return { visible, variant, promptInstall, dismiss };
}
