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
  T.cache = new Map();
  T.sents = [];
  T.bookId = null;
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
    el.innerHTML = `<div class="num">${i}</div><div class="page-inner"><div class="marks"></div><div class="tts-hl"></div></div>`;
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
  if (Date.now() > T.progScrollUntil) T.userScrollAt = Date.now();
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
  refreshVoices();
  renderVoiceUI();
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

// ================================================================ LISTEN (text-to-speech)
// Two engines read the same sentences:
//  • "natural": the Kokoro voice model running on the phone (voice-worker.js). Its audio plays through an
//    <audio> element, so it carries on in the background and shows up on the lock screen like an audiobook.
//  • "system": the voices built into the device (Web Speech API). Free and instant, but iOS stops it as soon
//    as Shelf isn't on screen.
// Text comes from pdf.js page by page and is read one sentence at a time, which gives clean skip / highlight /
// resume (and long utterances get cut off in Chrome or stall on iOS).
const synth = window.speechSynthesis;
const RATES = [0.8, 1, 1.15, 1.3, 1.5, 1.75, 2];
const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;
const T = {
  playing: false, bookId: null, page: 0, sents: [], idx: 0, gen: 0, cache: new Map(),
  userScrollAt: 0, progScrollUntil: 0, wake: null, voices: [], started: false, hlPage: 0,
};
const engine = () => (prefs.get("engine", "system") === "natural" && NV.downloaded ? "natural" : "system");

// ---- device voices
// iOS names a voice the same whatever its quality ("Ava"); only the voiceURI says which one is Premium/Enhanced.
const quality = (v) => (/premium/i.test(v.voiceURI + v.name) ? "Premium" : /enhanced/i.test(v.voiceURI + v.name) ? "Enhanced" : /siri/i.test(v.voiceURI + v.name) ? "Siri" : "");
function loadVoices() {
  if (!synth) return;
  const lang = (navigator.language || "en").slice(0, 2).toLowerCase();
  const score = (v) => {
    const l = v.lang.toLowerCase(), q = quality(v);
    let s = 0;
    if (l.startsWith(lang)) s += 100;
    if (l.startsWith("en")) s += 50;
    if (v.localService) s += 20;
    if (q === "Premium") s += 30; else if (q === "Enhanced") s += 20; else if (q) s += 10;
    if (/natural|neural/i.test(v.name)) s += 15;
    if (v.default) s += 5;
    if (NOVELTY.test(v.name)) s -= 80;
    return s;
  };
  T.voices = synth.getVoices().slice().sort((a, b) => score(b) - score(a));
  renderVoiceSelect();
}
function currentVoice() {
  const uri = prefs.get("voice", "");
  return T.voices.find((v) => v.voiceURI === uri) || T.voices[0] || null;
}
function renderVoiceSelect() {
  const sel = $("#voice-select");
  if (!sel) return;
  const lang = (navigator.language || "en").slice(0, 2).toLowerCase();
  const list = T.voices.filter((v) => !NOVELTY.test(v.name) && (v.lang.toLowerCase().startsWith(lang) || v.lang.toLowerCase().startsWith("en")));
  const cur = currentVoice();
  sel.innerHTML = list.length
    ? list.map((v) => { const q = quality(v); return `<option value="${esc(v.voiceURI)}"${v === cur ? " selected" : ""}>${esc(v.name)}${q && !v.name.includes(q) ? " · " + q : ""} (${esc(v.lang)})${v.localService ? "" : " · online only"}</option>`; }).join("")
    : `<option value="">No voices on this device</option>`;
}
// iOS often hands back an empty list at first and doesn't always fire "voiceschanged", so ask again a few times
function refreshVoices() {
  if (!synth) return;
  loadVoices();
  let n = 0;
  const again = () => { loadVoices(); if (!T.voices.length && ++n < 10) setTimeout(again, 400); };
  setTimeout(again, 250);
}
if (synth) {
  refreshVoices();
  synth.addEventListener?.("voiceschanged", loadVoices);
}

