// Shelf natural voice: the Kokoro-82M text-to-speech model, run on the phone itself (ONNX Runtime).
// Two ways to run it: on the graphics chip (WebGPU, full-precision model) where the phone offers it, many times
// faster; otherwise on the processor (WebAssembly, 8-bit model). A failed GPU start falls back to the processor.
// (Tested on WebGPU: the half-precision and uint8 builds of the model come out as silence or NaN after a couple of
// seconds, and the 8-bit build falls back to the processor; only the full-precision build works there.)
// It turns a passage of one to a few sentences into 24 kHz audio, and says how many phonemes each sentence
// took, so the app can tell where in the audio each sentence starts. The main thread plays that through an ordinary <audio> element,
// which (unlike the built-in speech API) keeps playing while another app is open or the screen is locked.
//
// The model (~92 MB) is downloaded once from Hugging Face and kept in Cache Storage. Everything else is in
// the repo under vendor/.
// Messages in:  {type:"load", threads, device:"gpu"|"cpu"}  {type:"speak", id, texts:[…], voice}  {type:"remove"}
// Messages out: {type:"progress", loaded, total}  {type:"stage", stage}  {type:"ready", threads, device, model}
//               {type:"audio", id, pcm, rate, parts}  {type:"gpu-failed", message}  {type:"error", id?, message, stage}
// "stage" says how far start-up got, so the app can tell a stall apart from a slow phone and say where it stuck.
import "./vendor/stream-iterator.js"; // first: the phonemizer needs it while it loads (Safari)
import { phonemize } from "./vendor/phonemizer/phonemizer.js";

const HF = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/";
const MODELS = {
  cpu: new URL(import.meta.url).searchParams.get("model") || HF + "model_quantized.onnx", // ?model= is for local testing only
  gpu: HF + "model.onnx",
};
const MIN_BYTES = { cpu: 50e6, gpu: 250e6 }, GUESS = { cpu: 92361116, gpu: 325532387 };
const CACHE = "shelf-voice";
const SAMPLE_RATE = 24000;

let ort = null, session = null, vocab = null, loading = null, stage = "starting", device = "cpu";
const setStage = (post, st) => { stage = st; post({ type: "stage", stage: st }); };
// anything that escapes a handler still reaches the app instead of failing silently
const fail = (e) => self.postMessage({ type: "error", message: String(e?.message || e || "unknown error"), stage });
self.addEventListener("error", (e) => fail(e.message || e.error));
self.addEventListener("unhandledrejection", (e) => fail(e.reason));
const styles = new Map();

// ---- download the model once, with progress, then keep it in Cache Storage
// read a response body in chunks so the app can show how far along it is ("download" or "load" from storage)
async function readAll(res, total, phase, post) {
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let loaded = 0, parts = null, lastPost = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!parts && loaded + value.length <= buf.length) buf.set(value, loaded);
    else { parts ||= [buf.subarray(0, loaded)]; parts.push(value); } // content-length was wrong; fall back
    loaded += value.length;
    if (Date.now() - lastPost > 150) { post({ type: "progress", phase, loaded, total }); lastPost = Date.now(); }
  }
  post({ type: "progress", phase, loaded, total: loaded });
  return parts ? new Uint8Array(await new Blob(parts).arrayBuffer()) : buf.subarray(0, loaded);
}
async function modelBytes(post, dev) {
  const url = MODELS[dev];
  const cache = await caches.open(CACHE);
  const hit = await cache.match(url);
  if (hit) {
    setStage(post, "load");
    return readAll(hit, +hit.headers.get("content-length") || GUESS[dev], "load", post);
  }
  setStage(post, "download");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = await readAll(res, +res.headers.get("content-length") || GUESS[dev], "download", post);
  if (bytes.length < MIN_BYTES[dev]) throw new Error("Download was incomplete — try again on Wi-Fi");
  await cache.put(url, new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } }));
  return bytes;
}

async function gpuUsable() {
  try { return !!(navigator.gpu && (await navigator.gpu.requestAdapter())); } catch { return false; }
}
// a real sentence, checked all the way through: a broken GPU path can start speaking and then go silent or NaN
function soundsRight(pcm) {
  let last = 0;
  for (let k = 0; k < pcm.length; k++) { const v = pcm[k]; if (Number.isNaN(v)) return false; if (Math.abs(v) > 0.05) last = k; }
  return pcm.length > SAMPLE_RATE && last > pcm.length * 0.7;
}

async function start(post, dev, threads) {
  ort = dev === "gpu" ? await import("./vendor/ort-gpu/ort.webgpu.min.mjs") : await import("./vendor/ort/ort.wasm.min.mjs");
  ort.env.wasm.wasmPaths = new URL(dev === "gpu" ? "./vendor/ort-gpu/" : "./vendor/ort/", import.meta.url).href;
  // several threads only where the page is cross-origin isolated and the app asked for them
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(4, threads)) : 1;
  const bytes = await modelBytes(post, dev);
  setStage(post, "engine");
  const s = await ort.InferenceSession.create(bytes, { executionProviders: [dev === "gpu" ? "webgpu" : "wasm"], graphOptimizationLevel: "all" });
  // prove the whole chain works (text → phonemes → model → audio) before saying we're ready. On the GPU this
  // also compiles its programs, so the first real sentence isn't slow.
  setStage(post, "test");
  session = s;
  device = dev;
  const test = await speak({ texts: dev === "gpu" ? ["Ready to read whenever you are, from the very first page of the book to the very last one."] : ["Ready."], voice: "af_heart" });
  if (!test.pcm.length || (dev === "gpu" ? !soundsRight(test.pcm) : !(Math.abs(test.pcm[test.pcm.length >> 1]) < 10))) throw new Error("the voice produced no sound");
}

