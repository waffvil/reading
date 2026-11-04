// Shelf fast natural voice: a Piper voice (VITS), run on the phone itself with ONNX Runtime (WebAssembly).
// Several times lighter than Kokoro (voice-worker.js), so it keeps up with playback on a phone; it sounds a
// little less lifelike. Same messages as voice-worker.js, so the app treats both alike:
// Messages in:  {type:"load", threads, voice}  {type:"speak", id, text, voice}  {type:"remove"}
// Messages out: {type:"progress", phase, loaded, total}  {type:"stage", stage}  {type:"ready", threads}
//               {type:"audio", id, pcm, rate}  {type:"error", id?, message, stage}
// Each voice is a model (~63 MB) plus a small JSON config, downloaded once from Hugging Face (rhasspy/piper-voices)
// and kept in Cache Storage.
import "./vendor/stream-iterator.js"; // first: the phonemizer needs it while it loads (Safari)
import * as ort from "./vendor/ort/ort.wasm.min.mjs";
import { phonemize } from "./vendor/phonemizer/phonemizer.js";

const BASE = new URL(import.meta.url).searchParams.get("base") || // ?base= is for local testing only
  "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const CACHE = "shelf-voice";

ort.env.wasm.wasmPaths = new URL("./vendor/ort/", import.meta.url).href;

let session = null, config = null, loading = null, loadedVoice = null, stage = "starting";
const setStage = (post, st) => { stage = st; post({ type: "stage", stage: st }); };
const fail = (e) => self.postMessage({ type: "error", message: String(e?.message || e || "unknown error"), stage });
self.addEventListener("error", (e) => fail(e.message || e.error));
self.addEventListener("unhandledrejection", (e) => fail(e.reason));

// "en_US-lessac-medium" → en/en_US/lessac/medium/en_US-lessac-medium.onnx
export function voiceUrl(voice) {
  const [loc, name, quality] = voice.split("-");
  return `${BASE}${loc.split("_")[0]}/${loc}/${name}/${quality}/${voice}.onnx`;
}

async function readAll(res, total, phase, post) {
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let loaded = 0, parts = null, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!parts && loaded + value.length <= buf.length) buf.set(value, loaded);
    else { parts ||= [buf.subarray(0, loaded)]; parts.push(value); }
    loaded += value.length;
    if (Date.now() - lastPost > 150) { post({ type: "progress", phase, loaded, total }); lastPost = Date.now(); }
  }
  post({ type: "progress", phase, loaded, total: loaded });
  return parts ? new Uint8Array(await new Blob(parts).arrayBuffer()) : buf.subarray(0, loaded);
}
async function cached(url, post, big) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) {
    if (!big) return new Uint8Array(await hit.arrayBuffer());
    setStage(post, "load");
    return readAll(hit, +hit.headers.get("content-length") || 63e6, "load", post);
  }
  if (big) setStage(post, "download");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = big ? await readAll(res, +res.headers.get("content-length") || 63e6, "download", post) : new Uint8Array(await res.arrayBuffer());
  if (big && bytes.length < 5e6) throw new Error("Download was incomplete — try again on Wi-Fi");
  await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } }));
  return bytes;
}

async function load(post, threads = 1, voice) {
  if (session && loadedVoice === voice) return;
  if (!loading) {
    loading = (async () => {
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, threads)) : 1;
      const url = voiceUrl(voice);
      config = JSON.parse(new TextDecoder().decode(await cached(url + ".json", post, false)));
      if (!config.phoneme_id_map) throw new Error("this voice's settings file is unreadable");
      const bytes = await cached(url, post, true);
      setStage(post, "engine");
      const s = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
      setStage(post, "test");
      session = s; loadedVoice = voice;
      const test = await speak({ text: "Ready." });
      if (!test.length) throw new Error("the voice produced no sound");
      setStage(post, "ready");
    })().catch((e) => { loading = null; session = null; throw e; });
  }
  await loading;
}

function normalize(t) {
  return t
    .replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"')
    .replace(/\bDr\.(?= [A-Z])/g, "Doctor").replace(/\bMr\./g, "Mister").replace(/\bMs\./g, "Miss").replace(/\bMrs\./g, "Missus")
    .replace(/\bSt\.(?= [A-Z])/g, "Saint").replace(/\betc\./gi, "etcetera").replace(/\be\.g\./gi, "for example").replace(/\bi\.e\./gi, "that is")
    .replace(/(?<=\d),(?=\d{3}\b)/g, "")
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/[–—]/g, ", ")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}
// espeak (via the phonemizer) drops punctuation, but Piper voices use it for pauses and intonation:
// phonemize the words between punctuation marks and put the marks back
const PUNCT = /(\s*[;:,.!?¡¿…"()]+\s*)+/g;
async function toPhonemes(text) {
  const lang = config.espeak?.voice || "en-us";
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT)) {
    if (m.index > last) parts.push({ p: false, t: text.slice(last, m.index) });
    parts.push({ p: true, t: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ p: false, t: text.slice(last) });
  const out = await Promise.all(parts.map(async ({ p, t }) => (p ? t.replace(/\s+/g, " ") : (await phonemize(t, lang)).join(" "))));
  return out.join("").trim();
}

async function speak({ text }) {
  const map = config.phoneme_id_map;
  const pad = map._?.[0] ?? 0, bos = map["^"]?.[0] ?? 1, eos = map.$?.[0] ?? 2;
  const ph = await toPhonemes(normalize(text));
  // Piper's layout: start, then every phoneme followed by the pad symbol, then end
  const ids = [bos, pad];
  for (const ch of ph) { const id = map[ch]; if (id) { ids.push(...id, pad); } }
  ids.push(eos);
  if (ids.length <= 3) return new Float32Array(0);
  const inf = config.inference || {};
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([ids.length], BigInt), [1]),
    scales: new ort.Tensor("float32", new Float32Array([inf.noise_scale ?? 0.667, inf.length_scale ?? 1, inf.noise_w ?? 0.8]), [3]),
  };
  if ((config.num_speakers || 1) > 1 && session.inputNames.includes("sid")) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([0n]), [1]);
  const res = await session.run(feeds);
  return res[session.outputNames[0]].data.slice();
}

self.onmessage = async ({ data: m }) => {
  const post = (x, t) => self.postMessage(x, t || []);
  try {
    if (m.type === "load") { await load(post, m.threads, m.voice); post({ type: "ready", threads: ort.env.wasm.numThreads }); }
    else if (m.type === "speak") {
      await load(post, 1, m.voice);
      const pcm = await speak(m);
      post({ type: "audio", id: m.id, pcm, rate: config.audio?.sample_rate || 22050 }, [pcm.buffer]);
    } else if (m.type === "remove") {
      await caches.delete(CACHE);
      session = null; loading = null;
      post({ type: "removed" });
    }
  } catch (e) {
    post({ type: "error", id: m.id, message: String(e?.message || e), stage });
  }
};