// ---- natural voice (Kokoro, on-device)
const NV_VOICES = [
  ["af_heart", "Heart · US, warm"], ["af_bella", "Bella · US, bright"], ["af_nicole", "Nicole · US, soft"],
  ["am_michael", "Michael · US, male"], ["am_fenrir", "Fenrir · US, male, deep"],
  ["bf_emma", "Emma · British"], ["bm_george", "George · British, male"],
];
const NV_FILES = [
  "voice-worker.js", "vendor/ort/ort.wasm.min.mjs", "vendor/ort/ort-wasm-simd-threaded.mjs", "vendor/ort/ort-wasm-simd-threaded.wasm",
  "vendor/phonemizer/phonemizer.js", "vendor/kokoro/vocab.json", ...NV_VOICES.map(([v]) => `vendor/kokoro/voices/${v}.bin`),
];
const NV_MODEL = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_quantized.onnx";
const SILENCE = "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAwF0AAIC7AAACABAAZGF0YQQAAAAAAAAA";
const NV = {
  worker: null, downloaded: false, downloading: false, ready: null,
  clips: new Map(),   // key → { text, url, promise, resolve, reject, sent }
  want: [],           // keys to have ready, in reading order
  busy: null,         // key the worker is synthesizing
  audio: new Audio(), playingKey: null, playingGen: -1,
};
NV.audio.preload = "auto";
NV.audio.setAttribute("playsinline", "");
const nvVoice = () => { const v = prefs.get("nvVoice", "af_heart"); return NV_VOICES.some(([k]) => k === v) ? v : "af_heart"; };
const nvKey = (page, idx) => `${T.bookId}|${nvVoice()}|${page}|${idx}`;

