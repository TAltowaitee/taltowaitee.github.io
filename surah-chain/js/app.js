// UI for سلسلة السور. All learning logic lives in engine.js.
import { SURAHS, name } from './surahs.js';
import {
  createProgress, nextTask, recordResult, startCheckpoint, levelProgress, overallProgress,
  surahStrength, maxLevelFor, passMark, hiddenCount, optionCount, STREAK_TO_MASTER, chain,
} from './engine.js';

/* ---------- Helpers ---------- */
const $ = (id) => document.getElementById(id);
const ar = (n) => n.toLocaleString('ar-EG');
const pct = (x) => `${ar(Math.round(x * 100))}٪`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rangeKey = (r) => r.join('-');
const q = (n) => `«${name(n)}»`;
/** Arabic count agreement: 2 → dual, 3–10 → plural, otherwise singular accusative. */
const count = (n, dual, plural, single) => (n === 2 ? dual : `${ar(n)} ${n >= 3 && n <= 10 ? plural : single}`);

const LEVEL_NAMES = { 2: 'أزواج', 3: 'ثلاثيات', 4: 'رباعيات', 5: 'خماسيات', 6: 'سداسيات', 7: 'سباعيات' };

// Overlapping sections: each starts with the surah the previous one ended on.
const SECTIONS = [[1, 10], [10, 20], [20, 30], [30, 40], [40, 50], [50, 66], [66, 78], [78, 96], [96, 114]]
  .map((range) => ({ range }));
const WHOLE = [
  { range: [78, 114], title: 'جزء عمّ كاملًا' },
  { range: [1, 114], title: 'القرآن كاملًا' },
];

/* ---------- Storage ---------- */
const KEY = 'surah-chain:v1';
const DEFAULT = { settings: { previews: true, numbers: true, vibrate: true }, ranges: {}, current: null };
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s && s.ranges) return { ...DEFAULT, ...s, settings: { ...DEFAULT.settings, ...s.settings } };
  } catch { /* private mode or bad data: start fresh */ }
  return structuredClone(DEFAULT);
}
const store = load();
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* ignore */ } };

/* ---------- State ---------- */
let prog = null; // progress for the open range
let task = null; // current task from the engine
let play = null; // interaction state for the current task
let screen = null; // interstitial (level up, test result, complete)
let streak = 0; // correct answers in a row, this visit
let timer = 0;

/* ---------- Views ---------- */
function show(view) {
  $('home').hidden = view !== 'home';
  $('practice').hidden = view !== 'practice';
  $('mapBtn').hidden = view !== 'practice';
  $('resetWrap').hidden = view !== 'practice';
  $('subtitle').textContent = view === 'practice' ? rangeTitle(prog.range) : 'احفظ ترتيب سور القرآن بالتسلسل';
  window.scrollTo({ top: 0 });
}

function rangeTitle([a, b], title) {
  return title || `${name(a)} ← ${name(b)}`;
}

/* ---------- Home ---------- */
function rangeStatus(p) {
  if (!p) return { text: 'لم تبدأ بعد', value: 0 };
  if (p.phase === 'done') return { text: 'أُتقن ✓', value: 1, done: true };
  return { text: `المستوى ${ar(p.level)} من ${ar(maxLevelFor(p.range))}: ${LEVEL_NAMES[p.level]}`, value: overallProgress(p) };
}

function rangeCard({ range, title }) {
  const k = rangeKey(range);
  const p = store.ranges[k];
  const st = rangeStatus(p);
  const [a, b] = range;
  const current = store.current === k;
  return `
    <button type="button" class="range ${current ? 'current' : ''} ${st.done ? 'done' : ''}" data-range="${k}">
      <span class="range-top">
        <strong>${esc(rangeTitle(range, title))}</strong>
        ${current ? '<em>تابع</em>' : ''}
      </span>
      <small>السور ${ar(a)}–${ar(b)}، ${count(b - a + 1, 'سورتان', 'سور', 'سورة')}</small>
      <span class="bar mini"><span style="width:${(st.value * 100).toFixed(1)}%"></span></span>
      <small class="range-status">${st.text}</small>
    </button>`;
}

