// Score the detector on a real PDF against ground truth.
// Usage: node tests/eval-pdf.mjs path/to/book.pdf
import fs from 'node:fs';
import * as pdfjs from '../vendor/pdf.mjs';
import { findCitations, itemsToLines } from '../js/detect.js';
import { SURAHS } from '../js/surahs.js';
import { CITED } from './groundtruth.mjs';

const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(process.argv[2])), verbosity: 0 }).promise;
let tp = 0, wrong = 0, fp = 0, total = 0, sureRight = 0, sureWrong = 0;
for (let p = 1; p <= doc.numPages; p++) {
  const lines = itemsToLines((await (await doc.getPage(p)).getTextContent()).items);
  const found = findCitations(lines);
  const truth = (CITED[p] || []).map((t) => t.join(':'));
  total += truth.length;
  for (const f of found) {
    const key = [f.surah, f.from, f.to].join(':');
    const ok = truth.includes(key);
    const sameRange = truth.some((t) => t.endsWith(`:${f.from}:${f.to}`));
    if (ok) tp++; else if (sameRange) wrong++; else fp++;
    if (f.confident) ok ? sureRight++ : sureWrong++;
    console.log(`p${p} ${ok ? '✓' : sameRange ? '✗ wrong surah' : '✗ extra'} ${SURAHS[f.surah - 1][0]} ${f.from}-${f.to} ${f.confident ? '(sure)' : '(unsure)'}  raw=${JSON.stringify(f.raw)}`);
  }
}
console.log(`\nCorrect: ${tp}/${total} | wrong surah: ${wrong} | extras: ${fp} | marked sure: ${sureRight} right, ${sureWrong} wrong`);
