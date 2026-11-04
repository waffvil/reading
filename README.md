# Shelf

A free, offline PDF reader for your phone. A home-screen app, hosted on GitHub Pages.

- **Offline:** the app and its PDF engine (pdf.js) are cached by the service worker. Each book is copied
  into the phone's own storage (IndexedDB) when you add it, so it opens with no signal at all.
- **Remembers your place:** your position is saved as you scroll, down to the spot on the page.
- **Bookmarks:** long-press any word to bookmark it. It's highlighted on the page and listed, with the
  surrounding sentence, under ☰ → Bookmarks. The ribbon button bookmarks the top of the screen.
- **Read aloud (audiobook mode):** tap the headphones. It reads from the first line on screen, one
  sentence at a time, highlighting each sentence, following along and turning pages by itself. There's a
  player with back, play/pause, next and speed (0.8–2×). Two kinds of voice, picked in Aa:
  - **Natural** (recommended): lifelike voices that run on the phone itself. They **keep reading when you
    switch apps or lock the screen**, with lock-screen and headphone controls, like an audiobook. Tap ▶ next
    to any voice to hear a preview before downloading it; once downloaded it works offline.
    - **Fast** (Piper): sixteen American and British voices, 63 MB each, downloaded one at a time. Light enough
      to play smoothly on a phone.
    - **Most natural** (Kokoro): seven voices sharing one 92 MB download. They sound the best but are heavy
      for a phone, so there may be pauses between sentences.
  - **Device voices:** the phone's built-in voices. Instant and free, but iOS stops them when Shelf leaves
    the screen. After downloading a better one (Settings → Accessibility → Spoken Content → Voices),
    fully close Shelf and reopen it; Premium/Enhanced voices are labelled. Apple doesn't give web apps
    Siri voices, and some downloaded voices may not appear either.

  Running headers (book or chapter titles) and page numbers are skipped: Aa → "Skip page edges" sets top
  and/or bottom and how big a strip, and shows the strip on the page when you change it.

  Scanned PDFs (images, no text layer) can't be read aloud.
- **Reading comfort:** Light, Sepia and Dark themes; pinch to zoom; "Trim margins" makes small print
  larger on a phone; a table of contents (when the PDF has one); a page slider.

## Install on iPhone
1. Open the site in **Safari** and tap Share → **Add to Home Screen**.
2. Open Shelf from the home screen, tap **Add PDF**, and pick the file from Files, Downloads or iCloud Drive.
3. That's it. The book is on the phone now, and airplane mode is fine.

Books stay on that one device. Adding the same PDF on another device gives it its own copy and its own
reading position.

## Hosting books with the app (optional)
Files listed in `books/library.json` show up under "Available to download":

```json
{ "books": [ { "file": "meditations.pdf", "title": "Meditations", "author": "Marcus Aurelius" } ] }
```

**The repo is public, so only put public-domain or freely licensed PDFs here.** `*.pdf` is git-ignored so
a purchased book can't be published by accident. Add a free one deliberately with `git add -f books/x.pdf`.

## Developing
Plain static files, with no build step. Serve locally with `python3 -m http.server 8931`.
After changing any shipped file, bump `VERSION` in `sw.js` so phones pick up the new version. Run
`scripts/precache.sh` if you add files the app needs offline.

### Natural voice internals
`voice-worker.js` runs [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0, 8-bit ONNX build
from `onnx-community/Kokoro-82M-v1.0-ONNX`); `piper-worker.js` runs [Piper](https://github.com/rhasspy/piper)
voices (from `rhasspy/piper-voices`, each with its own license listed there). Both use ONNX Runtime Web (MIT,
`vendor/ort/`) and turn text into phonemes with `phonemizer` (`vendor/phonemizer/`, which bundles eSpeak NG,
GPL-3.0). `vendor/stream-iterator.js` adds a stream feature Safari lacks, which the phonemizer needs.
Kokoro voice styles and preview clips are in `vendor/kokoro/`; Piper previews play from Hugging Face. Models
aren't in the repo: the app downloads each on request and keeps it, with the code above, in the `shelf-voice`
cache, which survives app updates. Bump `NV_REV` in `app.js` whenever a worker changes. The service worker adds
cross-origin isolation headers so the models can use several CPU cores.
