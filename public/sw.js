/* Minimal service worker so browsers can treat this site as installable (add to home screen / “app”). */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Only handle top-level navigations so the SPA stays installable. We must NOT
// intercept media/cross-origin requests — wrapping them here turns provider
// CORS/network failures into opaque "Failed to fetch" service-worker errors.
self.addEventListener("fetch", (event) => {
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/index.html")));
  }
});