function renderHome() {
  const custom = Object.keys(store.ranges)
    .filter((k) => ![...SECTIONS, ...WHOLE].some((s) => rangeKey(s.range) === k))
    .map((k) => ({ range: k.split('-').map(Number) }));
  $('ranges').innerHTML = [
    `<h3 class="group">مقاطع قصيرة</h3>`,
    ...SECTIONS.map(rangeCard),
    `<h3 class="group">مقاطع طويلة</h3>`,
    ...WHOLE.map(rangeCard),
    ...(custom.length ? [`<h3 class="group">مقاطعك</h3>`, ...custom.map(rangeCard)] : []),
  ].join('');
}

function fillCustomSelects() {
  const opts = SURAHS.map((n, i) => `<option value="${i + 1}">${n} (${ar(i + 1)})</option>`).join('');
  $('customFrom').innerHTML = opts;
  $('customTo').innerHTML = opts;
  $('customFrom').value = '1';
  $('customTo').value = '10';
}

/* ---------- Practice ---------- */
/** Navigate to a section; the hash change opens it (so Back returns home). */
function go(range) {
  const h = `#r-${rangeKey(range)}`;
  if (location.hash === h) openRange(range);
  else location.hash = h;
}

function openRange(range) {
  const k = rangeKey(range);
  prog = store.ranges[k] ||= createProgress(range);
  store.current = k;
  save();
  screen = null;
  streak = 0;
  show('practice');
  next();
}

function goHome() {
  if (location.hash.length > 1) { location.hash = ''; return; } // route() comes back here
  clearTimeout(timer);
  prog = null;
  renderHome();
  show('home');
}

function next() {
  clearTimeout(timer);
  if (screen) { renderScreen(); renderStatus(); return; }
  task = nextTask(prog, { previews: store.settings.previews });
  save();
  play = task.kind === 'gap' ? { slot: 0, filled: {}, done: false }
    : task.kind === 'order' ? { placed: [], mistakes: 0, wrongHere: 0, used: new Set(), done: false }
    : null;
  renderStatus();
  renderTask();
}

function renderStatus() {
  const max = maxLevelFor(prog.range);
  const done = prog.phase === 'done';
  $('levelBadge').textContent = done ? 'المقطع مُتقن ✓' : `المستوى ${ar(prog.level)} من ${ar(max)}: ${LEVEL_NAMES[prog.level]}`;
  const mode = $('modeBadge');
  if (prog.phase === 'checkpoint') {
    const c = prog.checkpoint;
    mode.hidden = false;
    mode.textContent = `اختبار المستوى ${ar(Math.min(c.index + 1, c.queue.length))}/${ar(c.queue.length)}`;
  } else if (done) {
    mode.hidden = false;
    mode.textContent = 'مراجعة حرّة';
  } else mode.hidden = true;

  const { answered, correct } = prog.stats;
  $('accuracy').textContent = answered ? pct(correct / answered) : '—';
  $('streak').textContent = ar(streak);

  const { mastered, total } = levelProgress(prog);
  const value = done ? 1 : mastered / total;
  const bar = $('levelBar');
  bar.firstElementChild.style.width = `${(value * 100).toFixed(1)}%`;
  bar.setAttribute('aria-valuenow', Math.round(value * 100));
  $('levelText').textContent = done
    ? `أتممت المستويات كلها، الإتقان الكلي ${pct(1)}`
    : `السلاسل المتقنة في هذا المستوى: ${ar(mastered)} / ${ar(total)}، التقدّم الكلي ${pct(overallProgress(prog))}`;
}

/* ----- Chain rendering ----- */
function linkHTML(n, state = '') {
  const num = store.settings.numbers ? `<span class="num">${ar(n)}</span>` : '';
  return `<span class="link ${state}">${num}<span class="nm">${esc(name(n))}</span></span>`;
}
function slotHTML(state = '') {
  return `<span class="link slot ${state}"><span class="nm">؟</span></span>`;
}
const arrow = '<span class="arrow" aria-hidden="true">←</span>';

function gapChain() {
  return task.items.map((n, i) => {
    if (!task.hidden.includes(i)) return linkHTML(n);
    const f = play.filled[i];
    if (f) return linkHTML(n, f.ok ? 'filled ok' : 'filled bad');
    return slotHTML(task.hidden[play.slot] === i && !play.done ? 'active' : '');
  }).join(arrow);
}