async function load(post, threads = 1, want = "cpu") {
  if (session) return;
  if (!loading) {
    loading = (async () => {
      vocab = await (await fetch(new URL("./vendor/kokoro/vocab.json", import.meta.url))).json();
      if (want === "gpu" && (await gpuUsable())) {
        try { await start(post, "gpu", threads); setStage(post, "ready"); return; }
        catch (e) { session = null; post({ type: "gpu-failed", message: String(e?.message || e) }); }
      }
      await start(post, "cpu", threads);
      setStage(post, "ready");
    })().catch((e) => { loading = null; session = null; throw e; });
  }
  await loading;
}

async function style(voice) {
  if (!styles.has(voice)) {
    const r = await fetch(new URL(`./vendor/kokoro/voices/${voice}.bin`, import.meta.url));
    if (!r.ok) throw new Error("Unknown voice " + voice);
    styles.set(voice, new Float32Array(await r.arrayBuffer()));
  }
  return styles.get(voice);
}

// ---- text → phonemes → token ids
function normalize(t) {
  return t
    .replace(/[‘’]/g, "'").replace(/[“”«»]/g, '"')
    .replace(/\(/g, "«").replace(/\)/g, "»")
    .replace(/\bDr\.(?= [A-Z])/g, "Doctor").replace(/\bMr\./g, "Mister").replace(/\bMs\./g, "Miss").replace(/\bMrs\./g, "Missus")
    .replace(/\bSt\.(?= [A-Z])/g, "Saint").replace(/\betc\./gi, "etcetera").replace(/\be\.g\./gi, "for example").replace(/\bi\.e\./gi, "that is")
    .replace(/(?<=\d),(?=\d{3}\b)/g, "")
    .replace(/(?<=\d)-(?=\d)/g, " to ")
    .replace(/[–—]/g, "—")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}
const PUNCT = /(\s*[;:,.!?¡¿—…"«»“”(){}\[\]]+\s*)+/g;
async function toPhonemes(text, lang) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(PUNCT)) {
    if (m.index > last) parts.push({ p: false, t: text.slice(last, m.index) });
    parts.push({ p: true, t: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ p: false, t: text.slice(last) });
  const out = await Promise.all(parts.map(async ({ p, t }) => (p ? t : (await phonemize(t, lang)).join(" "))));
  let ph = out.join("")
    .replace(/ʲ/g, "j").replace(/r/g, "ɹ").replace(/x/g, "k").replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  if (lang === "en-us") ph = ph.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di");
  return ph.trim();
}

// A passage is read in one go, so the voice carries its rhythm from one sentence into the next. "parts" is how
// many tokens each sentence became; the app uses it to find where each sentence starts in the audio.
async function speak({ texts, text, voice }) {
  texts = texts || [text];
  const lang = voice[0] === "b" ? "en" : "en-us";
  const space = vocab[" "];
  const ids = [], parts = [];
  for (const [k, t] of texts.entries()) {
    const ph = await toPhonemes(normalize(t), lang);
    const before = ids.length;
    if (k && space !== undefined) ids.push(space);
    for (const ch of ph) { const id = vocab[ch]; if (id !== undefined) ids.push(id); }
    parts.push(ids.length - before);
  }
  ids.length = Math.min(ids.length, 510);
  if (!ids.length) return { pcm: new Float32Array(0), parts };
  const ref = await style(voice);
  const s = ref.slice(ids.length * 256, ids.length * 256 + 256);
  const tokens = BigInt64Array.from([0, ...ids, 0], BigInt);
  const feeds = {
    input_ids: new ort.Tensor("int64", tokens, [1, tokens.length]),
    style: new ort.Tensor("float32", s, [1, 256]),
    speed: new ort.Tensor("float32", new Float32Array([1]), [1]),
  };
  const res = await session.run(feeds);
  return { pcm: res.waveform.data.slice(), parts };
}

// one job at a time: the main thread decides what to synthesize next
self.onmessage = async ({ data: m }) => {
  const post = (x, t) => self.postMessage(x, t || []);
  try {
    if (m.type === "load") {
      await load(post, m.threads, m.device);
      post({ type: "ready", threads: ort.env.wasm.numThreads, device, model: MODELS[device] });
    } else if (m.type === "speak") {
      await load(post, 1, m.device);
      const { pcm, parts } = await speak(m);
      post({ type: "audio", id: m.id, pcm, rate: SAMPLE_RATE, parts }, [pcm.buffer]);
    } else if (m.type === "remove") {
      await caches.delete(CACHE);
      session = null; loading = null;
      post({ type: "removed" });
    }
  } catch (e) {
    post({ type: "error", id: m.id, message: String(e?.message || e), stage });
  }
};
