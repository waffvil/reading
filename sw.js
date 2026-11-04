// Shelf service worker. Everything the app needs is stored at install, so it opens with no network.
// Books themselves live in IndexedDB (see app.js), not here. Bump VERSION on every deploy.
// The natural voice (model + its runtime) lives in its own cache, "shelf-voice", which survives updates.
const VERSION = "shelf-v13"; // v13: one smaller, faster Kokoro file · v12: natural voice on the graphics chip, read in passages · v2: read aloud · v3: natural voice · v4: updates skip the browser cache · v5: voice start-up checks · v6: progress bar · v7: versioned voice code · v8: Safari stream fix · v9: faster voice start · v10: Piper voices, previews · v11: skip headers, more voices
importScripts("precache.js");

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: "reload" — GitHub Pages lets browsers keep files for 10 minutes; an update must not pick those up
      .then((c) => c.addAll(["./", ...self.PRECACHE].map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== "shelf-voice").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cross-origin isolation lets the voice model use several CPU cores (SharedArrayBuffer). GitHub Pages can't
// send these headers itself, so the worker adds them to everything it serves. Cross-origin fetches the app
// makes (the voice download) use CORS, which isolation allows.
function isolate(res) {
  if (!res || res.type === "opaque" || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // hosted PDFs go straight to the network — the app copies them into IndexedDB itself; so does the voice model,
  // which the voice worker keeps in the "shelf-voice" cache
  if (url.pathname.includes("/books/") && url.pathname.endsWith(".pdf")) return;
  if (url.pathname.includes("/models/")) return;

  // the natural voice's code, kept with the voice so it works offline. The match is exact, query included:
  // voice-worker.js is asked for as voice-worker.js?v=N, so a new app version never runs an old stored copy.
  if (/\/((voice|piper)-worker\.js|vendor\/(ort|ort-gpu|phonemizer|kokoro)\/|vendor\/stream-iterator\.js)/.test(url.pathname)) {
    e.respondWith(caches.open("shelf-voice").then(async (c) => {
      const hit = await c.match(req);
      if (hit) return isolate(hit);
      const res = await fetch(req);
      // vendor files never change in place (a change gets a new name), so whatever is fetched can be kept
      if (res.ok) c.put(req, res.clone()).catch(() => {});
      return isolate(res);
    }));
    return;
  }

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
      if (hit) { e.waitUntil(net.catch(() => {})); return isolate(hit); }
      return net.then(isolate).catch(() => caches.match("./index.html").then(isolate));
    })
  );
});
