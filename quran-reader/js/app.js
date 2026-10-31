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
import { VersePlayer, RECITERS, REPEAT_MODES, ayahText } from './player.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.mjs', import.meta.url).href;

const $ = (id) => document.getElementById(id);
const ar = (n) => Number(n).toLocaleString('ar-EG', { useGrouping: false });
/** Arabic counted nouns change form with the number: موضع واحد، موضعان، ٣ مواضع، ١١ موضعًا، ١٠٠ موضع */
function countAr(n, { one, two, few, many, hundred }) {
  const r = n % 100;
  if (n === 1) return one;
  if (n === 2) return two;
  if (r >= 3 && r <= 10) return `${ar(n)} ${few}`;
  if (r >= 11) return `${ar(n)} ${many}`;
  return `${ar(n)} ${hundred}`; // 100, 101, 102, 200…
}
const PLACES = { one: 'موضع واحد', two: 'موضعين', few: 'مواضع', many: 'موضعًا', hundred: 'موضع' };
const PAGES = { one: 'صفحة واحدة', two: 'صفحتين', few: 'صفحات', many: 'صفحة', hundred: 'صفحة' };
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
  autoCache: new Map(), // page -> Promise of { list, chars } from automatic detection
  autoDone: new Map(),  // page -> { list, chars } once detection has finished
  scanId: 0,            // bumps when a new book opens, so an old background scan stops
  openId: 0,            // bumps on every open/home, so a slow-loading book can't pop up later
  renderTask: null,
  editing: null,        // { index } when editing an existing verse, { index: null } when adding
  focus: false,         // full-screen reading mode
};
const SAMPLE_FINGERPRINT = '7b358a0eaf470e459c010810e0b57b99'; // the built-in book
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
  const openId = ++state.openId;
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    if (openId !== state.openId) return doc.destroy(); // user went home (or opened another book) meanwhile
    if (state.doc) state.doc.destroy();
    player.stop();
    state.scanId++; // stop any scan of the previous book
    Object.assign(state, { doc, fingerprint: doc.fingerprints[0], curated: null, autoCache: new Map(), autoDone: new Map() });

    state.curated = await fetch(`books/${state.fingerprint}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (openId !== state.openId) return;
    const saved = loadSaved();
    state.overrides = saved.overrides || {};

    const meta = await doc.getMetadata().catch(() => ({}));
    const title = state.curated?.title || meta.info?.Title || file.name.replace(/\.pdf$/i, '');
    $('bookTitle').textContent = state.curated?.author ? `${title} — ${state.curated.author}` : title;
    $('focusTitle').textContent = title;
    document.title = `${title} · قارئ الآيات`;
    $('bookNote').textContent = state.curated?.note || '';
    $('bookNote').hidden = !state.curated?.note;

    $('welcome').hidden = true;
    $('reader').hidden = false;
    $('dock').hidden = false;
    $('homeBtn').hidden = false;
    $('brand').classList.add('clickable');
    $('noTextMsg').hidden = true;
    $('scanStatus').hidden = true;
    // Let the phone's back gesture / browser Back button return to the library
    if (!history.state?.reader) history.pushState({ reader: true }, '');
    $('pageCount').textContent = ar(doc.numPages);
    $('pageInput').max = doc.numPages;
    hideToast();
    await goTo(saved.page || 1);
    if (!state.curated) scanBook(); // no hand-checked list: search the whole book in the background
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
  document.querySelector('.viewer').scrollTop = 0; // new page starts at the top
  $('focusPage').textContent = `صفحة ${ar(n)} من ${ar(state.doc.numPages)}`;
  save();
  renderVerseList(); // instant if cached; otherwise detection fills it in shortly
  await renderPage(n);
}

async function renderPage(n) {
  const page = await state.doc?.getPage(n).catch(() => null); // the book may have just been closed
  if (!page || n !== state.page) return; // closed, or the reader already moved on
  state.renderTask?.cancel();

  const canvas = $('pageCanvas');
  const base = page.getViewport({ scale: 1 });
  let cssWidth;
  if (state.focus) {
    const viewer = document.querySelector('.viewer');
    const W = viewer.clientWidth, H = viewer.clientHeight;
    // Landscape: fill the width and scroll down (a whole page would be too small to read).
    // Portrait: show the whole page.
    cssWidth = W > H ? Math.min(W, 1200) : Math.min(W, H * (base.width / base.height));
    canvas.style.width = `${cssWidth}px`;
  } else {
    canvas.style.width = '';
    cssWidth = canvas.parentElement.clientWidth || 700;
  }
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
  const { list } = await detectPage(n);
  return { list, source: 'auto' };
}

/** Automatic detection for one page. Cached as a promise, so the page the reader is on and the
 *  background scan never do the same work twice. */
function detectPage(n) {
  if (!state.autoCache.has(n)) {
    const doc = state.doc;
    state.autoCache.set(n, (async () => {
      const { items } = await (await doc.getPage(n)).getTextContent();
      const chars = items.reduce((sum, i) => sum + i.str.trim().length, 0);
      // The same citation is often found twice (in both text orders); keep one of each
      const seen = new Set();
      const list = findCitations(itemsToLines(items)).filter((v) => {
        const k = `${v.surah}:${v.from}:${v.to}`;
        return !seen.has(k) && seen.add(k);
      });
      const result = { list, chars };
      if (doc === state.doc) state.autoDone.set(n, result);
      return result;
    })().catch(() => ({ list: [], chars: 0 })));
  }
  return state.autoCache.get(n);
}

/** True while automatic detection is still working on page n. */
const isPending = (n) => !state.overrides[n] && !state.curated && !state.autoDone.has(n);

/** Does page n have verses (as far as we know yet)? Used by the "jump" buttons. */
function hasVerses(n) {
  if (state.overrides[n]) return state.overrides[n].length > 0;
  if (state.curated) return (state.curated.pages[n] || []).length > 0;
  return (state.autoDone.get(n)?.list.length || 0) > 0;
}
function findVersePage(from, step) {
  for (let p = from + step; p >= 1 && p <= state.doc.numPages; p += step) if (hasVerses(p)) return p;
  return null;
}
function updateJumpButtons() {
  if (!state.doc) return;
  $('jumpPrev').disabled = !findVersePage(state.page, -1);
  $('jumpNext').disabled = !findVersePage(state.page, 1);
}
$('jumpPrev').onclick = () => { const p = findVersePage(state.page, -1); if (p) goTo(p); };
$('jumpNext').onclick = () => { const p = findVersePage(state.page, 1); if (p) goTo(p); };

/** Search every page in the background, showing progress, then summarize. */
async function scanBook() {
  const id = state.scanId;
  const total = state.doc.numPages;
  let done = 0, verses = 0, pages = 0, chars = 0;
  const status = $('scanStatus');
  status.hidden = false;
  status.classList.remove('done');
  const show = () => {
    $('scanText').innerHTML = `جارٍ البحث عن الآيات في الكتاب… <b>${ar(done)} من ${ar(total)}</b> صفحة`;
    $('scanBar').style.width = `${(done / total) * 100}%`;
  };
  show();
  for (let p = 1; p <= total; p++) {
    const { list, chars: c } = await detectPage(p);
    if (id !== state.scanId) return; // another book was opened, or we went home
    done++;
    chars += c;
    if (list.length) { pages++; verses += list.length; }
    if (p === state.page) renderVerseList();
    if (done % 5 === 0 || done === total) { show(); updateJumpButtons(); }
    if (p % 10 === 0) await new Promise((r) => setTimeout(r)); // keep the page responsive
  }
  status.classList.add('done');
  const scanned = chars / total < 15; // almost no text at all: the pages are images
  if (scanned) {
    status.hidden = true;
    $('noTextMsg').hidden = false;
    renderVerseList();
    return;
  }
  $('scanText').innerHTML = verses
    ? `عُثر على <b>${countAr(verses, PLACES)} لآيات</b> في ${countAr(pages, PAGES)}. تحقّق من المواضع المعلَّمة بـ⚠.`
    : 'لم يُعثر على مواضع آيات بصيغة [السورة: الآية] في هذا الكتاب. يمكنك إضافتها يدويًا.';
  toast(verses ? `اكتمل البحث: ${countAr(verses, PLACES)} في ${countAr(pages, PAGES)}` : 'اكتمل البحث: لم يُعثر على آيات');
  updateJumpButtons();
}

const BADGES = {
  book: ['فهرس مُراجَع', ''],
  auto: ['اكتشاف تلقائي', 'auto'],
  user: ['معدّل يدويًا', ''],
};

async function renderVerseList() {
  if (!state.doc) return; // nothing open yet
  const n = state.page;
  updateJumpButtons();
  if (isPending(n)) {
    // Show a loading state right away instead of an empty (misleading) list
    $('pageLoading').hidden = false;
    $('emptyMsg').hidden = true;
    $('verseList').replaceChildren();
    $('focusVerses').innerHTML = '<span class="chip-loading"><span class="spin"></span>جارٍ البحث عن الآيات…</span>';
    $('sourceBadge').textContent = BADGES.auto[0];
    $('sourceBadge').className = 'badge auto';
  }
  const { list, source } = await versesFor(n);
  if (n !== state.page || !state.doc) return;
  $('pageLoading').hidden = true;

  const [label, cls] = BADGES[source];
  $('sourceBadge').textContent = label;
  $('sourceBadge').className = `badge ${cls}`;
  $('resetPageBtn').hidden = source !== 'user';
  $('emptyMsg').hidden = list.length > 0 || !$('noTextMsg').hidden;

  const q = player.queue;
  const isActive = (v) => q && q.surah === v.surah && q.from === v.from && q.to === v.to;
  const playOrToggle = (v) => (isActive(v) ? player.toggle() : player.play(v.surah, v.from, v.to));

  // Compact chips shown in focus mode
  const chips = list.map((v) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${v.confident === false ? ' unsure' : ''}${isActive(v) ? ' active' : ''}`;
    b.innerHTML = `<span class="dot">${isActive(v) && player.playing ? ICONS.pause : ICONS.play}</span>${surahName(v.surah)} ${v.from === v.to ? ar(v.from) : `${ar(v.from)}–${ar(v.to)}`}`;
    b.onclick = () => playOrToggle(v);
    return b;
  });
  if (!chips.length) chips.push(Object.assign(document.createElement('span'), { className: 'none', textContent: 'لا آيات في هذه الصفحة' }));
  $('focusVerses').replaceChildren(...chips);

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
  const REPEAT_LABELS = { off: 'التكرار: متوقف', range: 'تكرار المقطع كاملًا', ayah: 'تكرار الآية الحالية' };
  $('repeatBtn').classList.toggle('on', d.repeat !== 'off');
  $('repeatBtn').querySelector('.rep-badge').hidden = d.repeat !== 'ayah';
  $('repeatBtn').title = REPEAT_LABELS[d.repeat];
  $('repeatBtn').setAttribute('aria-label', REPEAT_LABELS[d.repeat]);
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
try { if (REPEAT_MODES.includes(localStorage.getItem('quran-reader:repeat'))) player.repeat = localStorage.getItem('quran-reader:repeat'); } catch {}
$('repeatBtn').onclick = () => {
  const mode = player.cycleRepeat();
  try { localStorage.setItem('quran-reader:repeat', mode); } catch {}
  toast({ off: 'أُوقف التكرار', range: 'تكرار المقطع: ستُعاد الآيات من البداية بعد انتهائها', ayah: 'تكرار الآية: ستُعاد الآية الحالية' }[mode]);
};