async function nvCheck() {
  try { NV.downloaded = !!(await (await caches.open("shelf-voice")).match(NV_MODEL)); } catch { NV.downloaded = false; }
  renderVoiceUI();
}
function nvWorker() {
  if (NV.worker) return NV.worker;
  const w = (NV.worker = new Worker("voice-worker.js", { type: "module" }));
  w.onmessage = ({ data: m }) => {
    if (m.type === "progress") {
      const bar = $("#nv-progress i");
      if (bar) bar.style.width = Math.round((m.loaded / m.total) * 100) + "%";
      $("#nv-download").textContent = `Downloading… ${Math.round(m.loaded / 1e6)} of ${Math.round(m.total / 1e6)} MB`;
    } else if (m.type === "ready") {
      NV.readyResolve?.();
    } else if (m.type === "audio") {
      const c = NV.clips.get(m.id);
      NV.busy = null;
      if (c) { c.url = URL.createObjectURL(wavBlob(m.pcm, m.rate)); c.dur = m.pcm.length / m.rate; c.resolve(c.url); }
      nvPump();
    } else if (m.type === "error") {
      console.warn("voice", m.message);
      if (m.id) {
        const c = NV.clips.get(m.id);
        NV.busy = null;
        if (c) { NV.clips.delete(m.id); c.reject(new Error(m.message)); }
        nvPump();
      } else NV.readyReject?.(new Error(m.message));
    } else if (m.type === "removed") {
      NV.removedResolve?.();
    }
  };
  w.onerror = (e) => { console.warn("voice worker", e.message); NV.readyReject?.(new Error(e.message || "The voice couldn't start")); };
  return w;
}
// start the model (downloading it first if needed); resolves once it can speak
function nvReady() {
  if (!NV.ready) {
    NV.ready = new Promise((res, rej) => { NV.readyResolve = res; NV.readyReject = rej; });
    NV.ready.catch(() => { NV.ready = null; });
    nvWorker().postMessage({ type: "load" });
  }
  return NV.ready;
}
async function nvDownload() {
  if (NV.downloading) return;
  NV.downloading = true;
  renderVoiceUI();
  try {
    // keep the voice's own code with it, so it works offline even before the next app update
    caches.open("shelf-voice").then((c) => c.addAll(NV_FILES)).catch((e) => console.warn("voice files", e));
    await nvReady();
    NV.downloaded = true;
    prefs.set("engine", "natural");
    toast("Natural voice ready — it works offline now");
  } catch (e) {
    toast(navigator.onLine ? "Download failed: " + e.message : "You're offline — connect to download the voice", 4500);
  }
  NV.downloading = false;
  renderVoiceUI();
}
async function nvRemove() {
  if (T.playing && engine() === "natural") ttsStop();
  const done = new Promise((res) => (NV.removedResolve = res));
  nvWorker().postMessage({ type: "remove" });
  await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
  try { await caches.delete("shelf-voice"); } catch {}
  NV.worker?.terminate();
  NV.worker = null; NV.ready = null; NV.downloaded = false;
  nvClear();
  prefs.set("engine", "system");
  renderVoiceUI();
  renderStorage?.();
}
function wavBlob(pcm, rate) {
  const b = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); b.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVEfmt ");
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  str(36, "data"); b.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([b], { type: "audio/wav" });
}
function nvClip(key, text) {
  let c = NV.clips.get(key);
  if (!c) {
    c = { text };
    c.promise = new Promise((res, rej) => { c.resolve = res; c.reject = rej; });
    c.promise.catch(() => {});
    NV.clips.set(key, c);
  }
  return c;
}
// hand the worker the next sentence that's wanted and not made yet (one at a time, so a skip never waits behind stale work)
function nvPump() {
  if (NV.busy) return;
  const key = NV.want.find((k) => { const c = NV.clips.get(k); return c && !c.sent; });
  if (!key) return;
  const c = NV.clips.get(key);
  c.sent = true;
  NV.busy = key;
  nvReady().then(() => nvWorker().postMessage({ type: "speak", id: key, text: c.text, voice: key.split("|")[1] }), (e) => {
    NV.busy = null;
    for (const [k, x] of NV.clips) if (!x.url) { NV.clips.delete(k); x.reject(e); }
  });
}
// queue the current sentence and the next ~minute of reading; drop audio that's no longer needed
async function nvPlan() {
  const want = [];
  let page = T.page, idx = T.idx, sents = T.sents, chars = 0, pages = 0;
  const bookId = T.bookId;
  while (want.length < 10 && chars < 1100) {
    if (idx >= sents.length) {
      if (page >= R.book.pages || ++pages > 4) break;
      page++; idx = 0;
      sents = await sentencesFor(page);
      if (bookId !== T.bookId || !R.book) return;
      continue;
    }
    const key = nvKey(page, idx);
    nvClip(key, sents[idx].text);
    want.push(key);
    chars += sents[idx].text.length;
    idx++;
  }
  NV.want = want;
  const keep = new Set(want);
  for (const [k, c] of NV.clips) {
    if (keep.has(k) || k === NV.playingKey || k === NV.busy) continue;
    if (c.url) URL.revokeObjectURL(c.url);
    else c.reject(new Error("skipped"));
    NV.clips.delete(k);
  }
  nvPump();
}
function nvClear() {
  for (const c of NV.clips.values()) { if (c.url) URL.revokeObjectURL(c.url); else c.reject(new Error("cleared")); }
  NV.clips.clear();
  NV.want = [];
  NV.playingKey = null;
  NV.audio.removeAttribute("src");
}
NV.audio.addEventListener("ended", () => {
  if (T.playing && NV.playingGen === T.gen && engine() === "natural") advance();
});
NV.audio.addEventListener("pause", () => {
  // paused from outside the app (headphones out, a call, Control Center): reflect it
  if (T.playing && NV.playingGen === T.gen && !NV.audio.ended && NV.audio.currentTime > 0 && engine() === "natural") {
    T.playing = false; T.gen++; releaseWake(); updatePlayer();
  }
});
NV.audio.addEventListener("error", () => {
  if (T.playing && NV.playingGen === T.gen && engine() === "natural" && NV.audio.getAttribute("src")) { console.warn("audio", NV.audio.error); advance(); }
});

function renderVoiceUI() {
  const eng = prefs.get("engine", "system") === "natural" ? "natural" : "system";
  markSeg("#seg-engine", eng);
  $("#nv-box").hidden = eng !== "natural";
  $("#sys-box").hidden = eng !== "system";
  const dl = $("#nv-download");
  dl.hidden = NV.downloaded;
  dl.disabled = NV.downloading;
  if (!NV.downloading) dl.textContent = "Download natural voice · 92 MB";
  $("#nv-progress").hidden = !NV.downloading;
  if (!NV.downloading) $("#nv-progress i").style.width = "0";
  $("#nv-voice").hidden = !NV.downloaded;
  $("#nv-remove").hidden = !NV.downloaded;
  $("#nv-voice").innerHTML = NV_VOICES.map(([k, label]) => `<option value="${k}"${k === nvVoice() ? " selected" : ""}>${esc(label)}</option>`).join("");
}
nvCheck();

