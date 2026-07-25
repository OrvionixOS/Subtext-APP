const CACHE_NAME = "subtext-v1";

const FILES_TO_CACHE = [
  "/",
  "/subtext-fixed.html",
  "/manifest.json",
  "/Icon-192.png",
  "/Icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(FILES_TO_CACHE))
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