// ---------- Home (library) ----------
function goHome() {
  state.openId++; // cancel any book still loading
  if (!state.doc) return;
  exitFocus();
  player.stop();
  state.scanId++; // stop the background scan
  state.doc.destroy();
  state.doc = null;
  state.renderTask?.cancel();
  $('reader').hidden = true;
  $('dock').hidden = true;
  $('homeBtn').hidden = true;
  $('welcome').hidden = false;
  $('brand').classList.remove('clickable');
  $('bookTitle').textContent = 'اقرأ كتابك واستمع إلى آياته';
  document.title = 'قارئ الآيات';
  updateLibraryCard();
  scrollTo(0, 0);
}
// Home goes "back" in history, so the browser Back button and the home button behave the same
const requestHome = () => (history.state?.reader ? history.back() : goHome());
$('homeBtn').onclick = requestHome;
$('brand').onclick = () => state.doc && requestHome();
addEventListener('popstate', () => { if (state.doc && !history.state?.reader) goHome(); });
if (history.state?.reader) history.replaceState(null, ''); // a reload starts at the library

/** "Continue reading" on the built-in book's card. */
function updateLibraryCard() {
  let page = 0;
  try { page = JSON.parse(localStorage.getItem(`quran-reader:${SAMPLE_FINGERPRINT}`))?.page || 0; } catch {}
  $('sampleMeta').textContent = page > 1 ? `تابع القراءة من صفحة ${ar(page)} من ٢٦` : '٢٦ صفحة · ٣٥ موضعًا لآيات مُراجَعة';
  $('sampleCta').textContent = page > 1 ? 'متابعة القراءة' : 'ابدأ القراءة';
}
updateLibraryCard();

