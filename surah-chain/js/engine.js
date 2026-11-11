// Learning engine: pure logic, no DOM. Safe to unit-test in Node.
//
// The learner works on a range of surahs [a, b]. At level L every run of L consecutive
// surahs in the range is a "window" (a chain). Level 2 = pairs (البقرة ← آل عمران),
// level 3 = triples, and so on. Windows overlap by L-1 surahs, so every link is chained.
//
// Windows are introduced a few at a time, in order. A window is mastered after
// STREAK_TO_MASTER correct answers in a row (with a different surah hidden each time when
// possible). Mastered windows come back for review now and then; a miss un-masters them.
// When every window of a level is mastered, a level test (checkpoint) samples the windows,
// weighted towards the ones the learner got wrong. Passing it unlocks the next level.

export const TOTAL = 114;
export const MAX_LEVEL_CAP = 7;
export const STREAK_TO_MASTER = 2;
export const REVIEW_CHANCE = 0.2;
export const CHECKPOINT_SIZE = 10;
export const CHECKPOINT_PASS = 0.9;

export const maxLevelFor = ([a, b]) => Math.min(MAX_LEVEL_CAP, b - a + 1);

export function windowStarts([a, b], L) {
  const out = [];
  for (let s = a; s + L - 1 <= b; s++) out.push(s);
  return out;
}

export const chain = (start, L) => Array.from({ length: L }, (_, i) => start + i);

/** How many surahs are hidden in a fill-the-gap question at level L. */
export const hiddenCount = (L) => (L <= 3 ? 1 : L <= 5 ? 2 : 3);

/** How many answer choices a gap shows at level L. */
export const optionCount = (L) => (L <= 3 ? 4 : 6);

/** Working set: how many unmastered windows are in rotation before a new one is introduced. */
const workingSet = (L) => (L === 2 ? 3 : 4);

export function createProgress(range) {
  const [a, b] = range;
  if (!(a >= 1 && b <= TOTAL && b - a >= 1)) throw new Error(`bad range ${a}-${b}`);
  return {
    v: 1,
    range: [a, b],
    level: 2,
    phase: 'learn', // learn | checkpoint | done
    win: {}, // start -> window state, for the current level
    introduced: 0,
    seq: 0,
    last: null,
    stats: { answered: 0, correct: 0 },
    levelStats: { answered: 0, correct: 0 },
    history: [], // finished levels: { level, answered, correct }
    checkpoint: null,
  };
}