// ---- text → sentences, each with highlight boxes in page fractions
const ABBR = /^(mr|mrs|ms|dr|st|vs|etc|cf|fig|figs|no|vol|pp|p|e\.g|i\.e|inc|ltd|jr|sr|prof|ch|eq|approx)$/i;
function splitSentences(text) {
  const cuts = [];
  let start = 0, m;
  const re = /[.!?…]+["'”’)\]]*\s+/g;
  while ((m = re.exec(text))) {
    const prev = (text.slice(start, m.index).match(/(\S+)$/) || [, ""])[1];
    if (ABBR.test(prev.replace(/\.$/, "")) || /^[A-Z]$/.test(prev)) continue;
    cuts.push([start, m.index + m[0].length]);
    start = m.index + m[0].length;
  }
  if (start < text.length) cuts.push([start, text.length]);
  // merge fragments that are too short to stand alone; break up run-ons
  const out = [];
  for (const c of cuts) {
    const last = out[out.length - 1];
    if (last && text.slice(last[0], last[1]).trim().length < 24) last[1] = c[1];
    else out.push([...c]);
  }
  const final = [];
  for (let [a, b] of out) {
    while (b - a > 280) {
      const seg = text.slice(a, a + 280);
      let k = Math.max(seg.lastIndexOf("; "), seg.lastIndexOf(", "), seg.lastIndexOf(": "));
      if (k < 80) k = seg.lastIndexOf(" ");
      if (k < 40) k = 280;
      final.push([a, a + k + 1]);
      a += k + 1;
    }
    final.push([a, b]);
  }
  return final;
}

async function sentencesFor(i) {
  if (T.cache.has(i)) return T.cache.get(i);
  const pdf = R.pdf;
  const page = await pdf.getPage(i);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  let text = "";
  const runs = [];
  let prev = null;
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;
    const tx = pdfjsLib.Util.transform(vp.transform, it.transform);
    const fh = Math.hypot(tx[2], tx[3]) || 10;
    if (it.str) {
      // glue items on the same line with a space when the PDF left a visual gap but no space character
      if (prev && Math.abs(tx[5] - prev.base) < fh * 0.4 && tx[4] - prev.right > fh * 0.18 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
      else if (prev && Math.abs(tx[5] - prev.base) >= fh * 0.4 && text && !/\s$/.test(text)) text += " ";
      const start = text.length;
      text += it.str;
      runs.push({
        start, end: text.length,
        x: tx[4] / vp.width, y: (tx[5] - fh * 0.86) / vp.height,
        w: it.width / vp.width, h: (fh * 1.12) / vp.height,
      });
      prev = { base: tx[5], right: tx[4] + it.width };
    }
    if (it.hasEOL) {
      if (/\p{L}[-‐]$/u.test(text)) text = text.slice(0, -1); // re-join a word hyphenated across lines
      else if (text && !/\s$/.test(text)) text += " ";
      prev = null;
    }
  }
  const sents = [];
  for (const [a, b] of splitSentences(text)) {
    const t = text.slice(a, b).replace(/\s+/g, " ").trim();
    if (!/\p{L}/u.test(t)) continue; // page numbers, stray symbols
    const boxes = [];
    for (const r of runs) {
      if (r.end <= a || r.start >= b) continue;
      const len = Math.max(1, r.end - r.start);
      const f0 = Math.max(0, (a - r.start) / len), f1 = Math.min(1, (b - r.start) / len);
      boxes.push({ x: r.x + r.w * f0, y: r.y, w: r.w * (f1 - f0), h: r.h });
    }
    if (!boxes.length) continue;
    sents.push({ text: t, boxes, top: Math.min(...boxes.map((x) => x.y)), bottom: Math.max(...boxes.map((x) => x.y + x.h)) });
  }
  // drop running heads / footers: a short line hugging the top or bottom edge with no sentence ending
  const edge = (s) => s.text.length < 60 && !/[.!?…]["'”’)]*$/.test(s.text) && (s.bottom < 0.1 || s.top > 0.9);
  while (sents.length && edge(sents[0])) sents.shift();
  while (sents.length && edge(sents[sents.length - 1])) sents.pop();
  if (pdf === R.pdf) T.cache.set(i, sents);
  return sents;
}

// ---- geometry helpers
function pageInnerY(page, f) {
  const el = R.pageEls[page - 1];
  const inner = el.lastElementChild;
  return el.offsetTop + inner.offsetTop + f * inner.offsetHeight;
}
function viewFrac() {
  // the first line of text visible below the top bar
  const y = scroller.scrollTop + 64;
  const k = pageIndexAtY(y);
  const el = R.pageEls[k], inner = el.lastElementChild;
  return { page: k + 1, f: (y - el.offsetTop - inner.offsetTop) / inner.offsetHeight };
}
function onScreen(page, s) {
  if (!s) return false;
  const y = pageInnerY(page, s.top);
  return y > scroller.scrollTop && y < scroller.scrollTop + scroller.clientHeight;
}
function follow(s, force) {
  if (!s || !R.book) return;
  if (!force && Date.now() - T.userScrollAt < 6000) return; // the reader is looking elsewhere; don't yank them back
  const y = pageInnerY(T.page, s.top);
  const st = scroller.scrollTop, h = scroller.clientHeight;
  if (!force && y > st + 70 && pageInnerY(T.page, s.bottom) < st + h * 0.72) return;
  T.progScrollUntil = Date.now() + 1200;
  scroller.scrollTo({ top: y - h * 0.3, behavior: "smooth" });
}
function drawTts(s) {
  if (T.hlPage) { const old = R.pageEls[T.hlPage - 1]?.querySelector(".tts-hl"); if (old) old.innerHTML = ""; }
  T.hlPage = 0;
  if (!s || !R.book) return;
  const layer = R.pageEls[T.page - 1]?.querySelector(".tts-hl");
  if (!layer) return;
  layer.innerHTML = s.boxes.map((b) => `<div class="tts-box" style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%"></div>`).join("");
  T.hlPage = T.page;
}

// ---- playback
function speakCurrent(retry = false) {
  if (engine() === "natural") return nvSpeakCurrent();
  const s = T.sents[T.idx];
  if (!s) return;
  const gen = ++T.gen;
  const u = new SpeechSynthesisUtterance(s.text);
  const v = currentVoice();
  if (v) { try { u.voice = v; u.lang = v.lang; } catch {} }
  u.rate = prefs.get("rate", 1);
  u.onstart = () => { if (gen === T.gen) T.started = true; };
  u.onend = () => { if (gen === T.gen && T.playing) advance(); };
  u.onerror = (e) => {
    if (gen !== T.gen || !T.playing || e.error === "interrupted" || e.error === "canceled") return;
    if (e.error === "not-allowed") { ttsPause(); toast("Tap play to start reading aloud"); return; }
    console.warn("tts", e.error);
    advance();
  };
  T.utter = u; // keep a reference: Chrome drops events for garbage-collected utterances
  T.started = false;
  if (synth.speaking || synth.pending) {
    synth.cancel();
    setTimeout(() => { if (gen === T.gen && T.playing) synth.speak(u); }, 60);
  } else synth.speak(u);
  // a wedged speech engine never starts and never errors — retry once, then say so instead of hanging
  setTimeout(() => {
    if (gen !== T.gen || !T.playing || T.started || document.hidden) return;
    if (!retry) { try { synth.cancel(); } catch {} return speakCurrent(true); }
    ttsPause();
    toast("The device's speech engine isn't responding — try again, or restart the app", 4500);
  }, 4000);
  drawTts(s);
  follow(s);
  updatePlayer();
}

async function nvSpeakCurrent() {
  const s = T.sents[T.idx];
  if (!s) return;
  const gen = ++T.gen;
  const key = nvKey(T.page, T.idx);
  const c = nvClip(key, s.text);
  drawTts(s);
  follow(s);
  nvPlan();
  setBuffering(!c.url);
  updatePlayer();
  let url;
  try { url = await c.promise; } catch (e) {
    if (gen !== T.gen || !T.playing) return;
    ttsPause();
    toast("Couldn't read this aloud: " + e.message, 4500);
    return;
  }
  if (gen !== T.gen || !T.playing) return;
  setBuffering(false);
  const a = NV.audio;
  NV.playingKey = key;
  NV.playingGen = gen;
  a.src = url;
  a.playbackRate = prefs.get("rate", 1);
  a.play().catch((e) => {
    if (gen !== T.gen) return;
    console.warn("play", e);
    ttsPause();
    toast("Tap play to keep listening");
  });
}
function setBuffering(on) { $("#player").classList.toggle("buffering", on && T.playing); }

async function advance() {
  T.idx++;
  let empties = 0;
  while (T.idx >= T.sents.length) {
    if (T.page >= R.book.pages) { ttsPause(); drawTts(null); toast("Finished — end of the book"); return; }
    if (++empties > 8) { ttsPause(); toast("No readable text here — this part may be a scanned image", 4000); return; }
    const gen = T.gen;
    T.page++;
    T.idx = 0;
    T.sents = await sentencesFor(T.page);
    if (gen !== T.gen || !T.playing) return;
  }
  speakCurrent();
  if (T.idx >= T.sents.length - 3 && T.page < R.book.pages) sentencesFor(T.page + 1).catch(() => {});
}

async function ttsPlay() {
  const natural = engine() === "natural";
  if (!natural && !synth) return toast("This browser can't read aloud");
  // iOS only lets sound start inside a tap, so wake the right engine now, before any await
  if (natural) {
    const a = NV.audio;
    if (NV.playingKey && NV.playingKey === nvKey(T.page, T.idx) && a.getAttribute("src") && !a.ended && T.bookId === R.book.id) {
      T.playing = true;
      NV.playingGen = ++T.gen;
      a.playbackRate = prefs.get("rate", 1);
      a.play().catch(() => {});
      $("#player").hidden = false;
      acquireWake();
      updatePlayer();
      drawTts(T.sents[T.idx]);
      nvPlan();
      return;
    }
    try { a.src = SILENCE; a.play().catch(() => {}); } catch {}
  } else {
    try { const w = new SpeechSynthesisUtterance(" "); w.volume = 0; synth.speak(w); } catch {}
  }
  T.playing = true;
  $("#player").hidden = false;
  updatePlayer();
  acquireWake();
  const gen = ++T.gen;
  const resume = T.bookId === R.book.id && T.sents[T.idx] && onScreen(T.page, T.sents[T.idx]);
  if (resume) return speakCurrent();
  if (T.bookId !== R.book.id) nvClear();
  T.bookId = R.book.id;
  const v = viewFrac();
  const sents = await sentencesFor(v.page);
  if (gen !== T.gen || !T.playing) return;
  T.page = v.page;
  T.sents = sents;
  const k = sents.findIndex((s) => s.top >= v.f - 0.01);
  T.idx = (k === -1 ? sents.length : k) - 1;
  T.userScrollAt = 0;
  advance();
}
function ttsPause() {
  T.playing = false;
  T.gen++;
  try { synth?.cancel(); } catch {}
  try { NV.audio.pause(); } catch {}
  setBuffering(false);
  releaseWake();
  updatePlayer();
}
function ttsStop() {
  ttsPause();
  drawTts(null);
  nvClear();
  $("#player").hidden = true;
}
async function ttsSkip(dir) {
  if (!T.sents.length) return;
  if (dir > 0) {
    if (T.playing) { T.gen++; return advance(); }
    if (T.idx < T.sents.length - 1) T.idx++;
    else if (T.page < R.book.pages) { T.page++; T.sents = await sentencesFor(T.page); T.idx = 0; }
  } else {
    if (T.idx > 0) T.idx--;
    else if (T.page > 1) { T.page--; T.sents = await sentencesFor(T.page); T.idx = Math.max(0, T.sents.length - 1); }
  }
  if (T.playing) speakCurrent();
  else { NV.playingKey = null; drawTts(T.sents[T.idx]); follow(T.sents[T.idx], true); }
}
function updatePlayer() {
  const btn = $("#tts-play");
  btn.innerHTML = T.playing
    ? `<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>`
    : `<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>`;
  btn.setAttribute("aria-label", T.playing ? "Pause" : "Play");
  $("#tts-rate").textContent = prefs.get("rate", 1) + "×";
  $("#btn-listen").classList.toggle("on", T.playing);
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = T.playing ? "playing" : "paused";
      if (R.book) navigator.mediaSession.metadata = new MediaMetadata({
        title: R.book.title, artist: R.book.author || "Shelf", album: `Page ${T.page || 1} of ${R.book.pages}`,
        artwork: [{ src: "icon-192.png", sizes: "192x192", type: "image/png" }],
      });
    } catch {}
  }
}
async function acquireWake() { try { T.wake = await navigator.wakeLock?.request("screen"); } catch {} }
function releaseWake() { try { T.wake?.release(); } catch {} T.wake = null; }

