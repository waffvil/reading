// Shelf — an offline PDF reader.
// Books live in IndexedDB on the device; the app shell and pdf.js are cached by the service worker,
// so once a book is on the shelf it opens with no network at all.
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdfjs/pdf.worker.min.mjs", location.href).href;
const DOC_OPTS = {
  cMapUrl: new URL("./vendor/pdfjs/cmaps/", location.href).href,
  cMapPacked: true,
  standardFontDataUrl: new URL("./vendor/pdfjs/standard_fonts/", location.href).href,
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------------------------------------------------------------- prefs (per-device conveniences)
const prefs = {
  get(k, d) { try { const v = localStorage.getItem("shelf." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("shelf." + k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- IndexedDB
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("shelf", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("books", { keyPath: "id" });
      d.createObjectStore("files");
      d.createObjectStore("marks", { keyPath: "id" }).createIndex("book", "bookId");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => (out = req.result);
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const idb = {
  get: (st, k) => tx(st, "readonly", (s) => s.get(k)),
  all: (st) => tx(st, "readonly", (s) => s.getAll()),
  put: (st, v, k) => tx(st, "readwrite", (s) => (k === undefined ? s.put(v) : s.put(v, k))),
  del: (st, k) => tx(st, "readwrite", (s) => s.delete(k)),
  marksFor: (bookId) => tx("marks", "readonly", (s) => s.index("book").getAll(bookId)),
};

// ---------------------------------------------------------------- toast / busy / sheets
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function busy(on, text = "Loading…") {
  $("#busy").hidden = !on;
  $("#busy-text").textContent = text;
}
let openSheetEl = null;
function openSheet(el) {
  closeSheet();
  openSheetEl = el;
  el.hidden = false;
  $("#scrim").hidden = false;
}
function closeSheet() {
  if (openSheetEl) openSheetEl.hidden = true;
  openSheetEl = null;
  $("#scrim").hidden = true;
}
$("#scrim").addEventListener("click", closeSheet);

// ---------------------------------------------------------------- theme
const THEME_BG = { light: "#f6f1e7", sepia: "#efe4cf", dark: "#1c1915" };
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  const bg = t === "sepia" ? THEME_BG.sepia : dark ? THEME_BG.dark : THEME_BG.light;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute("content", bg));
  markSeg("#seg-theme", t);
}
function markSeg(sel, v) {
  document.querySelectorAll(sel + " button").forEach((b) => b.classList.toggle("on", b.dataset.v === String(v)));
}

// ================================================================ IMPORT
async function hashId(buf) {
  try {
    const head = buf.slice(0, 2 * 1024 * 1024);
    const d = await crypto.subtle.digest("SHA-256", head);
    return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("") + "-" + buf.byteLength.toString(36);
  } catch {
    return "b" + buf.byteLength.toString(36) + "-" + uid().slice(0, 8);
  }
}
function niceTitle(name) {
  return name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
}
function junkTitle(t) {
  return !t || t.length < 2 || /^(untitled|microsoft word|document|\d+)$|\.(docx?|indd|pdf)$/i.test(t.trim());
}

async function importBuffer(buf, meta = {}) {
  const id = await hashId(buf);
  if (await idb.get("books", id)) { toast("Already on your shelf"); return id; }

  const doc = await pdfjsLib.getDocument({ ...DOC_OPTS, data: new Uint8Array(buf.slice(0)) }).promise;
  let info = {};
  try { info = (await doc.getMetadata()).info || {}; } catch {}

  // cover: first page as a small JPEG
  let cover = null, ratio = 1.5;
  try {
    const p = await doc.getPage(1);
    const v1 = p.getViewport({ scale: 1 });
    ratio = v1.height / v1.width;
    const vp = p.getViewport({ scale: 360 / v1.width });
    const c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await p.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    cover = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
    c.width = c.height = 0;
  } catch (e) { console.warn("cover failed", e); }

  const fileTitle = meta.fileName ? niceTitle(meta.fileName) : "";
  const book = {
    id,
    title: meta.title || fileTitle || (!junkTitle(info.Title) ? info.Title : "") || "Untitled",
    author: meta.author || (info.Author && !/^(user|admin|owner)$/i.test(info.Author) ? info.Author : ""),
    pages: doc.numPages,
    ratio,
    size: buf.byteLength,
    added: Date.now(),
    lastOpened: 0,
    pos: { page: 1, frac: 0 },
    source: meta.source || "",
    cover,
  };
  await doc.destroy();

  // Blob is the compact form; fall back to the raw buffer where a browser refuses Blobs in IDB.
  try { await idb.put("files", new Blob([buf], { type: "application/pdf" }), id); }
  catch { await idb.put("files", buf, id); }
  await idb.put("books", book);

  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
  return id;
}

$("#file-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  let ok = 0;
  for (const [n, f] of files.entries()) {
    busy(true, files.length > 1 ? `Adding ${n + 1} of ${files.length}…` : `Adding “${niceTitle(f.name)}”…`);
    try { await importBuffer(await f.arrayBuffer(), { fileName: f.name }); ok++; }
    catch (err) { console.error(err); toast(`Couldn't read ${f.name} — is it a PDF?`, 3500); }
  }
  busy(false);
  if (ok) toast(ok === 1 ? "Added — available offline" : `${ok} books added — available offline`);
  renderLibrary();
});

// ================================================================ LIBRARY
let coverURLs = [];
function coverImg(book) {
  if (!book.cover) return `<div class="cover"></div>`;
  const u = URL.createObjectURL(book.cover);
  coverURLs.push(u);
  return `<div class="cover"><img src="${u}" alt=""></div>`;
}
function progressOf(b) {
  const pct = b.pages > 1 ? Math.round(((b.pos?.page || 1) - 1 + (b.pos?.frac || 0)) / b.pages * 100) : 0;
  return Math.max(0, Math.min(100, pct));
}

async function renderLibrary() {
  coverURLs.forEach(URL.revokeObjectURL);
  coverURLs = [];
  const books = (await idb.all("books")).sort((a, b) => (b.lastOpened || b.added) - (a.lastOpened || a.added));

  const cont = books.find((b) => b.lastOpened);
  const contEl = $("#continue");
  if (cont) {
    contEl.hidden = false;
    contEl.innerHTML = `
      <button class="continue-card" data-open="${esc(cont.id)}">
        ${coverImg(cont)}
        <div class="meta">
          <div class="eyebrow">Continue reading</div>
          <div class="t">${esc(cont.title)}</div>
          <div class="s">Page ${cont.pos?.page || 1} of ${cont.pages} · ${progressOf(cont)}%</div>
          <div class="progress"><i style="width:${progressOf(cont)}%"></i></div>
        </div>
      </button>`;
  } else contEl.hidden = true;

  $("#books-title").hidden = !books.length;
  $("#books").innerHTML = books.map((b) => `
    <div class="book">
      <button class="book-open" data-open="${esc(b.id)}" style="display:block;width:100%;text-align:left">
        ${coverImg(b)}
        <div class="t">${esc(b.title)}</div>
        <div class="s">${b.lastOpened ? `${progressOf(b)}% · p. ${b.pos?.page || 1}/${b.pages}` : `${b.pages} pages · new`}</div>
      </button>
      <button class="book-more" data-more="${esc(b.id)}" aria-label="Options for ${esc(b.title)}">
        <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/></svg>
      </button>
    </div>`).join("");

  // books published alongside the app (books/library.json) that aren't on this device yet
  let hosted = [];
  try {
    const r = await fetch("books/library.json", { cache: "no-cache" });
    if (r.ok) hosted = (await r.json()).books || [];
  } catch {}
  const have = new Set(books.map((b) => b.source).filter(Boolean));
  hosted = hosted.filter((h) => h.file && !have.has(h.file));
  $("#hosted-wrap").hidden = !hosted.length;
  $("#hosted").innerHTML = hosted.map((h) => `
    <div class="hosted-row">
      <div class="meta"><div class="t">${esc(h.title || niceTitle(h.file))}</div><div class="s">${esc(h.author || "")}</div></div>
      <button class="btn small primary" data-dl="${esc(h.file)}" data-title="${esc(h.title || "")}" data-author="${esc(h.author || "")}">Download</button>
    </div>`).join("");

  $("#empty").hidden = books.length > 0 || hosted.length > 0;
  renderStorage();
}

async function renderStorage() {
  let s = "";
  try {
    const est = await navigator.storage?.estimate?.();
    if (est?.usage != null) s = `${(est.usage / 1048576).toFixed(1)} MB stored on this device`;
    if (await navigator.storage?.persisted?.()) s += " · protected";
  } catch {}
  $("#storage-info").textContent = s;
  $("#offline-badge").hidden = navigator.onLine;
}
addEventListener("online", renderStorage);
addEventListener("offline", renderStorage);

$("#library").addEventListener("click", async (e) => {
  const open = e.target.closest("[data-open]");
  const more = e.target.closest("[data-more]");
  const dl = e.target.closest("[data-dl]");
  if (more) return bookOptions(more.dataset.more);
  if (open) return openBook(open.dataset.open);
  if (dl) return downloadHosted(dl.dataset.dl, dl.dataset.title, dl.dataset.author);
});

async function downloadHosted(file, title, author) {
  busy(true, "Downloading…");
  try {
    const r = await fetch("books/" + file.split("/").map(encodeURIComponent).join("/"));
    if (!r.ok) throw new Error("HTTP " + r.status);
    const total = +r.headers.get("content-length") || 0;
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      busy(true, total ? `Downloading… ${Math.round((got / total) * 100)}%` : `Downloading… ${(got / 1048576).toFixed(1)} MB`);
    }
    const buf = await new Blob(chunks).arrayBuffer();
    busy(true, "Saving for offline…");
    await importBuffer(buf, { source: file, title, author, fileName: file.split("/").pop() });
    toast("Downloaded — available offline");
  } catch (err) {
    console.error(err);
    toast("Download failed — check your connection", 3500);
  }
  busy(false);
  renderLibrary();
}

let sheetBookId = null;
async function bookOptions(id) {
  const b = await idb.get("books", id);
  if (!b) return;
  sheetBookId = id;
  $("#sb-title").textContent = b.title;
  openSheet($("#sheet-book"));
}
$("#sb-cancel").addEventListener("click", closeSheet);
$("#sb-delete").addEventListener("click", async () => {
  const id = sheetBookId;
  closeSheet();
  if (!id) return;
  const marks = await idb.marksFor(id);
  for (const m of marks) await idb.del("marks", m.id);
  await idb.del("files", id);
  await idb.del("books", id);
  toast("Removed from this device");
  renderLibrary();
});

// ================================================================ READER
const scroller = $("#scroller");
const pagesEl = $("#pages");
const CROP = 0.075;        // fraction trimmed from each edge in "Trim margins"
const MAX_CANVAS_PX = 5e6; // per-page backing store cap — iOS kills tabs that hoard canvas memory

const R = {
  book: null, pdf: null, pageEls: [], sizes: [], rendered: new Map(),
  marks: [], io: null, zoom: 1, crop: 0, W: 0, saveTimer: 0, toc: null,
};

async function openBook(id) {
  const book = await idb.get("books", id);
  if (!book) return;
  busy(true, "Opening…");
  try {
    const f = await idb.get("files", id);
    const data = f instanceof Blob ? await f.arrayBuffer() : f;
    R.pdf = await pdfjsLib.getDocument({ ...DOC_OPTS, data: new Uint8Array(data) }).promise;
  } catch (err) {
    console.error(err);
    busy(false);
    return toast("Couldn't open this book", 3000);
  }
  R.book = book;
  R.zoom = prefs.get("zoom", 1);
  R.crop = prefs.get("crop", 0);
  R.marks = await idb.marksFor(id);
  R.sizes = new Array(book.pages + 1);
  R.toc = null;
  book.lastOpened = Date.now();
  idb.put("books", book);

  $("#library").hidden = true;
  $("#reader").hidden = false;
  $("#reader").classList.remove("chrome-hidden");
  $("#reader-title").textContent = book.title;
  const slider = $("#page-slider");
  slider.max = book.pages;
  document.title = book.title + " — Shelf";
  history.pushState({ reader: id }, "");

  buildPages();
  layout();
  restorePos(book.pos);
  startObserver();
  busy(false);
  updatePosUI();

  if (!prefs.get("hinted", false)) {
    $("#hint").hidden = false;
    setTimeout(() => ($("#hint").hidden = true), 6000);
    prefs.set("hinted", true);
  }
}

function buildPages() {
  pagesEl.innerHTML = "";
  R.pageEls = [];
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= R.book.pages; i++) {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.i = i;
    el.innerHTML = `<div class="num">${i}</div><div class="page-inner"><div class="marks"></div></div>`;
    frag.append(el);
    R.pageEls.push(el);
  }
  pagesEl.append(frag);
  drawAllMarks();
}

function baseWidth() {
  const cw = scroller.clientWidth;
  return Math.min(cw < 600 ? cw : cw - 48, 860);
}

// Size every page box. Pages not yet loaded borrow page 1's shape; their real size lands at render.
function layout() {
  R.W = Math.round(baseWidth() * R.zoom) || R.W || 360;
  pagesEl.style.width = Math.max(R.W, scroller.clientWidth) + "px";
  for (let i = 1; i <= R.book.pages; i++) sizePage(i);
}
function sizePage(i) {
  const el = R.pageEls[i - 1];
  const [w0, h0] = R.sizes[i] || [1, R.book.ratio || 1.5];
  const m = R.crop ? CROP : 0;
  const s = R.W / (w0 * (1 - 2 * m));
  const iw = w0 * s, ih = h0 * s;
  el.style.width = R.W + "px";
  el.style.height = Math.round(ih * (1 - 2 * m)) + "px";
  const inner = el.lastElementChild;
  inner.style.cssText = `left:${-m * iw}px;top:${-m * ih}px;width:${iw}px;height:${ih}px`;
  inner.style.setProperty("--scale-factor", s);
  return s;
}

function startObserver() {
  R.io?.disconnect();
  R.io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const i = +e.target.dataset.i;
      if (e.isIntersecting) { if (!R.rendered.has(i)) renderPage(i); }
      else unrenderPage(i);
    }
  }, { root: scroller, rootMargin: "150% 0px" });
  R.pageEls.forEach((el) => R.io.observe(el));
}