function orderChain() {
  return task.items.map((n, i) => (i < play.placed.length ? linkHTML(n, 'filled ok') : slotHTML(i === play.placed.length ? 'active' : ''))).join(arrow);
}

function masteryDots() {
  if (task.free) return '';
  const w = prog.win[task.start] || { streak: 0, mastered: false };
  const n = Math.min(w.streak, STREAK_TO_MASTER);
  const dots = Array.from({ length: STREAK_TO_MASTER }, (_, i) => `<i class="${i < n || w.mastered ? 'on' : ''}"></i>`).join('');
  return `<span class="dots" title="إتقان هذه السلسلة">${dots}<small>${w.mastered ? 'مُتقنة' : 'إتقان السلسلة'}</small></span>`;
}

function tagHTML() {
  if (task.checkpoint) return '<span class="tag gold">اختبار</span>';
  if (task.free) return `<span class="tag">${LEVEL_NAMES[task.L]}</span>`;
  if (task.review) return '<span class="tag">مراجعة</span>';
  if (!prog.win[task.start]?.seen) return '<span class="tag new">جديدة</span>';
  return '';
}

function gapPrompt() {
  const { items, hidden, L } = task;
  if (hidden.length === 1 && L === 2) {
    return hidden[0] === 1 ? `ما السورة التي تلي ${q(items[0])}؟` : `ما السورة التي تسبق ${q(items[1])}؟`;
  }
  if (hidden.length === 1) {
    const i = hidden[0];
    if (i === 0) return `ما السورة التي تسبق ${q(items[1])}؟`;
    if (i === L - 1) return `ما السورة التي تلي ${q(items[L - 2])}؟`;
    return `ما السورة بين ${q(items[i - 1])} و${q(items[i + 1])}؟`;
  }
  return `أكمل السور المخفية بالترتيب (${ar(play.slot + 1)} من ${ar(hidden.length)})`;
}

function renderTask() {
  const card = $('card');
  card.className = 'card';
  if (task.kind === 'preview') {
    const [a, b] = task.items;
    card.innerHTML = `
      <div class="card-head"><span class="tag new">زوج جديد</span></div>
      <p class="prompt">احفظ هذا الزوج</p>
      <div class="chain big">${linkHTML(a)}${arrow}${linkHTML(b)}</div>
      <p class="explain">بعد سورة ${q(a)} تأتي سورة ${q(b)}.</p>
      <div class="actions"><button class="btn primary" data-primary data-act="next">حفظته، تابع</button></div>`;
    return;
  }
  if (task.kind === 'checkpoint-intro') {
    const last = task.level >= maxLevelFor(prog.range);
    const nextText = last ? 'لتُتمّ هذا المقطع' : `لتنتقل إلى ${LEVEL_NAMES[task.level + 1]} (سلاسل من ${ar(task.level + 1)} سور)`;
    card.classList.add('screen');
    card.innerHTML = `
      <div class="medal" aria-hidden="true">${ar(task.level)}</div>
      <h2>أتقنت كل ${LEVEL_NAMES[task.level]} هذا المقطع</h2>
      <p class="explain">بقي اختبار المستوى: ${ar(task.size)} أسئلة مختارة، أكثرها مما أخطأت فيه.
        تحتاج ${ar(passMark(task.size))} إجابات صحيحة ${nextText}.</p>
      <div class="actions"><button class="btn primary" data-primary data-act="checkpoint">ابدأ الاختبار</button></div>`;
    return;
  }
  if (task.kind === 'gap') {
    const slot = play.done ? play.optSlot : play.slot;
    const opts = task.options[slot];
    card.innerHTML = `
      <div class="card-head">${tagHTML()}${masteryDots()}</div>
      <p class="prompt">${gapPrompt()}</p>
      <div class="chain ${task.L > 4 ? 'long' : ''}">${gapChain()}</div>
      <div class="options ${opts && opts.length > 4 ? 'six' : ''}" role="group" aria-label="الخيارات">
        ${opts.map((n, i) => `
          <button type="button" class="opt" data-n="${n}" ${play.done ? 'disabled' : ''}>
            <kbd>${i + 1}</kbd><span>${esc(name(n))}</span></button>`).join('')}
      </div>
      <div id="feedback"></div>`;
    if (play.done) markOptions(play.lastPick, task.items[task.hidden[slot]]);
    return;
  }
  if (task.kind === 'order') {
    card.innerHTML = `
      <div class="card-head">${tagHTML()}${masteryDots()}</div>
      <p class="prompt">رتّب هذه السور كما في المصحف</p>
      <div class="chain ${task.L > 4 ? 'long' : ''}">${orderChain()}</div>
      <div class="pool" role="group" aria-label="السور">
        ${task.pool.map((n, i) => `
          <button type="button" class="chip ${play.used.has(n) ? 'used' : ''}" data-n="${n}" ${play.used.has(n) || play.done ? 'disabled' : ''}>
            <kbd>${i + 1}</kbd>${store.settings.numbers && play.done ? `<small>${ar(n)}</small>` : ''}<span>${esc(name(n))}</span></button>`).join('')}
      </div>
      <div id="feedback"></div>`;
  }
}