// ---------- Navigation & file input ----------
$('prevPage').onclick = () => goTo(state.page - 1);
$('nextPage').onclick = () => goTo(state.page + 1);
$('pageInput').onchange = () => goTo(+$('pageInput').value);

$('openBtn').onclick = () => $('fileInput').click();
$('dropZone').onclick = () => $('fileInput').click();
// The built-in book shipped with the site
$('sampleBook').onclick = async () => {
  toast('جارٍ تحميل الكتاب…');
  try {
    const res = await fetch('books/dalil-ila-alquran.pdf');
    if (!res.ok) throw new Error(res.status);
    openPdf(new File([await res.blob()], 'الدليل إلى القرآن.pdf', { type: 'application/pdf' }));
  } catch {
    toast('تعذّر تحميل الكتاب. تحقّق من اتصالك بالإنترنت.');
  }
};
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
  if (e.key === 'f' || e.key === 'F' || e.key === 'ب') return state.focus ? exitFocus() : enterFocus(); // ب is F on Arabic keyboards
  if (e.key === 'Escape') return exitFocus();
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

// ---------- Focus (full-screen) mode ----------
// The page fills the screen. Tap the page to show/hide the controls; swipe to turn pages.
let hintShown = false;

function enterFocus() {
  if (!state.doc || state.focus) return;
  state.focus = true;
  document.body.classList.add('focus');
  document.body.classList.remove('show-controls');
  $('focusBar').hidden = false;
  // Real fullscreen where the browser allows it (not on iPhone - the CSS mode still works there)
  document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
  renderPage(state.page);
  if (!hintShown) { hintShown = true; toast('اضغط على الصفحة لإظهار أدوات التحكم، واسحب يمينًا أو يسارًا لتقليب الصفحات.'); }
}