async function renderPage(i) {
  const token = {};
  R.rendered.set(i, token);
  const el = R.pageEls[i - 1];
  try {
    const page = await R.pdf.getPage(i);
    if (R.rendered.get(i) !== token) return;

    if (!R.sizes[i]) {
      const v = page.getViewport({ scale: 1 });
      R.sizes[i] = [v.width, v.height];
      const before = el.offsetHeight, top = el.offsetTop;
      sizePage(i);
      const delta = el.offsetHeight - before;
      // a page above the viewport changed height — shift so the text under the reader's eye stays put
      if (delta && top + before <= scroller.scrollTop) scroller.scrollTop += delta;
    }
    const s = sizePage(i);
    const vp = page.getViewport({ scale: s });
    const inner = el.lastElementChild;

    let dpr = Math.min(window.devicePixelRatio || 1, 3);
    dpr = Math.min(dpr, Math.sqrt(MAX_CANVAS_PX / (vp.width * vp.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    token.canvas = canvas;
    token.task = page.render({
      canvasContext: canvas.getContext("2d", { alpha: false }),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    await token.task.promise;
    if (R.rendered.get(i) !== token) { canvas.width = canvas.height = 0; return; }
    inner.prepend(canvas);

    const tl = document.createElement("div");
    tl.className = "textLayer";
    canvas.after(tl);
    token.tl = tl;
    token.text = new pdfjsLib.TextLayer({ textContentSource: page.streamTextContent(), container: tl, viewport: vp });
    await token.text.render();
  } catch (err) {
    if (err?.name !== "RenderingCancelledException" && err?.name !== "AbortException") console.warn("render", i, err);
    if (R.rendered.get(i) === token) R.rendered.delete(i);
  }
}

function unrenderPage(i) {
  const t = R.rendered.get(i);
  if (!t) return;
  R.rendered.delete(i);
  try { t.task?.cancel(); } catch {}
  try { t.text?.cancel(); } catch {}
  if (t.canvas) { t.canvas.width = t.canvas.height = 0; t.canvas.remove(); }
  t.tl?.remove();
}
function unrenderAll() { [...R.rendered.keys()].forEach(unrenderPage); }

// ---------------------------------------------------------------- position
function pageIndexAtY(y) {
  let lo = 0, hi = R.pageEls.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (R.pageEls[mid].offsetTop <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function posAt(y) {
  const k = pageIndexAtY(y);
  const el = R.pageEls[k];
  return { page: k + 1, frac: Math.max(0, Math.min(1, (y - el.offsetTop) / el.offsetHeight)) };
}
function scrollToPos(page, frac = 0, offset = 0) {
  const el = R.pageEls[Math.max(1, Math.min(R.book.pages, page)) - 1];
  scroller.scrollTop = el.offsetTop + frac * el.offsetHeight - offset;
}
function restorePos(pos) { scrollToPos(pos?.page || 1, pos?.frac || 0); }

function updatePosUI() {
  if (!R.book) return;
  const mid = posAt(scroller.scrollTop + scroller.clientHeight * 0.4);
  $("#page-label").textContent = `Page ${mid.page} of ${R.book.pages}`;
  const pct = Math.round(((mid.page - 1 + mid.frac) / R.book.pages) * 100);
  $("#pct-label").textContent = `${pct}%`;
  if (!sliderActive) $("#page-slider").value = mid.page;
}
function savePos() {
  // a hidden or zero-size reader would compute "page 1" — never let that overwrite the real spot
  if (!R.book || !R.W || !scroller.clientHeight || document.querySelector("#reader").hidden) return;
  R.book.pos = posAt(scroller.scrollTop + 1);
  R.book.lastOpened = Date.now();
  return idb.put("books", R.book).catch(() => {});
}

let lastScrollTop = 0, rafPending = false, chromeAnchor = 0;
scroller.addEventListener("scroll", () => {
  cancelPress();
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; updatePosUI(); });
  }
  clearTimeout(R.saveTimer);
  R.saveTimer = setTimeout(savePos, 400);
  const st = scroller.scrollTop;
  if (!sliderActive && Math.abs(st - chromeAnchor) > 80) setChrome(false);
  lastScrollTop = st;
}, { passive: true });
document.addEventListener("visibilitychange", () => { if (document.hidden) savePos(); });
addEventListener("pagehide", savePos);

function setChrome(show) {
  $("#reader").classList.toggle("chrome-hidden", !show);
  chromeAnchor = scroller.scrollTop;
  if (!show) $("#hint").hidden = true;
}

// slider
let sliderActive = false;
const slider = $("#page-slider");
slider.addEventListener("pointerdown", () => (sliderActive = true));
slider.addEventListener("input", () => { $("#page-label").textContent = `Page ${slider.value} of ${R.book.pages}`; });
slider.addEventListener("change", () => { scrollToPos(+slider.value, 0); sliderActive = false; chromeAnchor = scroller.scrollTop; });
slider.addEventListener("pointerup", () => setTimeout(() => (sliderActive = false), 50));

// ---------------------------------------------------------------- relayout (zoom / crop / rotate)
function relayout(anchorX, anchorY) {
  const rect = scroller.getBoundingClientRect();
  const ay = anchorY ?? rect.top + 1;
  const ax = anchorX ?? rect.left;
  const y = scroller.scrollTop + (ay - rect.top);
  const a = posAt(y);
  const fx = (scroller.scrollLeft + (ax - rect.left)) / Math.max(1, pagesEl.offsetWidth);
  unrenderAll();
  layout();
  const el = R.pageEls[a.page - 1];
  scroller.scrollTop = el.offsetTop + a.frac * el.offsetHeight - (ay - rect.top);
  scroller.scrollLeft = fx * pagesEl.offsetWidth - (ax - rect.left);
  startObserver();
  updatePosUI();
}
let lastW = 0, resizeTimer;
addEventListener("resize", () => {
  if (!R.book) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (scroller.clientWidth !== lastW) { lastW = scroller.clientWidth; relayout(); }
  }, 150);
});

// pinch to zoom: scale the page column live, then re-render crisply at the new zoom on release
let pinch = null;
scroller.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 2 || !R.book) return;
  cancelPress();
  const [a, b] = e.touches;
  const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
  const rect = pagesEl.getBoundingClientRect();
  pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx, cy, scale: 1 };
  pagesEl.style.transformOrigin = `${cx - rect.left}px ${cy - rect.top}px`;
}, { passive: true });
scroller.addEventListener("touchmove", (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const z = Math.max(1, Math.min(4, R.zoom * (d / pinch.d0)));
  pinch.scale = z / R.zoom;
  pagesEl.style.transform = `scale(${pinch.scale})`;
}, { passive: false });
scroller.addEventListener("touchend", (e) => {
  if (!pinch || e.touches.length) return;
  const p = pinch;
  pinch = null;
  pagesEl.style.transform = "";
  if (Math.abs(p.scale - 1) < 0.04) return;
  R.zoom = Math.round(R.zoom * p.scale * 100) / 100;
  if (R.zoom < 1.05) R.zoom = 1;
  prefs.set("zoom", R.zoom);
  markSeg("#seg-zoom", R.zoom);
  relayout(p.cx, p.cy);
});
document.addEventListener("gesturestart", (e) => e.preventDefault()); // keep iOS from zooming the whole UI