function markOptions(picked, answer) {
  for (const b of $('card').querySelectorAll('.opt')) {
    const n = +b.dataset.n;
    if (n === answer) b.classList.add('right');
    else if (n === picked) b.classList.add('wrong');
    b.disabled = true;
  }
}

/* ----- Answering ----- */
function pickOption(n) {
  if (!play || play.done || play.busy) return;
  const i = task.hidden[play.slot];
  const answer = task.items[i];
  if (n === answer) {
    play.filled[i] = { ok: true };
    play.slot++;
    if (play.slot < task.hidden.length) {
      // Next hidden surah in this chain
      play.busy = true;
      markOptions(n, answer);
      timer = setTimeout(() => { play.busy = false; renderTask(); }, 380);
      return;
    }
    play.done = true;
    play.optSlot = play.slot - 1;
    play.lastPick = n;
    renderTask();
    finish(true);
    return;
  }
  // Wrong: reveal this and any remaining hidden surahs, then explain.
  play.filled[i] = { ok: false };
  for (const j of task.hidden) play.filled[j] ||= { ok: true };
  play.done = true;
  play.optSlot = play.slot;
  play.lastPick = n;
  renderTask();
  finish(false, { i, picked: n });
}

function pickChip(n, btn) {
  if (!play || play.done) return;
  const want = task.items[play.placed.length];
  if (n !== want) {
    play.mistakes++;
    play.wrongHere++;
    btn.classList.remove('shake');
    void btn.offsetWidth; // restart the animation
    btn.classList.add('shake', 'wrong');
    setTimeout(() => btn.classList.remove('wrong'), 500);
    buzz();
    if (play.wrongHere >= 2) $('card').querySelector(`.chip[data-n="${want}"]`)?.classList.add('hint');
    return;
  }
  play.placed.push(n);
  play.used.add(n);
  play.wrongHere = 0;
  if (play.placed.length === task.items.length) {
    play.done = true;
    renderTask();
    finish(play.mistakes === 0, { mistakes: play.mistakes });
    return;
  }
  renderTask();
}

function explainWrong(info) {
  if (task.kind === 'order') {
    return `رتّبتها مع ${ar(info.mistakes)} ${info.mistakes === 1 ? 'خطأ' : 'أخطاء'}. تأمّل الترتيب الصحيح أعلاه.`;
  }
  const { items } = task;
  const n = items[info.i];
  const rel = info.i > 0 ? `تأتي بعد ${q(items[info.i - 1])}` : `تأتي قبل ${q(items[info.i + 1])}`;
  const d = Math.abs(info.picked - n);
  const gap = d === 1 ? 'مباشرة' : d === 2 ? 'بسورتين' : `بـ${ar(d)} سور`;
  const confusion = d <= 4 ? ` أما ${q(info.picked)} فتأتي ${info.picked < n ? 'قبلها' : 'بعدها'} ${gap}.` : '';
  return `الصواب ${q(n)}، ${rel}.${confusion}`;
}