function exitFocus() {
  if (!state.focus) return;
  state.focus = false;
  document.body.classList.remove('focus', 'show-controls');
  $('focusBar').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderPage(state.page);
}

const toggleControls = () => document.body.classList.toggle('show-controls');

$('focusBtn').onclick = (e) => { e.stopPropagation(); enterFocus(); };
$('exitFocus').onclick = exitFocus;
// Leaving browser fullscreen (e.g. the Esc key or a system gesture) also leaves focus mode
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) exitFocus(); });

// Tap vs swipe on the page, using pointer events so it works with mouse, touch and pen
const viewer = document.querySelector('.viewer');
let gesture = null;
viewer.addEventListener('pointerdown', (e) => {
  if (!state.focus) return;
  if (e.isPrimary) gesture = { x: e.clientX, y: e.clientY, t: Date.now() };
  else if (gesture) gesture.multi = true; // a second finger = pinch-zoom, not a tap or swipe
});
viewer.addEventListener('pointerup', (e) => {
  const g = gesture;
  gesture = null;
  if (!state.focus || !g || g.multi) return;
  const dx = e.clientX - g.x, dy = e.clientY - g.y;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    // Arabic books: dragging the page to the right brings the next page
    goTo(state.page + (dx > 0 ? 1 : -1));
  } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && Date.now() - g.t < 500) {
    toggleControls();
  }
});
viewer.addEventListener('pointercancel', () => { gesture = null; });

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
