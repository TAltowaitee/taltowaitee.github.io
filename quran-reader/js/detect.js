// Verse-citation detector.
//
// Arabic books usually cite a Quran verse right after quoting it, e.g. [البقرة: 255]
// or [فصلت: 41-42]. We find those citations in the PDF's text layer.
//
// Real-world PDFs often have a damaged text layer: letters go missing, words come out
// reversed, and the surah name may survive only as a few letters ("ل يامة" for القيامة).
// So instead of exact matching we score every surah name against the surviving letters,
// and use the ayah numbers to rule out surahs that are too short.
//
// This file has no browser dependencies, so it can be unit-tested in Node.

import { SURAHS, ALIASES } from './surahs.js';

// ---------- Text normalization ----------

const DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g; // harakat, Quranic marks, tatweel
const ARABIC_INDIC = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9,
  '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };

/** Make Arabic text comparable: unify letter variants, drop diacritics, Arabic digits -> 0-9. */
export function normalizeArabic(text) {
  return text
    .normalize('NFKC') // turns presentation forms (ﻟﻨﻤﻞ) into normal letters (لنمل)
    .replace(/\u0000/g, '')
    .replace(DIACRITICS, '')
    .replace(/[٠-٩۰-۹]/g, (d) => ARABIC_INDIC[d])
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

const lettersOnly = (s) => normalizeArabic(s).replace(/[^ء-ي]/g, '');

// Pre-compute the letters of every surah name (and its aliases) once.
const SURAH_KEYS = [];
SURAHS.forEach(([name], i) => {
  const n = i + 1;
  for (const label of [name, ...(ALIASES[n] || [])]) {
    SURAH_KEYS.push({ surah: n, letters: lettersOnly(label) });
  }
});

// ---------- Surah name matching ----------

function countLetters(str) {
  const m = new Map();
  for (const c of str) m.set(c, (m.get(c) || 0) + 1);
  return m;
}

const isSubsequence = (needle, hay) => {
  let i = 0;
  for (const c of hay) if (c === needle[i]) i++;
  return i === needle.length;
};

/**
 * Rank surahs for a (possibly damaged) name fragment.
 * @param {string} fragment  whatever text sat between "[" and the ":" in the citation
 * @param {number} maxAyah   highest ayah number cited - the surah must be at least this long
 * @returns {{surah:number, score:number}[]} best first
 */
export function rankSurahs(fragment, maxAyah) {
  let frag = lettersOnly(fragment).replace(/^سوره/, '');
  if (!frag) return [];
  const fragCounts = countLetters(frag);
  const best = new Map(); // surah -> best score among its names

  for (const { surah, letters } of SURAH_KEYS) {
    if (SURAHS[surah - 1][1] < maxAyah) continue; // surah too short for this ayah number
    if (letters === frag || letters === 'ال' + frag) { best.set(surah, 10); continue; } // exact

    // How many fragment letters can be found in this name (order-independent)?
    const nameCounts = countLetters(letters);
    let found = 0;
    for (const [c, k] of fragCounts) found += Math.min(k, nameCounts.get(c) || 0);
    const precision = found / frag.length;   // 1.0 = every surviving letter belongs to this name
    const coverage = found / letters.length; // how much of the name survived
    if (precision < 0.75) continue;

    let score = precision * 2 + coverage;
    // Letters in the right order are stronger evidence; reversed order still counts a bit
    // (some PDFs store right-to-left words backwards).
    if (isSubsequence(frag, letters)) score += 0.5;
    else if (isSubsequence([...frag].reverse().join(''), letters)) score += 0.3;
    // Fragment matches the start of the name (ignoring "ال")
    if (frag.length >= 2 && letters.replace(/^ال/, '').startsWith(frag.replace(/^ال/, ''))) score += 0.4;
    if (score > (best.get(surah) || 0)) best.set(surah, score);
  }

  return [...best.entries()]
    .map(([surah, score]) => ({ surah, score }))
    .sort((a, b) => b.score - a.score);
}

// ---------- Citation finding ----------

const NUMS = String.raw`(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?`;
const NAME = String.raw`([^\[\]\d(){}]{1,40}?)`;
// "[البقرة: 255]" - logical order
const FORWARD = new RegExp(String.raw`^\[\s*${NAME}\s*[:：]\s*${NUMS}(?!\s*\))`);
// "255 :البقرة[" - visual order, as some PDFs store right-to-left text
const REVERSED = new RegExp(String.raw`(?<!\()${NUMS}\s*${NAME}\[$`);

/**
 * Find verse citations in the lines of one page.
 * @param {string[]} lines  text lines of the page
 * @returns {{surah:number, from:number, to:number, confident:boolean, alternatives:number[], raw:string}[]}
 */
export function findCitations(lines) {
  const out = [];
  for (const rawLine of lines) {
    const line = normalizeArabic(rawLine);
    for (let i = line.indexOf('['); i !== -1; i = line.indexOf('[', i + 1)) {
      let m = line.slice(i).match(FORWARD);
      let name, a, b;
      if (m) {
        [, name, a, b] = m;
      } else {
        m = line.slice(0, i + 1).match(REVERSED);
        if (!m || !/[:：]/.test(m[3])) continue; // reversed form must still contain the colon
        [, a, b, name] = m;
      }
      const nums = [a, b].filter(Boolean).map(Number);
      const from = Math.min(...nums), to = Math.max(...nums);
      if (from < 1 || to - from > 60) continue; // not a plausible ayah range

      const ranked = rankSurahs(name, to);
      if (!ranked.length) continue;
      const [top, second] = ranked;
      const confident = top.score >= 10 || (top.score >= 2.5 && (!second || top.score - second.score >= 0.4));
      out.push({
        surah: top.surah, from, to, confident,
        alternatives: ranked.slice(1, 4).map((r) => r.surah),
        raw: m[0].trim(),
      });
    }
  }
  return out;
}

// ---------- pdf.js helpers ----------

/**
 * Group pdf.js text items into visual lines (same baseline), ordered left-to-right.
 * @param {{str:string, transform:number[]}[]} items  from page.getTextContent().items
 */
export function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str) continue;
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 4);
    if (!row) rows.push((row = { y, items: [] }));
    row.items.push(it);
  }
  rows.sort((a, b) => b.y - a.y); // top of page first
  return rows.map((r) => r.items.sort((a, b) => a.transform[4] - b.transform[4]).map((i) => i.str).join(''));
}
