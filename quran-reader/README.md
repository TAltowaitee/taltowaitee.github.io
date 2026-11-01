# قارئ الآيات — Quran Verse Reader

Open an Arabic PDF book, read it page by page, and play any Quran verse cited on the page
(Husary murattal by default). Everything runs in the browser; the PDF never leaves the device.

## How it works

| File | Job |
|---|---|
| `index.html`, `style.css` | Arabic right-to-left UI, light/dark, phone layout |
| `js/app.js` | Opens the PDF, renders pages, shows each page's verse list, saves user edits |
| `js/detect.js` | Finds citations like `[فصلت: ٤١-٤٢]` in the PDF text, even when the text layer is damaged |
| `js/player.js` | Plays ayah ranges one by one from everyayah.com; fetches the ayah text from alquran.cloud |
| `js/surahs.js` | The 114 surah names and ayah counts |
| `js/library.js` | The built-in books on the home screen (hard-coded for now; a database will replace it) |
| `books/*.pdf` | Built-in book files: «الدليل إلى القرآن» parts 1 (p. 11–34) and 2 (p. 35–57) |
| `books/<fingerprint>.json` | Hand-checked verse list for a specific book (loads automatically when that PDF is opened) |
| `vendor/` | pdf.js 4.10.38 (Apache-2.0), bundled so there's no CDN dependency |

**Focus mode** (⛶ on the page, or `F`): the page fills the screen; tap it to show/hide the verse chips, player and page controls; swipe to turn pages; `Esc` or ✕ to exit. Portrait shows the whole page; landscape fills the width and scrolls.

**Repeat** (player): one button cycles off → repeat the range → repeat the current ayah; the choice is remembered.

A page's verses come from, in order: **the user's edits** → **a hand-checked book list** → **auto-detection**.
Auto-detected verses the app isn't sure about are flagged «تحقّق» and can be fixed with ✎.

Reloading while reading a built-in book reopens it on the same page (the URL holds `#book=<id>`;
the page is remembered per book in localStorage). Books opened from the device can't be reopened
after a reload yet: the browser doesn't keep the file.

## Adding a built-in book

1. Put the PDF in `books/`, add an entry to `js/library.js`.
2. Add its hand-checked verse list as `books/<fingerprint>.json` (see below).

## Adding a hand-checked list for another book

1. Open the book in the app, then find its fingerprint in DevTools → Application → Local Storage:
   the key looks like `quran-reader:<fingerprint>`.
2. Create `books/<fingerprint>.json` with `{ "title", "author", "pages": { "<page>": [[surah, from, to], ...] } }`.

## Tests

```bash
node --test tests/*.test.mjs            # detector unit tests (incl. a real text PDF)
node tests/eval-pdf.mjs path/to/book.pdf # score detection on a real PDF against tests/groundtruth.mjs
```

Run locally: `python3 -m http.server` from the repo root, then open `http://localhost:8000/quran-reader/`.
