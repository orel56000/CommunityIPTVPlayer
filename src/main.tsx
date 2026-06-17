import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import { discoverRelay } from "./utils/relayDiscovery";
import "./index.css";

// Detect the local helper app (native relay) and, if present, route /api/*
// stream/restream calls to it. No-op for the bundled window (already
// same-origin with the relay). Fire-and-forget — playback follows user action.
void discoverRelay();

if ("serviceWorker" in navigator) {
  const register = () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* non-fatal — installability may still apply in some browsers */
    });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
