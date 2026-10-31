// قارئ الآيات - main app: opens a PDF, shows it page by page, lists the Quran verses
// cited on each page, and plays them.
//
// Where a page's verse list comes from (first match wins):
//   1. the user's own edits      (saved in this browser's localStorage)
//   2. a reviewed index for this exact book   (books/<pdf-fingerprint>.json)
//   3. automatic detection from the PDF text  (js/detect.js)

import * as pdfjsLib from '../vendor/pdf.mjs';
import { findCitations, itemsToLines } from './detect.js';
import { SURAHS, surahName, ayahCount } from './surahs.js';
import { VersePlayer, RECITERS, ayahText } from './player.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const ar = (n) => Number(n).toLocaleString('ar-EG', { useGrouping: false });
const range = (v) => (v.from === v.to ? `الآية ${ar(v.from)}` : `الآيات ${ar(v.from)}–${ar(v.to)}`);

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 5v14l11-7z"/></svg>', // media icons are never mirrored in RTL
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>',
};

// ---------- State ----------
const state = {
  doc: null,
  fingerprint: '',
  page: 1,
  curated: null,      // reviewed index for this book, if we have one
  overrides: {},      // page -> verse list edited by the user
  autoCache: new Map(),
  renderTask: null,
  editing: null,      // { index } when editing an existing verse, {} when adding
};
const player = new VersePlayer();

// ---------- Persistence (this browser only) ----------
const storeKey = () => `quran-reader:${state.fingerprint}`;
function save() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ overrides: state.overrides, page: state.page }));
  } catch { /* storage full or blocked - edits just won't persist */ }
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(storeKey())) || {}; } catch { return {}; }
}

