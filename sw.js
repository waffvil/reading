// Shelf service worker. Everything the app needs is stored at install, so it opens with no network.
// Books themselves live in IndexedDB (see app.js), not here. Bump VERSION on every deploy.
const VERSION = "shelf-v2"; // v2: read aloud
importScripts("precache.js");

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(["./", ...self.PRECACHE]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // hosted PDFs go straight to the network — the app copies them into IndexedDB itself
  if (url.pathname.includes("/books/") && url.pathname.endsWith(".pdf")) return;

  // the hosted-book list: fresh when online, last copy when not
  if (url.pathname.endsWith("/books/library.json")) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then((r) => r || new Response('{"books":[]}', { headers: { "content-type": "application/json" } })))
    );
    return;
  }

  // app shell: answer from cache instantly, refresh the cached copy in the background
  const key = req.mode === "navigate" ? "./index.html" : req;
  e.respondWith(
    caches.match(key, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req.mode === "navigate" ? new Request(url.origin + url.pathname, { cache: "no-cache" }) : new Request(req, { cache: "no-cache" }))
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(key, copy));
          }
          return res;
        });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net.catch(() => caches.match("./index.html"));
    })
  );
});