// ---------------------------------------------------------------- long-press → bookmark the word
let press = null, lastLongPress = 0;
pagesEl.addEventListener("pointerdown", (e) => {
  if (!e.isPrimary || e.button > 0) return;
  const pageEl = e.target.closest(".page");
  if (!pageEl) return;
  press = { x: e.clientX, y: e.clientY, pageEl, timer: setTimeout(longPress, 500) };
});
pagesEl.addEventListener("pointermove", (e) => {
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
});
pagesEl.addEventListener("pointerup", cancelPress);
pagesEl.addEventListener("pointercancel", cancelPress);
pagesEl.addEventListener("contextmenu", (e) => e.preventDefault());
function cancelPress() { if (press) { clearTimeout(press.timer); press = null; } }

function longPress() {
  if (!press) return;
  const { x, y, pageEl } = press;
  press = null;
  lastLongPress = Date.now();
  const page = +pageEl.dataset.i;
  const inner = pageEl.lastElementChild;
  const r = inner.getBoundingClientRect();
  const hit = wordAt(x, y, pageEl);
  const mk = {
    id: uid(), bookId: R.book.id, page,
    x: (x - r.left) / r.width, y: (y - r.top) / r.height,
    created: Date.now(),
  };
  if (hit) {
    mk.word = hit.word;
    mk.before = hit.before;
    mk.after = hit.after;
    mk.box = {
      x: (hit.rect.left - r.left) / r.width, y: (hit.rect.top - r.top) / r.height,
      w: hit.rect.width / r.width, h: hit.rect.height / r.height,
    };
  }
  ring(x, y, pageEl);
  try { navigator.vibrate?.(12); } catch {}
  addMark(mk, hit ? `Bookmarked “${hit.word}” · p. ${page}` : `Bookmarked page ${page}`);
}

