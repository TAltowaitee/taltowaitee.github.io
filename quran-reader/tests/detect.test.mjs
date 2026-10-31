// Unit tests for the citation detector. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCitations, rankSurahs, normalizeArabic } from '../js/detect.js';

const one = (line) => findCitations([line]).map(({ surah, from, to, confident }) => ({ surah, from, to, confident }));

test('clean citation with Arabic-Indic digits', () => {
  assert.deepEqual(one('قال تعالى: ﴿...﴾ [فصلت: ٤١-٤٢]'), [{ surah: 41, from: 41, to: 42, confident: true }]);
});

test('single ayah, Latin digits, hamza variants', () => {
  assert.deepEqual(one('[الإسراء: 9]'), [{ surah: 17, from: 9, to: 9, confident: true }]);
  assert.deepEqual(one('[الاسراء: 9]'), [{ surah: 17, from: 9, to: 9, confident: true }]);
});

test('"سورة" prefix and aliases', () => {
  assert.equal(one('[سورة البقرة: 255]')[0].surah, 2);
  assert.equal(one('[براءة: 5]')[0].surah, 9);
});

test('visually reversed text from a damaged PDF', () => {
  assert.deepEqual(one('42-41:فص['), [{ surah: 41, from: 41, to: 42, confident: true }]);
});

test('ayah count rules out short surahs', () => {
  // letters ل ر ء fit both الإسراء and الشعراء, but الإسراء has only 111 ayahs
  assert.equal(rankSurahs('ء ر ل', 195)[0].surah, 26);
});

test('hadith references in parentheses are ignored', () => {
  assert.deepEqual(one('[رواه البخاري: (5)، ومسلم: (448)]'), []);
});

test('normalization strips harakat and tatweel', () => {
  assert.equal(normalizeArabic('القِيَامَـة'), 'القيامه');
});

// A normal text-based PDF (made by a browser), where each letter is stored in drawing order.
// Regression test: detection used to find nothing in PDFs like this.
test('clean text PDF: finds every citation, skips the hadith reference', async () => {
  const fs = await import('node:fs');
  const pdfjs = await import('../vendor/pdf.mjs');
  const { itemsToLines } = await import('../js/detect.js');
  const data = new Uint8Array(fs.readFileSync(new URL('./fixtures/clean-sample.pdf', import.meta.url)));
  const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
  const found = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const { items } = await (await doc.getPage(p)).getTextContent();
    const keys = new Set(findCitations(itemsToLines(items)).filter((v) => v.confident).map((v) => `p${p} ${v.surah}:${v.from}-${v.to}`));
    found.push(...keys);
  }
  assert.deepEqual(found, ['p2 97:1-1', 'p2 2:185-185', 'p2 41:41-42', 'p4 2:255-255', 'p4 112:1-1', 'p4 36:1-2', 'p5 73:4-4']);
});