function finish(ok, info = {}) {
  const ev = recordResult(prog, task, ok);
  save();
  streak = ok ? streak + 1 : 0;
  if (!ok) buzz();

  if (ev.levelUp || ev.complete) screen = { type: ev.complete ? 'complete' : 'levelup', ...ev };
  else if (ev.checkpoint) screen = { type: 'failed', ...ev };

  renderStatus();
  const fb = $('feedback');
  const extra = ev.mastered ? '<span class="pill">أتقنت هذه السلسلة ✓</span>'
    : ev.lost ? '<span class="pill warn">ستعود هذه السلسلة للتدريب</span>' : '';
  if (ok) {
    const praise = ['أحسنت!', 'ممتاز!', 'صحيح!', 'بارك الله فيك!'][Math.floor(Math.random() * 4)];
    fb.innerHTML = `<div class="feedback ok"><strong>${praise}</strong>${extra}
      <button class="btn primary" data-primary data-act="next">التالي</button></div>`;
    timer = setTimeout(next, ev.mastered || screen ? 1400 : 900);
  } else {
    fb.innerHTML = `<div class="feedback bad"><p>${explainWrong(info)}</p>${extra}
      <button class="btn primary" data-primary data-act="next">التالي</button></div>`;
    $('card').classList.add('missed');
  }
  const dots = $('card').querySelector('.dots');
  if (dots) {
    dots.outerHTML = masteryDots();
    if (ev.mastered) $('card').querySelector('.dots').classList.add('pop');
  }
}

function buzz() {
  if (store.settings.vibrate) navigator.vibrate?.(120);
}

/* ----- Interstitial screens ----- */
function levelRules(L) {
  const h = hiddenCount(L);
  const parts = [`تظهر لك سلاسل من ${ar(L)} سور متتالية`];
  parts.push(h === 1 ? 'وتُخفى سورة واحدة' : `وتُخفى ${ar(h)} سور`);
  parts.push(`مع ${ar(optionCount(L))} خيارات`);
  return `${parts.join('، ')}، وأحيانًا يُطلب منك ترتيب السلسلة كلها.`;
}

function renderScreen() {
  const card = $('card');
  card.className = 'card screen';
  const s = screen;
  const scoreLine = s.checkpoint ? `نتيجة الاختبار: ${ar(s.checkpoint.score)} من ${ar(s.checkpoint.size)}` : '';
  if (s.type === 'levelup') {
    const h = prog.history.at(-1);
    card.innerHTML = `
      <div class="medal up" aria-hidden="true">${ar(s.levelUp.to)}</div>
      <h2>انتقلت إلى ${LEVEL_NAMES[s.levelUp.to]}</h2>
      <p class="score">${scoreLine}، ودقتك في المستوى ${ar(s.levelUp.from)}: ${pct(h.correct / Math.max(1, h.answered))}</p>
      <p class="explain">${levelRules(s.levelUp.to)}</p>
      <div class="actions"><button class="btn primary" data-primary data-act="continue">واصل</button></div>`;
  } else if (s.type === 'failed') {
    const missed = s.checkpoint.missed.map((st) => `<li>${chain(st, s.checkpoint.level).map((n) => esc(name(n))).join(' ← ')}</li>`).join('');
    card.innerHTML = `
      <div class="medal retry" aria-hidden="true">${ar(s.checkpoint.score)}</div>
      <h2>${s.checkpoint.score >= passMark(s.checkpoint.size) - 2 ? 'قاربت! ' : ''}تحتاج ${ar(passMark(s.checkpoint.size))} من ${ar(s.checkpoint.size)} للنجاح</h2>
      <p class="score">${scoreLine}</p>
      <p class="explain">هذه السلاسل تحتاج تثبيتًا، وستعود إليها في التدريب ثم تعيد الاختبار:</p>
      <ul class="missed-list">${missed}</ul>
      <div class="actions"><button class="btn primary" data-primary data-act="continue">تدرّب عليها</button></div>`;
  } else if (s.type === 'complete') {
    const { answered, correct } = prog.stats;
    card.innerHTML = `
      <div class="medal done" aria-hidden="true">✓</div>
      <h2>أتقنت هذا المقطع كاملًا</h2>
      <p class="score">${scoreLine}، ${count(answered, 'سؤالان', 'أسئلة', 'سؤالًا')} بدقة ${pct(correct / Math.max(1, answered))}</p>
      <p class="explain">صرت تعرف ما قبل كل سورة وما بعدها من ${q(prog.range[0])} إلى ${q(prog.range[1])}.
        واصل بمراجعة حرّة تخلط المستويات كلها، أو انتقل إلى مقطع آخر.</p>
      <div class="actions">
        <button class="btn primary" data-primary data-act="continue">مراجعة حرّة</button>
        <button class="btn" data-act="home">اختر مقطعًا آخر</button>
      </div>`;
  }
}