function ring(x, y, pageEl) {
  const r = pageEl.getBoundingClientRect();
  const d = document.createElement("div");
  d.className = "press-ring";
  d.style.left = x - r.left + "px";
  d.style.top = y - r.top + "px";
  pageEl.append(d);
  setTimeout(() => d.remove(), 700);
}

// Find the word under a point using the invisible pdf.js text layer.
function wordAt(x, y, pageEl) {
  const spans = [...pageEl.querySelectorAll(".textLayer span:not(.markedContent)")].filter((s) => s.firstChild?.nodeType === 3);
  if (!spans.length) return null;
  let span = document.elementsFromPoint(x, y).find((el) => spans.includes(el));
  if (!span) {
    let best = Infinity;
    for (const s of spans) {
      const rc = s.getBoundingClientRect();
      const dx = x < rc.left ? rc.left - x : x > rc.right ? x - rc.right : 0;
      const dy = y < rc.top ? rc.top - y : y > rc.bottom ? y - rc.bottom : 0;
      const d = Math.hypot(dx, dy * 1.5);
      if (d < best) { best = d; span = s; }
    }
    if (best > 28) return null;
  }
  const node = span.firstChild;
  const text = node.textContent;
  const re = /\S+/g;
  let m, best = null, bestD = Infinity;
  while ((m = re.exec(text))) {
    const rg = document.createRange();
    rg.setStart(node, m.index);
    rg.setEnd(node, m.index + m[0].length);
    const rc = rg.getBoundingClientRect();
    const d = x < rc.left ? rc.left - x : x > rc.right ? x - rc.right : 0;
    if (d < bestD) { bestD = d; best = { raw: m[0], idx: m.index, rect: rc }; }
    if (d === 0) break;
  }
  if (!best) return null;
  const k = spans.indexOf(span);
  const around = (from, to) => spans.slice(Math.max(0, from), Math.max(0, to)).map((s) => s.textContent).join(" ");
  const clean = best.raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || best.raw;
  const lead = best.raw.indexOf(clean);
  let before = (around(k - 4, k) + " " + text.slice(0, best.idx + lead)).replace(/\s+/g, " ");
  let after = (text.slice(best.idx + lead + clean.length) + " " + around(k + 1, k + 5)).replace(/\s+/g, " ");
  before = before.length > 60 ? "…" + before.slice(-60).replace(/^\S*\s/, "") : before.trimStart();
  after = after.length > 70 ? after.slice(0, 70).replace(/\s\S*$/, "") + "…" : after.trimEnd();
  return { word: clean, before, after, rect: best.rect };
}