const winState = (p, s) =>
  (p.win[s] ||= { streak: 0, seen: 0, wrong: 0, mastered: false, lastSeen: -1, lastHidden: null });

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Least-recently-seen window, avoiding `avoid` when there is another choice. */
function pickStale(p, starts, avoid, rng) {
  let pool = starts.length > 1 ? starts.filter((s) => s !== avoid) : starts;
  const oldest = Math.min(...pool.map((s) => winState(p, s).lastSeen));
  pool = pool.filter((s) => winState(p, s).lastSeen === oldest);
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Answer choices for one hidden surah: the answer, plus distractors that are mostly its
 * close neighbours in the Mushaf (the confusions that actually happen), plus a random one.
 * Surahs visible in the chain are never offered.
 */
export function makeOptions(answer, visible, k, rng) {
  const banned = new Set([...visible, answer]);
  const near = [];
  for (let d = 1; d <= 4; d++) {
    for (const n of [answer - d, answer + d]) if (n >= 1 && n <= TOTAL && !banned.has(n)) near.push(n);
  }
  const picks = shuffle(near, rng).slice(0, Math.ceil((k - 1) * 0.6));
  picks.forEach((n) => banned.add(n));
  while (picks.length < k - 1) {
    const n = 1 + Math.floor(rng() * TOTAL);
    if (!banned.has(n)) { picks.push(n); banned.add(n); }
  }
  return shuffle([answer, ...picks], rng);
}

/** Build a question for the window starting at `start` with length L. */
export function makeQuiz(p, start, L, rng = Math.random, extra = {}) {
  const items = chain(start, L);
  if (L >= 3 && rng() < 0.25) {
    let pool;
    do pool = shuffle(items, rng); while (pool.every((n, i) => n === items[i]));
    return { kind: 'order', start, L, items, pool, ...extra };
  }
  const h = hiddenCount(L);
  const last = p.win[start]?.lastHidden;
  let positions = items.map((_, i) => i);
  if (h === 1 && last != null) positions = positions.filter((i) => i !== last);
  let hidden = shuffle(positions, rng).slice(0, h);
  if (hidden.length < h) hidden = shuffle(items.map((_, i) => i), rng).slice(0, h);
  hidden.sort((x, y) => x - y);
  const visible = items.filter((_, i) => !hidden.includes(i));
  const options = hidden.map((i) => makeOptions(items[i], visible, optionCount(L), rng));
  return { kind: 'gap', start, L, items, hidden, options, ...extra };
}

/**
 * What to show next. Returns one of:
 *   { kind: 'preview', start, L, items }      – meet a new pair (level 2 only)
 *   { kind: 'gap' | 'order', ... }             – a question
 *   { kind: 'checkpoint-intro', level, size }  – every window mastered; offer the level test
 * Mutates p (introduces windows).
 */
export function nextTask(p, { rng = Math.random, previews = true } = {}) {
  if (p.phase === 'done') {
    const max = maxLevelFor(p.range);
    const L = 2 + Math.floor(rng() * (max - 1));
    const starts = windowStarts(p.range, L);
    return makeQuiz(p, starts[Math.floor(rng() * starts.length)], L, rng, { review: true, free: true });
  }

  if (p.phase === 'checkpoint') {
    const c = p.checkpoint;
    return makeQuiz(p, c.queue[c.index], p.level, rng, { checkpoint: true });
  }

  const L = p.level;
  const starts = windowStarts(p.range, L);
  const introduced = starts.slice(0, p.introduced);
  const unmastered = introduced.filter((s) => !winState(p, s).mastered);
  const mastered = introduced.filter((s) => winState(p, s).mastered);
  const fresh = unmastered.filter((s) => winState(p, s).streak === 0).length;

  if (p.introduced < starts.length && unmastered.length < workingSet(L) && fresh < 2) {
    const s = starts[p.introduced++];
    if (L === 2 && previews) {
      winState(p, s).lastSeen = ++p.seq;
      p.last = s;
      return { kind: 'preview', start: s, L, items: chain(s, L) };
    }
    return makeQuiz(p, s, L, rng);
  }

  if (!unmastered.length && p.introduced >= starts.length) {
    return { kind: 'checkpoint-intro', level: L, size: checkpointSize(starts.length) };
  }

  if (mastered.length && (!unmastered.length || rng() < REVIEW_CHANCE)) {
    return makeQuiz(p, pickStale(p, mastered, p.last, rng), L, rng, { review: true });
  }
  return makeQuiz(p, pickStale(p, unmastered, p.last, rng), L, rng);
}

const checkpointSize = (n) => Math.min(CHECKPOINT_SIZE, Math.max(4, n));
export const passMark = (size) => Math.ceil(size * CHECKPOINT_PASS);

/** Start the level test: half the questions on the windows missed most, the rest random. */
export function startCheckpoint(p, rng = Math.random) {
  const starts = windowStarts(p.range, p.level);
  const size = checkpointSize(starts.length);
  const weak = starts
    .filter((s) => winState(p, s).wrong > 0)
    .sort((x, y) => winState(p, y).wrong - winState(p, x).wrong)
    .slice(0, Math.floor(size / 2));
  const queue = [...weak];
  while (queue.length < size) {
    const rest = shuffle(starts.filter((s) => !queue.includes(s)), rng);
    queue.push(...(rest.length ? rest : shuffle(starts, rng)).slice(0, size - queue.length));
  }
  p.phase = 'checkpoint';
  p.checkpoint = { queue: shuffle(queue, rng), index: 0, results: [] };
}

function levelUp(p) {
  p.history.push({ level: p.level, ...p.levelStats });
  const done = p.level >= maxLevelFor(p.range);
  p.levelStats = { answered: 0, correct: 0 };
  p.checkpoint = null;
  p.last = null;
  if (done) { p.phase = 'done'; return; }
  p.level += 1;
  p.phase = 'learn';
  p.win = {};
  p.introduced = 0;
}

/**
 * Record the outcome of a question. Returns events for the UI:
 *   mastered, lost         – this window just became / stopped being mastered
 *   checkpoint: { passed, score, size, missed[] }   – level test finished
 *   levelUp: { from, to }  – next level unlocked
 *   complete: true         – the last level is done
 */
export function recordResult(p, task, ok) {
  const ev = {};
  p.stats.answered++;
  if (ok) p.stats.correct++;
  if (task.free) return ev;

  p.levelStats.answered++;
  if (ok) p.levelStats.correct++;

  const w = winState(p, task.start);
  w.seen++;
  w.lastSeen = ++p.seq;
  if (task.kind === 'gap' && task.hidden.length === 1) w.lastHidden = task.hidden[0];
  p.last = task.start;
  if (ok) {
    w.streak++;
    if (!w.mastered && w.streak >= STREAK_TO_MASTER) { w.mastered = true; ev.mastered = true; }
  } else {
    w.streak = 0;
    w.wrong++;
    if (w.mastered) { w.mastered = false; ev.lost = true; }
  }

  if (p.phase === 'checkpoint') {
    const c = p.checkpoint;
    c.results.push({ start: task.start, ok });
    c.index++;
    if (c.index >= c.queue.length) {
      const score = c.results.filter((r) => r.ok).length;
      const size = c.queue.length;
      const passed = score >= passMark(size);
      const missed = [...new Set(c.results.filter((r) => !r.ok).map((r) => r.start))];
      ev.checkpoint = { passed, score, size, missed, level: p.level };
      if (passed) {
        const from = p.level;
        levelUp(p);
        if (p.phase === 'done') ev.complete = true;
        else ev.levelUp = { from, to: p.level };
      } else {
        p.phase = 'learn';
        p.checkpoint = null;
      }
    }
  }
  return ev;
}

/** Mastered / total windows in the current level. */
export function levelProgress(p) {
  const starts = windowStarts(p.range, p.level);
  if (p.phase === 'done') return { mastered: starts.length, total: starts.length };
  const mastered = starts.filter((s) => p.win[s]?.mastered).length;
  return { mastered, total: starts.length };
}

/** 0..1 across all levels of the range. */
export function overallProgress(p) {
  if (p.phase === 'done') return 1;
  const levels = maxLevelFor(p.range) - 1;
  const { mastered, total } = levelProgress(p);
  return (p.level - 2 + mastered / total) / levels;
}

/** 0..1 strength of one surah: finished levels plus its share of mastered windows now. */
export function surahStrength(p, n) {
  if (p.phase === 'done') return 1;
  const L = p.level;
  const [a, b] = p.range;
  let total = 0;
  let mastered = 0;
  for (let s = Math.max(a, n - L + 1); s <= Math.min(n, b - L + 1); s++) {
    total++;
    if (p.win[s]?.mastered) mastered++;
  }
  const levels = maxLevelFor(p.range) - 1;
  return (L - 2 + (total ? mastered / total : 0)) / levels;
}
