// Keeps Limit One working when the connection drops: everything is fetched from the network
// when possible (so updates show up) and from this cache when not.
const CACHE = "limitone-2";
const FILES = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "logic.js",
  "manifest.webmanifest",
  "vendor/zxing-reader.js",
  "vendor/zxing_reader.wasm",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    // "no-cache" asks the server whether the file changed, so an update shows up on the next load.
    fetch(event.request, { cache: "no-cache" })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })),
  );
});
