// Unit tests for the learning engine. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProgress, nextTask, recordResult, startCheckpoint, makeOptions, makeQuiz,
  windowStarts, levelProgress, overallProgress, surahStrength, maxLevelFor,
} from '../js/engine.js';

// Small seeded RNG so runs are repeatable.
const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

/** The answer a perfect learner gives. */
const correct = (t) => true;

/** Drive the engine until `stop(p)`; `answer(task)` decides right/wrong. */
function run(p, answer, { rng = seeded(7), limit = 20000, stop = (p) => p.phase === 'done' } = {}) {
  const events = [];
  let n = 0;
  while (!stop(p) && n++ < limit) {
    const t = nextTask(p, { rng });
    if (t.kind === 'preview') continue;
    if (t.kind === 'checkpoint-intro') { startCheckpoint(p, rng); continue; }
    events.push(recordResult(p, t, answer(t)));
  }
  return { events, steps: n };
}

test('windows chain with overlap', () => {
  assert.deepEqual(windowStarts([2, 5], 2), [2, 3, 4]);
  assert.deepEqual(windowStarts([2, 5], 3), [2, 3]);
  assert.equal(maxLevelFor([1, 114]), 7);
  assert.equal(maxLevelFor([1, 4]), 4);
});

test('first tasks: pairs introduced in order, previews interleaved with questions', () => {
  const p = createProgress([1, 114]);
  const rng = seeded(3);
  const t1 = nextTask(p, { rng });
  assert.equal(t1.kind, 'preview');
  assert.deepEqual(t1.items, [1, 2]);
  const t2 = nextTask(p, { rng });
  assert.equal(t2.kind, 'preview');
  assert.deepEqual(t2.items, [2, 3]);
  const t3 = nextTask(p, { rng });
  assert.equal(t3.kind, 'gap'); // two fresh pairs: quiz before introducing a third
  assert.equal(t3.start, 1); // least recently seen
});

test('options: contain the answer once, no visible surah, right count', () => {
  const rng = seeded(11);
  for (let ans = 1; ans <= 114; ans++) {
    const visible = [ans - 1, ans + 1].filter((n) => n >= 1 && n <= 114);
    const opts = makeOptions(ans, visible, 4, rng);
    assert.equal(opts.length, 4);
    assert.equal(new Set(opts).size, 4);
    assert.ok(opts.includes(ans));
    for (const v of visible) assert.ok(!opts.includes(v));
    for (const o of opts) assert.ok(o >= 1 && o <= 114);
  }
});

test('gap questions alternate the hidden surah in a pair', () => {
  const p = createProgress([1, 10]);
  const rng = seeded(5);
  p.win[1] = { streak: 1, seen: 1, wrong: 0, mastered: false, lastSeen: 0, lastHidden: 0 };
  for (let i = 0; i < 20; i++) assert.deepEqual(makeQuiz(p, 1, 2, rng).hidden, [1]);
});

test('higher levels hide more and sometimes ask to order', () => {
  const p = createProgress([1, 114]);
  const rng = seeded(9);
  const kinds = new Set();
  for (let i = 0; i < 200; i++) {
    const q = makeQuiz(p, 10, 6, rng);
    kinds.add(q.kind);
    if (q.kind === 'gap') { assert.equal(q.hidden.length, 3); assert.equal(q.options[0].length, 6); }
    else assert.notDeepEqual(q.pool, q.items);
  }
  assert.deepEqual([...kinds].sort(), ['gap', 'order']);
});

test('a perfect learner climbs every level to done', () => {
  const p = createProgress([78, 114]);
  const { events } = run(p, correct);
  assert.equal(p.phase, 'done');
  const ups = events.filter((e) => e.levelUp).map((e) => e.levelUp.to);
  assert.deepEqual(ups, [3, 4, 5, 6, 7]);
  assert.ok(events.at(-1).complete);
  assert.equal(p.history.length, 6);
  assert.equal(overallProgress(p), 1);
});

test('no level up until every window is mastered and the test is passed', () => {
  const p = createProgress([1, 20]);
  const rng = seeded(2);
  let sawIntro = false;
  for (let i = 0; i < 5000 && p.level === 2; i++) {
    const t = nextTask(p, { rng });
    if (t.kind === 'preview') continue;
    if (t.kind === 'checkpoint-intro') {
      sawIntro = true;
      const { mastered, total } = levelProgress(p);
      assert.equal(mastered, total);
      startCheckpoint(p, rng);
      continue;
    }
    recordResult(p, t, rng() < 0.85);
  }
  assert.ok(sawIntro);
  assert.equal(p.level, 3);
});

test('failing the level test sends missed windows back to practice', () => {
  const p = createProgress([1, 12]);
  const rng = seeded(4);
  run(p, correct, { rng, stop: (p) => p.phase === 'checkpoint' });
  let ev;
  while (p.phase === 'checkpoint') {
    const t = nextTask(p, { rng });
    ev = recordResult(p, t, false);
  }
  assert.equal(ev.checkpoint.passed, false);
  assert.equal(p.level, 2);
  assert.equal(p.phase, 'learn');
  assert.ok(ev.checkpoint.missed.length > 0);
  for (const s of ev.checkpoint.missed) assert.equal(p.win[s].mastered, false);
});

test('level test focuses on windows that were missed', () => {
  const p = createProgress([1, 114]);
  const rng = seeded(8);
  for (const s of windowStarts(p.range, 2)) p.win[s] = { streak: 2, seen: 2, wrong: 0, mastered: true, lastSeen: 0, lastHidden: 0 };
  p.introduced = 113;
  p.win[40].wrong = 3;
  p.win[77].wrong = 1;
  startCheckpoint(p, rng);
  assert.equal(p.checkpoint.queue.length, 10);
  assert.ok(p.checkpoint.queue.includes(40) && p.checkpoint.queue.includes(77));
});

test('a mistake on a mastered window un-masters it', () => {
  const p = createProgress([1, 10]);
  p.win[3] = { streak: 2, seen: 2, wrong: 0, mastered: true, lastSeen: 0, lastHidden: 0 };
  const ev = recordResult(p, { kind: 'gap', start: 3, L: 2, hidden: [1] }, false);
  assert.ok(ev.lost);
  assert.equal(p.win[3].mastered, false);
});

test('surah strength grows with mastered windows', () => {
  const p = createProgress([1, 10]);
  assert.equal(surahStrength(p, 5), 0);
  p.win[4] = { mastered: true }; // 4–5
  p.win[5] = { mastered: true }; // 5–6
  assert.ok(Math.abs(surahStrength(p, 5) - 1 / 6) < 1e-9);
});