async function addMark(mk, msg) {
  R.marks.push(mk);
  await idb.put("marks", mk);
  drawMarks(mk.page);
  flashMark(mk.id);
  syncMarkBtn();
  toast(msg);
}
async function removeMark(id) {
  const mk = R.marks.find((m) => m.id === id);
  R.marks = R.marks.filter((m) => m.id !== id);
  await idb.del("marks", id);
  if (mk) drawMarks(mk.page);
  syncMarkBtn();
}
function drawMarks(page) {
  const layer = R.pageEls[page - 1]?.querySelector(".marks");
  if (!layer) return;
  layer.innerHTML = R.marks.filter((m) => m.page === page).map((m) => {
    const ribbon = `<div class="mark-ribbon" data-mark="${m.id}" style="top:${(m.box ? m.box.y + m.box.h / 2 : m.y) * 100}%"></div>`;
    const hl = m.box
      ? `<div class="mark-hl" data-mark="${m.id}" style="left:${m.box.x * 100}%;top:${m.box.y * 100}%;width:${m.box.w * 100}%;height:${m.box.h * 100}%"></div>`
      : "";
    return ribbon + hl;
  }).join("");
}
function drawAllMarks() { new Set(R.marks.map((m) => m.page)).forEach(drawMarks); }
function flashMark(id) {
  requestAnimationFrame(() => document.querySelectorAll(`[data-mark="${id}"]`).forEach((el) => {
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }));
}
function syncMarkBtn() {
  const p = posAt(scroller.scrollTop + scroller.clientHeight * 0.4).page;
  $("#btn-mark").classList.toggle("on", R.marks.some((m) => m.page === p));
}

