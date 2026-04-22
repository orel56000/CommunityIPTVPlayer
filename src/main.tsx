import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import "./index.css";

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