$("#btn-listen").addEventListener("click", () => { if (T.playing) ttsPause(); else ttsPlay(); });
$("#tts-play").addEventListener("click", () => { if (T.playing) ttsPause(); else ttsPlay(); });
$("#tts-prev").addEventListener("click", () => ttsSkip(-1));
$("#tts-next").addEventListener("click", () => ttsSkip(1));
$("#tts-close").addEventListener("click", ttsStop);
$("#tts-rate").addEventListener("click", () => {
  const r = prefs.get("rate", 1);
  const next = RATES[(RATES.indexOf(r) + 1) % RATES.length] || 1;
  prefs.set("rate", next);
  updatePlayer();
  if (engine() === "natural") NV.audio.playbackRate = next;
  else if (T.playing) speakCurrent();
});
$("#voice-select").addEventListener("change", (e) => {
  prefs.set("voice", e.target.value);
  if (T.playing) return speakCurrent();
  try {
    synth.cancel();
    const u = new SpeechSynthesisUtterance("This is how I'll read your book.");
    const v = currentVoice();
    if (v) { try { u.voice = v; u.lang = v.lang; } catch {} }
    u.rate = prefs.get("rate", 1);
    synth.speak(u);
  } catch {}
});
$("#seg-engine").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const was = engine();
  if (T.playing) ttsPause();
  prefs.set("engine", b.dataset.v);
  if (b.dataset.v === "system") refreshVoices();
  if (was !== engine()) nvClear();
  renderVoiceUI();
});
$("#nv-download").addEventListener("click", nvDownload);
$("#nv-remove").addEventListener("click", () => { if (confirm("Remove the natural voice from this device? You can download it again later.")) nvRemove(); });
$("#nv-voice").addEventListener("change", async (e) => {
  prefs.set("nvVoice", e.target.value);
  const playing = T.playing;
  if (playing) ttsPause();
  nvClear();
  if (playing) return ttsPlay();
  // a short sample, so you can hear the voice you picked
  try {
    const a = NV.audio;
    a.src = SILENCE; a.play().catch(() => {});
    const key = `sample|${nvVoice()}|0|0`;
    const c = nvClip(key, "This is how I'll read your book.");
    NV.want = [key]; nvPump();
    const url = await c.promise;
    if (T.playing) return;
    a.src = url; a.playbackRate = 1; a.play().catch(() => {});
  } catch {}
});
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () => R.book && ttsPlay());
    navigator.mediaSession.setActionHandler("pause", ttsPause);
    navigator.mediaSession.setActionHandler("nexttrack", () => ttsSkip(1));
    navigator.mediaSession.setActionHandler("previoustrack", () => ttsSkip(-1));
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  refreshVoices(); // a voice downloaded in iOS Settings while we were away
  if (!T.playing) return;
  acquireWake();
  if (engine() === "natural") { drawTts(T.sents[T.idx]); follow(T.sents[T.idx]); return; } // kept playing while away
  if (!synth.speaking && !synth.pending) speakCurrent(); // the OS paused us while away — pick the sentence back up
});
// safety net: some engines finish an utterance without ever firing "end"
setInterval(() => {
  if (engine() === "system" && T.playing && T.started && !document.hidden && !synth.speaking && !synth.pending) { T.started = false; advance(); }
}, 1500);

// ---------------------------------------------------------------- close
async function closeReader() {
  if (!R.book) return;
  ttsStop();
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