/* ----- Map ----- */
function renderMap() {
  const [a, b] = prog.range;
  $('mapCaption').textContent = `${rangeTitle(prog.range)}: يزداد لون السورة كلما أتقنت السلاسل التي تضمّها، عبر المستويات كلها.`;
  let html = '';
  for (let n = a; n <= b; n++) {
    const s = surahStrength(prog, n);
    html += `<span class="cell ${s > 0.5 ? 'dark' : ''}" style="--s:${s.toFixed(3)}" title="${esc(name(n))}: ${pct(s)}">
      <small>${ar(n)}</small>${esc(name(n))}</span>`;
  }
  $('map').innerHTML = html;
}

/* ---------- Events ---------- */
$('card').addEventListener('click', (e) => {
  const opt = e.target.closest('.opt');
  if (opt) return pickOption(+opt.dataset.n);
  const chip = e.target.closest('.chip');
  if (chip) return pickChip(+chip.dataset.n, chip);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'next') next();
  else if (act === 'checkpoint') { startCheckpoint(prog); save(); next(); }
  else if (act === 'continue') { screen = null; next(); }
  else if (act === 'home') goHome();
});

document.addEventListener('keydown', (e) => {
  if ($('practice').hidden || document.querySelector('dialog[open]') || e.ctrlKey || e.metaKey || e.altKey) return;
  const d = /^[1-9]$/.test(e.key) ? +e.key : /^[١-٩]$/.test(e.key) ? '١٢٣٤٥٦٧٨٩'.indexOf(e.key) + 1 : 0;
  if (d) {
    const btn = $('card').querySelectorAll('.opt, .chip')[d - 1];
    if (btn && !btn.disabled) btn.click();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    const a = document.activeElement;
    if (a?.tagName === 'BUTTON' && !a.disabled) return; // let the focused button handle it
    const primary = $('card').querySelector('[data-primary]');
    if (primary) { e.preventDefault(); primary.click(); }
  }
});

$('ranges').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-range]');
  if (btn) go(btn.dataset.range.split('-').map(Number));
});

$('customForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let a = +$('customFrom').value;
  let b = +$('customTo').value;
  if (a > b) [a, b] = [b, a];
  if (a === b) { b = Math.min(114, a + 1); if (a === b) a--; }
  go([a, b]);
});

$('brand').addEventListener('click', () => goHome());
$('mapBtn').addEventListener('click', () => { renderMap(); $('mapDialog').showModal(); });

const toggles = { optPreviews: 'previews', optNumbers: 'numbers', optVibrate: 'vibrate' };
$('settingsBtn').addEventListener('click', () => {
  for (const [id, k] of Object.entries(toggles)) $(id).checked = store.settings[k];
  $('settingsDialog').showModal();
});
for (const [id, k] of Object.entries(toggles)) {
  $(id).addEventListener('change', () => {
    store.settings[k] = $(id).checked;
    save();
    if (k === 'numbers' && prog && task && !screen) renderTask();
  });
}
// Reset asks for a second tap instead of a confirm() dialog.
const RESET_LABEL = $('resetBtn').textContent;
$('resetBtn').addEventListener('click', () => {
  const btn = $('resetBtn');
  if (!prog) return;
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = `اضغط مرة أخرى لمحو تقدّمك في «${rangeTitle(prog.range)}»`;
    return;
  }
  const range = prog.range;
  delete store.ranges[rangeKey(range)];
  $('settingsDialog').close();
  openRange(range);
});
$('settingsDialog').addEventListener('close', () => {
  $('resetBtn').classList.remove('armed');
  $('resetBtn').textContent = RESET_LABEL;
});

// Close dialogs by tapping the backdrop
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
}

function route() {
  const m = location.hash.match(/^#r-(\d+)-(\d+)$/);
  const r = m && [+m[1], +m[2]];
  if (r && r[0] >= 1 && r[1] <= 114 && r[1] > r[0]) openRange(r);
  else goHome();
}
window.addEventListener('hashchange', route);

fillCustomSelects();
route();