// tap: toggle controls, or offer to remove a tapped bookmark
scroller.addEventListener("click", (e) => {
  if (Date.now() - lastLongPress < 700) return;
  const mk = e.target.closest("[data-mark]");
  if (mk) {
    const m = R.marks.find((x) => x.id === mk.dataset.mark);
    if (m && confirm(`Remove bookmark${m.word ? ` “${m.word}”` : ""} on page ${m.page}?`)) removeMark(m.id);
    return;
  }
  setChrome($("#reader").classList.contains("chrome-hidden"));
  syncMarkBtn();
});

// bookmark button: mark the spot near the top of the screen
$("#btn-mark").addEventListener("click", async () => {
  const pos = posAt(scroller.scrollTop + scroller.clientHeight * 0.15);
  let after = "";
  try {
    const page = await R.pdf.getPage(pos.page);
    const tc = await page.getTextContent();
    after = tc.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim().slice(0, 90);
    if (after.length === 90) after = after.replace(/\s\S*$/, "") + "…";
  } catch {}
  const el = R.pageEls[pos.page - 1];
  const m = R.crop ? CROP : 0;
  addMark({
    id: uid(), bookId: R.book.id, page: pos.page,
    x: 0, y: m + pos.frac * (1 - 2 * m), after, created: Date.now(),
  }, `Bookmarked page ${pos.page}`);
});