// ---------- Opening a book ----------
async function openPdf(file) {
  if (!file || !/pdf$/i.test(file.type || file.name)) return toast('الرجاء اختيار ملف بصيغة PDF.');
  toast('جارٍ فتح الكتاب…');
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    if (state.doc) state.doc.destroy();
    player.stop();
    Object.assign(state, { doc, fingerprint: doc.fingerprints[0], curated: null, autoCache: new Map() });

    state.curated = await fetch(`books/${state.fingerprint}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const saved = loadSaved();
    state.overrides = saved.overrides || {};

    const meta = await doc.getMetadata().catch(() => ({}));
    const title = state.curated?.title || meta.info?.Title || file.name.replace(/\.pdf$/i, '');
    $('bookTitle').textContent = state.curated?.author ? `${title} — ${state.curated.author}` : title;
    document.title = `${title} · قارئ الآيات`;
    $('bookNote').textContent = state.curated?.note || '';
    $('bookNote').hidden = !state.curated?.note;

    $('welcome').hidden = true;
    $('reader').hidden = false;
    $('dock').hidden = false;
    $('pageCount').textContent = ar(doc.numPages);
    $('pageInput').max = doc.numPages;
    hideToast();
    await goTo(saved.page || 1);
  } catch (err) {
    console.error(err);
    toast('تعذّر فتح هذا الملف. تأكد أنه ملف PDF سليم.');
  }
}

// ---------- Page rendering ----------
async function goTo(n) {
  if (!state.doc) return;
  n = Math.min(Math.max(1, Math.round(n) || 1), state.doc.numPages);
  state.page = n;
  $('pageInput').value = n;
  $('prevPage').disabled = n <= 1;
  $('nextPage').disabled = n >= state.doc.numPages;
  save();
  renderVerseList(); // instant if cached; otherwise detection fills it in shortly
  await renderPage(n);
}

async function renderPage(n) {
  const page = await state.doc.getPage(n);
  if (n !== state.page) return; // user already moved on
  state.renderTask?.cancel();

  const canvas = $('pageCanvas');
  const cssWidth = canvas.parentElement.clientWidth || 700;
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });

  $('pageSpinner').hidden = false;
  const off = document.createElement('canvas'); // draw off-screen, then swap: no flicker
  off.width = Math.floor(viewport.width);
  off.height = Math.floor(viewport.height);
  state.renderTask = page.render({ canvasContext: off.getContext('2d'), viewport });
  try {
    await state.renderTask.promise;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    canvas.setAttribute('aria-label', `صفحة ${ar(n)}`);
  } catch (e) {
    if (e?.name !== 'RenderingCancelledException') console.error(e);
  } finally {
    if (n === state.page) $('pageSpinner').hidden = true;
  }
}

// ---------- Verses for a page ----------
async function versesFor(n) {
  if (state.overrides[n]) return { list: state.overrides[n], source: 'user' };
  if (state.curated) {
    const list = (state.curated.pages[n] || []).map(([surah, from, to]) => ({ surah, from, to, confident: true }));
    return { list, source: 'book' };
  }
  if (!state.autoCache.has(n)) {
    const page = await state.doc.getPage(n);
    const { items } = await page.getTextContent();
    const found = findCitations(itemsToLines(items));
    // The same citation can appear twice on a page; keep one of each
    const seen = new Set();
    state.autoCache.set(n, found.filter((v) => {
      const k = `${v.surah}:${v.from}:${v.to}`;
      return !seen.has(k) && seen.add(k);
    }));
  }
  return { list: state.autoCache.get(n), source: 'auto' };
}

const BADGES = {
  book: ['فهرس مُراجَع', ''],
  auto: ['اكتشاف تلقائي', 'auto'],
  user: ['معدّل يدويًا', ''],
};

async function renderVerseList() {
  if (!state.doc) return; // nothing open yet
  const n = state.page;
  const { list, source } = await versesFor(n);
  if (n !== state.page) return;

  const [label, cls] = BADGES[source];
  $('sourceBadge').textContent = label;
  $('sourceBadge').className = `badge ${cls}`;
  $('resetPageBtn').hidden = source !== 'user';
  $('emptyMsg').hidden = list.length > 0;

  const q = player.queue;
  $('verseList').replaceChildren(...list.map((v, i) => {
    const li = document.createElement('li');
    const active = q && q.surah === v.surah && q.from === v.from && q.to === v.to;
    li.className = `verse${v.confident === false ? ' unsure' : ''}${active ? ' active' : ''}`;
    li.innerHTML = `
      <button class="play" type="button" aria-label="تشغيل سورة ${surahName(v.surah)} ${range(v)}">${active && player.playing ? ICONS.pause : ICONS.play}</button>
      <div class="meta">
        <strong>سورة ${surahName(v.surah)}</strong>
        <span>${range(v)}</span>
        ${v.confident === false ? '<em class="flag">⚠ اكتشاف غير مؤكد — تحقّق من السورة</em>' : ''}
      </div>
      <button class="mini edit" type="button" aria-label="تعديل">${ICONS.edit}</button>
      <button class="mini del" type="button" aria-label="حذف">${ICONS.del}</button>`;
    li.querySelector('.play').onclick = () => (active ? player.toggle() : player.play(v.surah, v.from, v.to));
    li.querySelector('.edit').onclick = () => openDialog(i, v);
    li.querySelector('.del').onclick = () => editPage((l) => l.splice(i, 1), 'حُذفت الآية من هذه الصفحة.');
    return li;
  }));
}

/** Apply a change to the current page's list and remember it as the user's version. */
async function editPage(mutate, message) {
  const { list } = await versesFor(state.page);
  const copy = list.map(({ surah, from, to }) => ({ surah, from, to, confident: true }));
  mutate(copy);
  state.overrides[state.page] = copy;
  save();
  renderVerseList();
  if (message) toast(message);
}

// ---------- Add / edit dialog ----------
$('fSurah').innerHTML = SURAHS.map(([name, count], i) =>
  `<option value="${i + 1}">${ar(i + 1)}. ${name} (${ar(count)} آية)</option>`).join('');

function openDialog(index, v) {
  state.editing = { index };
  $('dialogTitle').textContent = index == null ? 'إضافة آية' : 'تعديل الآية';
  $('fSurah').value = v?.surah || 1;
  $('fFrom').value = v?.from || 1;
  $('fTo').value = v?.to || v?.from || 1;
  $('fError').hidden = true;
  syncLimits();
  $('verseDialog').showModal();
}

function syncLimits() {
  const max = ayahCount(+$('fSurah').value);
  $('fFrom').max = max;
  $('fTo').max = max;
}
$('fSurah').onchange = syncLimits;
$('fFrom').oninput = () => { if (+$('fTo').value < +$('fFrom').value) $('fTo').value = $('fFrom').value; };
$('cancelDialog').onclick = () => $('verseDialog').close();

$('verseForm').onsubmit = (e) => {
  e.preventDefault();
  const surah = +$('fSurah').value, from = +$('fFrom').value, to = +$('fTo').value, max = ayahCount(surah);
  const err = !from || !to ? 'أدخل رقم الآية.'
    : from > max || to > max ? `سورة ${surahName(surah)} فيها ${ar(max)} آية فقط.`
    : to < from ? 'آية النهاية يجب أن تكون بعد آية البداية.' : '';
  if (err) { $('fError').textContent = err; $('fError').hidden = false; return; }

  const { index } = state.editing;
  const verse = { surah, from, to, confident: true };
  editPage((l) => (index == null ? l.push(verse) : (l[index] = verse)), index == null ? 'أُضيفت الآية.' : 'حُفظ التعديل.');
  $('verseDialog').close();
};

$('addVerseBtn').onclick = () => openDialog(null, null);
$('resetPageBtn').onclick = () => {
  delete state.overrides[state.page];
  save();
  renderVerseList();
  toast('أُعيدت الصفحة إلى حالتها الأصلية.');
};

// ---------- Player UI ----------
$('reciter').innerHTML = RECITERS.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
try { player.reciter = localStorage.getItem('quran-reader:reciter') || player.reciter; } catch {}
$('reciter').value = player.reciter;
$('reciter').onchange = () => {
  player.setReciter($('reciter').value);
  try { localStorage.setItem('quran-reader:reciter', player.reciter); } catch {}
};

let lastTextKey = '';
player.addEventListener('change', async ({ detail: d }) => {
  $('player').hidden = !d.surah;
  $('togglePlay').innerHTML = d.playing ? ICONS.pause : ICONS.play;
  renderVerseList();
  if (!d.surah) return;

  const title = `سورة ${surahName(d.surah)} · الآية ${ar(d.current)}` +
    (d.to > d.from ? ` (من ${ar(d.from)} إلى ${ar(d.to)})` : '');
  $('nowTitle').textContent = title;
  $('prevAyah').disabled = d.current <= d.from;
  $('nextAyah').disabled = d.current >= d.to;

  const text = $('nowText');
  if (d.error) {
    text.className = 'now-text error';
    text.textContent = 'تعذّر تحميل التلاوة. تحقّق من اتصالك بالإنترنت ثم حاول مرة أخرى.';
    return;
  }
  const key = `${d.surah}:${d.current}`;
  if (key === lastTextKey) return;
  lastTextKey = key;
  text.className = 'now-text';
  text.textContent = '';
  const t = await ayahText(d.surah, d.current);
  if (key === lastTextKey) text.textContent = t;

  // Lock-screen / headphone controls on phones
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist: RECITERS.find((r) => r.id === player.reciter)?.name, album: 'قارئ الآيات',
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => player.next());
    navigator.mediaSession.setActionHandler('previoustrack', () => player.prev());
  }
});
$('togglePlay').onclick = () => player.toggle();
$('nextAyah').onclick = () => player.next();
$('prevAyah').onclick = () => player.prev();
$('stopPlay').onclick = () => player.stop();

// ---------- Navigation & file input ----------
$('prevPage').onclick = () => goTo(state.page - 1);
$('nextPage').onclick = () => goTo(state.page + 1);
$('pageInput').onchange = () => goTo(+$('pageInput').value);

$('openBtn').onclick = () => $('fileInput').click();
$('dropZone').onclick = () => $('fileInput').click();
$('fileInput').onchange = () => { openPdf($('fileInput').files[0]); $('fileInput').value = ''; };

addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  openPdf(e.dataTransfer.files[0]);
});

addEventListener('keydown', (e) => {
  if (!state.doc || e.target.closest('input, select, textarea, dialog')) return;
  // Arabic books turn pages leftwards: ← is the next page
  if (e.key === 'ArrowLeft') goTo(state.page + 1);
  else if (e.key === 'ArrowRight') goTo(state.page - 1);
  else if (e.key === ' ' && player.queue) { e.preventDefault(); player.toggle(); }
});

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => state.doc && renderPage(state.page), 200);
});

// ---------- Toast ----------
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 3000);
}
function hideToast() { $('toast').hidden = true; }

$('togglePlay').innerHTML = ICONS.play;
