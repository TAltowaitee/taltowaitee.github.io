# سلسلة السور — Surah Chain

Memorize the order of the 114 surahs by learning, for every surah, the one before and the one after.
Everything runs in the browser; progress is saved in localStorage. No build step.

## How the learning works

| Step | What happens |
|---|---|
| **Pairs (level 2)** | Consecutive pairs are introduced one at a time, in order: الفاتحة ← البقرة, البقرة ← آل عمران, … Each new pair is shown once (a "preview" card), then quizzed. |
| **Hide one** | One surah of the chain is hidden; pick it from choices that are mostly its close neighbours in the Mushaf (the real confusions). The hidden side alternates, so both "what comes after" and "what comes before" are tested. |
| **Mastery** | A chain is mastered after 2 correct answers in a row. A few unmastered chains are in rotation at once; a new one is added only when the current ones are under control. Mastered chains come back for review (~20%); a miss un-masters them. |
| **Level test** | When every chain of the level is mastered, a 10-question test (half on the chains missed most) needs 9/10. Failing sends the missed chains back to practice. |
| **Longer chains** | Levels 3 → 7 use runs of 3 … 7 surahs. From level 4 two surahs are hidden (three from level 6) with 6 choices, and some questions ask to put the whole chain in order. |
| **Free review** | After level 7 the section is complete; free review mixes all levels. |

Sections overlap by one surah (1–10, 10–20, …) so the chain stays connected across them; Juz' ʿAmma,
the whole Quran, and custom ranges are also available. The mastery map (▦) colours each surah by
how many chains containing it are mastered, across levels.

## Files

| File | Job |
|---|---|
| `index.html`, `style.css` | Arabic right-to-left UI, light/dark, phone layout |
| `js/engine.js` | Pure learning logic (scheduling, mastery, level tests, distractors); no DOM |
| `js/app.js` | Rendering, input (tap or keys 1–6 / Enter), storage, routing (`#r=<from>-<to>`) |
| `js/surahs.js` | The 114 surah names |

## Tests

```bash
node --test tests/*.test.mjs
```

Run locally: `python3 -m http.server` from the repo root, then open `http://localhost:8000/surah-chain/`.
