# Shelf

A free, offline PDF reader for your phone. A home-screen app, hosted on GitHub Pages.

- **Offline:** the app and its PDF engine (pdf.js) are cached by the service worker. Each book is copied
  into the phone's own storage (IndexedDB) when you add it, so it opens with no signal at all.
- **Remembers your place:** your position is saved as you scroll, down to the spot on the page.
- **Bookmarks:** long-press any word to bookmark it. It's highlighted on the page and listed, with the
  surrounding sentence, under ☰ → Bookmarks. The ribbon button bookmarks the top of the screen.
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
