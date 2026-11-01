// Built-in books shown on the home screen.
// Hard-coded for now - this list is what a database will provide later.
// Each book's checked verse list lives in books/<fingerprint>.json.
export const LIBRARY = [
  {
    id: 'dalil-1',
    file: 'books/dalil-ila-alquran.pdf',
    fingerprint: '7b358a0eaf470e459c010810e0b57b99',
    title: 'الدليل إلى القرآن',
    part: 'ص ١١–٣٤',
    author: 'عمرو صبحي الشرقاوي',
    pages: 26,
    verses: 35,
  },
  {
    id: 'dalil-2',
    file: 'books/dalil-ila-alquran-2.pdf',
    fingerprint: '7c025c53e4781946bb2b9fe58baecd77',
    title: 'الدليل إلى القرآن',
    part: 'ص ٣٥–٥٧',
    author: 'عمرو صبحي الشرقاوي',
    pages: 23,
    verses: 11,
  },
];