// ---------------------------------------------------------------- panel: bookmarks & contents
document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(tab) {
  document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  $("#tab-marks").hidden = tab !== "marks";
  $("#tab-toc").hidden = tab !== "toc";
  if (tab === "toc") renderToc();
}
$("#btn-panel").addEventListener("click", () => { renderMarks(); showTab(prefs.get("tab", "marks")); openSheet($("#panel")); });

function renderMarks() {
  const list = [...R.marks].sort((a, b) => a.page - b.page || a.y - b.y);
  const date = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  $("#tab-marks").innerHTML = list.length
    ? list.map((m) => `
      <div class="mark-row">
        <button class="main" data-go="${m.id}" style="text-align:left">
          <div class="q">${m.word ? `${esc(m.before)}<b>${esc(m.word)}</b>${esc(m.after)}` : esc(m.after || `Page ${m.page}`)}</div>
          <div class="d">Page ${m.page} · ${date(m.created)}</div>
        </button>
        <button class="del" data-del="${m.id}" aria-label="Delete bookmark">
          <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>`).join("")
    : `<div class="sheet-empty">No bookmarks yet.<br>Long-press any word on a page to bookmark it,<br>or tap the ribbon icon up top.</div>`;
}
$("#tab-marks").addEventListener("click", async (e) => {
  const go = e.target.closest("[data-go]");
  const del = e.target.closest("[data-del]");
  if (del) { await removeMark(del.dataset.del); renderMarks(); return; }
  if (go) {
    const m = R.marks.find((x) => x.id === go.dataset.go);
    if (!m) return;
    closeSheet();
    goToMark(m);
  }
});
function goToMark(m) {
  const el = R.pageEls[m.page - 1];
  const mm = R.crop ? CROP : 0;
  const fy = ((m.box ? m.box.y : m.y) - mm) / (1 - 2 * mm);
  scrollToPos(m.page, Math.max(0, Math.min(1, fy)), scroller.clientHeight * 0.3);
  if (m.box) {
    const inner = el.lastElementChild;
    const x = m.box.x * inner.offsetWidth + inner.offsetLeft;
    scroller.scrollLeft = Math.max(0, el.offsetLeft + x - scroller.clientWidth / 2);
  }
  flashMark(m.id);
}

