// Simple Accountz offline cache. Pages load from the network when online and
// fall back to the saved copy when the signal drops.
const CACHE = "simpleaccountz-v24";
const FILES = ["./", "index.html", "app.html", "app-state.js", "print.html", "print.js", "icon.svg", "icon-192.png", "icon-512.png", "manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// A message from the server arrives even when the app is closed.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (error) { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(String(data.title || "Simple Accountz").slice(0, 80), {
    body: String(data.body || "").slice(0, 240),
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: String(data.tag || "simpleaccountz"),
    data: { url: "app.html" }
  }));
});

// Tapping it opens the app, or brings the open one forward.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
    for (const win of windows) if ("focus" in win) return win.focus();
    return self.clients.openWindow(new URL("app.html", self.registration.scope).href);
  }));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || caches.match("app.html")))
  );
});
