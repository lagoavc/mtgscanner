const CACHE = "mtgscanner-v1";
const URLS = [
  "index.html",
  "css/app.css",
  "js/app.js",
  "manifest.json",
  "version.json",
  "icons/icon-192.png",
  "icons/icon-512.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("message", e => {
  if (e.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim()).then(() => {
      clients.matchAll().then(clients => {
        clients.forEach(c => c.postMessage({ type: "SW_UPDATED" }));
      });
    })
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // External APIs: always network
  if (e.request.url.includes("scryfall") || e.request.url.includes("ocr.space")) {
    e.respondWith(fetch(e.request));
    return;
  }

  // JS and CSS: stale-while-revalidate
  if (url.pathname.endsWith(".js") || url.pathname.endsWith(".css")) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          const fetchPromise = fetch(e.request).then(res => {
            if (res.ok) cache.put(e.request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // Everything else: cache-first with network fallback
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});