async function renderToc() {
  prefs.set("tab", "toc");
  const box = $("#tab-toc");
  if (R.toc) { box.innerHTML = R.toc; return; }
  box.innerHTML = `<div class="sheet-empty">Loading contents…</div>`;
  let outline = null;
  try { outline = await R.pdf.getOutline(); } catch {}
  if (!outline?.length) {
    R.toc = `<div class="sheet-empty">This PDF has no table of contents.<br>Use the page slider at the bottom to jump around.</div>`;
    box.innerHTML = R.toc;
    return;
  }
  const flat = [];
  const walk = (items, depth) => items.forEach((it) => { flat.push({ it, depth }); if (it.items?.length && depth < 2) walk(it.items, depth + 1); });
  walk(outline, 0);
  const pages = await Promise.all(flat.map(({ it }) => destPage(it.dest)));
  R.toc = flat.map(({ it, depth }, k) => pages[k] ? `
    <button class="toc-row" data-page="${pages[k]}" style="padding-left:${18 + depth * 18}px">
      <span class="main">${esc(it.title)}</span><span class="pg">${pages[k]}</span>
    </button>` : "").join("");
  box.innerHTML = R.toc;
}
async function destPage(dest) {
  try {
    if (typeof dest === "string") dest = await R.pdf.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    if (typeof ref === "number") return ref + 1;
    return (await R.pdf.getPageIndex(ref)) + 1;
  } catch { return null; }
}
$("#tab-toc").addEventListener("click", (e) => {
  const row = e.target.closest("[data-page]");
  if (!row) return;
  closeSheet();
  scrollToPos(+row.dataset.page, 0);
});
document.querySelector('.tabs [data-tab="marks"]').addEventListener("click", () => prefs.set("tab", "marks"));

// ---------------------------------------------------------------- settings
$("#btn-settings").addEventListener("click", () => {
  markSeg("#seg-theme", prefs.get("theme", "auto"));
  markSeg("#seg-zoom", R.zoom);
  markSeg("#seg-crop", R.crop);
  openSheet($("#settings"));
});
$("#seg-theme").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  prefs.set("theme", b.dataset.v);
  applyTheme(b.dataset.v);
});
$("#seg-zoom").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  R.zoom = +b.dataset.v;
  prefs.set("zoom", R.zoom);
  markSeg("#seg-zoom", R.zoom);
  relayout();
});
$("#seg-crop").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  R.crop = +b.dataset.v;
  prefs.set("crop", R.crop);
  markSeg("#seg-crop", R.crop);
  relayout();
});

// ---------------------------------------------------------------- close
async function closeReader() {
  if (!R.book) return;
  closeSheet();
  await savePos();
  R.io?.disconnect();
  unrenderAll();
  pagesEl.innerHTML = "";
  try { await R.pdf?.destroy(); } catch {}
  R.book = R.pdf = null;
  R.pageEls = [];
  $("#reader").hidden = true;
  $("#library").hidden = false;
  document.title = "Shelf";
  renderLibrary();
}
$("#btn-back").addEventListener("click", () => {
  if (history.state?.reader) history.back(); else closeReader();
});
addEventListener("popstate", () => { if (R.book) closeReader(); });

// ---------------------------------------------------------------- boot
applyTheme(prefs.get("theme", "auto"));
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyTheme(prefs.get("theme", "auto")));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch((e) => console.warn("sw", e));

(async () => {
  try {
    db = await openDB();
  } catch (e) {
    console.error(e);
    $("#empty").hidden = false;
    $("#empty p").textContent = "This browser blocked on-device storage (private browsing?), so books can't be saved.";
    return;
  }
  if (history.state?.reader) history.replaceState(null, "");
  await renderLibrary();
})();
