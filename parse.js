// Pengganti drop-in untuk marked 18.1.3 (opsi default: gfm aktif,
// breaks mati, pedantic mati, async mati). parse(markdown)
// mengembalikan persis HTML yang dirender marked untuk string itu.
//
// Cara kerja: renderer cepat tulisan tangan (fast.js) menangani
// konstruk yang mendominasi dokumen nyata; apa pun di luar
// jangkauannya jatuh ke marked 18.1.3 yang di-vendor
// (vendor/marked/marked.esm.js, MIT, beserta LICENSE dan NOTICE-nya),
// jadi kebenaran tidak pernah bergantung pada jalur cepat saja.
// parse tidak menyimpan state antar panggilan: tiap masukan
// menghasilkan keluaran yang sama bila dipanggil sendiri.

import { marked } from './vendor/marked/marked.esm.js';
import { renderFast } from './fast.js';

/** HTML yang dirender marked 18.1.3 untuk `markdown`, dengan default marked. */
export function parse(markdown) {
  return renderFast(markdown, (input) => marked.parse(input));
}
