// Plays a range of ayahs one after another (e.g. Fussilat 41 -> 42).
// Audio comes from everyayah.com, one MP3 per ayah: <reciter>/<SSS><AAA>.mp3
// Uthmani text for display comes from api.alquran.cloud (optional - playback works without it).

export const RECITERS = [
  { id: 'Husary_128kbps', name: 'الحصري (مرتّل)' },
  { id: 'Minshawy_Murattal_128kbps', name: 'المنشاوي (مرتّل)' },
  { id: 'Abdul_Basit_Murattal_192kbps', name: 'عبد الباسط (مرتّل)' },
  { id: 'Alafasy_128kbps', name: 'العفاسي' },
];

const pad3 = (n) => String(n).padStart(3, '0');
export const audioUrl = (reciter, surah, ayah) =>
  `https://everyayah.com/data/${reciter}/${pad3(surah)}${pad3(ayah)}.mp3`;

const textCache = new Map();
export async function ayahText(surah, ayah) {
  const key = `${surah}:${ayah}`;
  if (!textCache.has(key)) {
    textCache.set(key, fetch(`https://api.alquran.cloud/v1/ayah/${key}/quran-uthmani`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((j) => j.data.text)
      .catch(() => { textCache.delete(key); return ''; }));
  }
  return textCache.get(key);
}

export class VersePlayer extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.preloader = new Audio(); // silently downloads the next ayah so there's no gap
    this.preloader.preload = 'auto';
    this.reciter = RECITERS[0].id;
    this.queue = null; // { surah, from, to, current }
    this.audio.addEventListener('ended', () => this.#advance(1));
    this.audio.addEventListener('play', () => this.#emit());
    this.audio.addEventListener('pause', () => this.#emit());
    this.audio.addEventListener('error', () => {
      if (this.queue) this.#emit({ error: true });
    });
  }

  get playing() { return !!this.queue && !this.audio.paused; }

  /** Start playing ayahs from..to of a surah. */
  play(surah, from, to) {
    this.queue = { surah, from, to, current: from };
    this.#load();
  }

  toggle() {
    if (!this.queue) return;
    this.audio.paused ? this.audio.play().catch(() => {}) : this.audio.pause();
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.queue = null;
    this.#emit();
  }

  next() { this.#advance(1); }
  prev() { this.#advance(-1); }

  setReciter(id) {
    this.reciter = id;
    if (this.queue) this.#load(); // restart current ayah with the new voice
  }

  #advance(step) {
    const q = this.queue;
    if (!q) return;
    const n = q.current + step;
    if (n > q.to) return this.stop();   // finished the range
    if (n < q.from) return;
    q.current = n;
    this.#load();
  }

  #load() {
    const { surah, current } = this.queue;
    this.audio.src = audioUrl(this.reciter, surah, current);
    this.audio.play().catch(() => {}); // play() rejects if interrupted - harmless
    this.#emit();
    if (current < this.queue.to) this.preloader.src = audioUrl(this.reciter, surah, current + 1);
  }

  #emit(extra = {}) {
    this.dispatchEvent(new CustomEvent('change', { detail: { ...this.queue, playing: this.playing, ...extra } }));
  }
}
