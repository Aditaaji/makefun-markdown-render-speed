// fast.js — renderer cepat yang keluarannya sama persis (byte-identical)
// dengan marked 18.1.3 pada opsi default (gfm aktif, breaks mati,
// pedantic mati, async mati). Dibuat untuk kompetisi make.fun
// "markdown-render-speed-02".
//
// Susunan file ini:
//   A. Helper string kecil yang dipakai kedua mesin.
//   B. Kelas karakter (punct, word, dsb.) untuk aturan emphasis.
//   C. Pola inline, pemindai label/link, dan masking delimiter.
//   D. Inline — tokenizer/renderer inline (satu instance per dokumen).
//   E. Pengenal baris level blok dan pemindai definisi.
//   F. BlockLexer — tokenizer blok (list dan blockquote memakai
//      instance baru yang berbagi tabel link).
//   G. Pola list/blockquote dan cache-nya.
//   H. Renderer: token blok -> HTML.
//   I. renderFast — titik masuk, dengan fallback per blok ke marked
//      yang di-vendor.
//
// Jalur cepat hanya mengklaim dokumen yang bisa dirender persis;
// masukan pendek langsung ke marked, dan tiap blok yang gagal
// dilempar ke marked, jadi kesalahan jalur cepat berujung pada
// keluaran marked, bukan keluaran salah.

// ================================================================ A. helper string

// Cek paren berimbang pada sebuah string (backslash melewati karakter
// berikutnya). -1 = tidak ada paren, atau berimbang; -2 = ada '(' yang
// tidak tertutup; >= 0 = indeks ')' yang tidak berpasangan.
function parenCheck(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\') i++;
    else if (c === pair[0]) depth++;
    else if (c === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Kembangkan tab jadi spasi dengan melacak kolom mulai dari `start`.
function expandTabStops(str, start = 0) {
  let col = start;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Dedent isi fenced code sebesar indent baris pembuka fence.
const FENCE_INDENT = /^(\s+)(?:```)/;
const LEAD_WS = /^[\s]+/;

function dedentCode(fenceLine, content) {
  const m = fenceLine.match(FENCE_INDENT);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const leading = line.match(LEAD_WS);
    if (leading === null) return line;
    return line.slice(Math.min(leading[0].length, indent.length));
  }).join('\n');
}

// Escaping HTML. encode=true meng-escape semua & < > " '; encode=false
// (noEncode milik marked) membiarkan & yang memulai entity atau
// referensi numerik yang valid.
const ESC_TEST = /[&<>"']/;
const ESC_TEST_KEEP_ENT = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_RE = /[&<>"']/g;
const ESC_RE_KEEP_ENT = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const HTML_ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escHtml(text, encode) {
  if (encode) {
    if (ESC_TEST.test(text)) return text.replace(ESC_RE, (ch) => HTML_ESC_MAP[ch]);
    return text;
  }
  if (ESC_TEST_KEEP_ENT.test(text)) return text.replace(ESC_RE_KEEP_ENT, (ch) => HTML_ESC_MAP[ch]);
  return text;
}

// Hanya decode referensi karakter numerik — marked tidak pernah
// mendekode named entity. &#0;, surrogate, dan nilai di atas 0x10FFFF
// jadi U+FFFD; &#38; jadi "&amp;" (pemanggil meng-escape ulang);
// &#60; jadi "&lt;".
const NUMREF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMREF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumRefs(text) {
  if (!NUMREF_TEST.test(text)) return text;
  return text.replace(NUMREF_RE, (match, decimal, hex) => {
    if (decimal === undefined && hex === undefined) return '&amp;';
    const code = decimal === undefined ? parseInt(hex, 16) : parseInt(decimal, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// tidyHref: encodeURI, lalu kembalikan %25 menjadi %. Satu lone
// surrogate membuat encodeURI melempar, dan link itu gugur.
const PCT_RE = /%25/g;

function tidyHref(href) {
  try {
    return encodeURI(href).replace(PCT_RE, '%');
  } catch {
    return null;
  }
}

// Buang baris kosong di ujung, sisakan paling banyak satu.
const BLANK_RE = /^[ \t]*$/;

function trimTrailingBlank(text) {
  const parts = text.split('\n');
  let last = parts.length - 1;
  while (last >= 0 && BLANK_RE.test(parts[last])) last--;
  if (parts.length - last <= 2) return text;
  return parts.slice(0, last + 1).join('\n');
}

// Normalisasi label referensi link: trim, lipat whitespace dalam jadi
// satu spasi, lalu lowercase/uppercase/lowercase (perkiraan Unicode
// case fold, mengikuti marked).
const WS_RUN = /\s+/g;

function foldLabel(label) {
  return label.trim().replace(WS_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Pecah satu baris tabel jadi sel. \| tetap literal; sel di-trim;
// sel kosong di tepi dibuang; dengan `count` baris dipotong/ditambah
// sampai tepat sebanyak itu.
const PIPE_ALL = /\|/g;
const PIPE_SEP = / \|/;
const ESCAPED_PIPE = /\\\|/g;

function splitRowCells(row, count) {
  const markedPipes = row.replace(PIPE_ALL, (ch, offset, whole) => {
    let escaped = false;
    for (let pos = offset; --pos >= 0 && whole[pos] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = markedPipes.split(PIPE_SEP);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1).trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(ESCAPED_PIPE, '|');
  return cells;
}

// ================================================================ B. kelas karakter

// Satu karakter punctuation/symbol Unicode.
const PUNCT_SYM = /[\p{P}\p{S}]/u;
const ALNUM_CLASS = /[\p{L}\p{N}]/u;

function isPunctCh(ch) {
  return ch !== '' && PUNCT_SYM.test(ch);
}
// "punct" GFM: punctuation/symbol kecuali '~'.
function isGfmPunctCh(ch) {
  return ch !== '' && ch !== '~' && PUNCT_SYM.test(ch);
}
// "notPunctSpace" GFM: bukan whitespace dan bukan punct/symbol — atau '~'.
function isGfmWordCh(ch) {
  return ch !== '' && (ch === '~' || (!/\s/.test(ch) && !PUNCT_SYM.test(ch)));
}
// "punctSpace" GFM: whitespace atau punct/symbol, kecuali '~'.
function isGfmPunctSpaceCh(ch) {
  return ch !== '' && ch !== '~' && (/\s/.test(ch) || PUNCT_SYM.test(ch));
}
// "notPunctSpace" / "punctSpace" non-GFM: di sini '~' dihitung
// punctuation. Dipakai closer '_' dan closer '~', yang keduanya memakai
// pengganti non-GFM — hanya '*' yang memakai versi GFM di atas.
function isPlainWordCh(ch) {
  return ch !== '' && !/\s/.test(ch) && !PUNCT_SYM.test(ch);
}
function isPlainPunctSpaceCh(ch) {
  return ch !== '' && (/\s/.test(ch) || PUNCT_SYM.test(ch));
}
function isAlnumCh(ch) {
  return ch !== '' && ALNUM_CLASS.test(ch);
}
// Cek punctuation untuk opener emphasis/del: whitespace atau
// punct/symbol, tapi bukan '*' atau '_'.
function isOpenerPunctCh(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && (/\s/.test(ch) || PUNCT_SYM.test(ch));
}

// ================================================================ C. pola inline

const ASCII_PUNCT_SET = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
// Escape backslash: backslash + punctuation ASCII.
const BACKSLASH_ESC = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const HTML_TAG = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const OPEN_ANCHOR = /^<a /i;
const CLOSE_ANCHOR = /^<\/a>/i;
const OPEN_RAW_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const CLOSE_RAW_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
// Autolink GFM tambahan: mailto:/xmpp: | scheme://... | www.... | email.
const EMAIL_ADDR = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_SCHEME = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;
const EXTENDED_URL = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const SKIP_BLOCKS = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const REF_LINK = /!?\[(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?\]\[(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}\]|!?\[(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}\](?:\[\])?(?!\()/g;
const INLINE_LINK_START = /^!?\[.*\]\(/s;

// Selesaikan escape backslash atas punctuation di dalam href/title.
const ESCAPED_PUNCT = /\\([\p{P}\p{S}])/gu;
function unescPunct(str) {
  return str.replace(ESCAPED_PUNCT, '$1');
}

// ']' yang cocok dengan '[' di src[j], dengan satu tingkat grup [..]
// bersarang di dalamnya. Kembalikan indeks ']' yang cocok, atau -1.
function findCloseBracket(src, j) {
  const n = src.length;
  let k = j + 1;
  while (k < n) {
    const ch = src[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '[') {
      let m = k + 1;
      let ok = false;
      while (m < n) {
        const inner = src[m];
        if (inner === '\\') { m += 2; continue; }
        if (inner === '[') break;
        if (inner === ']') { ok = true; break; }
        m++;
      }
      if (!ok) return -1;
      k = m + 1;
      continue;
    }
    if (ch === ']') return k;
    k++;
  }
  return -1;
}

// Pindai [label] mulai dari src[i] === '['. Kembalikan {label, end}
// dengan end indeks tepat setelah ']' penutup, atau null. Grup
// bersarang hanya satu tingkat (pola label marked hanya mengizinkan
// satu grup [...] di dalam).
function scanLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      // Code span di dalam label: pola marked mengizinkan run backtick
      // penutup dengan panjang BERAPA PUN, tidak harus sama dengan
      // pembuka — mis. `` ``url` `` adalah satu code span. Tapi pola itu
      // juga punya alternatif `` ``+(?=\]) `` — run DUA backtick atau
      // lebih tepat sebelum ']' — dan pencocokan lazy-nya memilih label
      // yang lebih pendek, jadi cek itu DULU (hanya untuk run panjang
      // >= 2): run seperti itu mengakhiri label di sini, bukan merentang
      // ke backtick yang jauh. Satu backtick sebelum ']' TIDAK cocok
      // dengan alternatif itu, jadi ia harus berupa code span (cari run
      // penutup) atau labelnya gagal.
      let k = j;
      while (k < n && src[k] === '`') k++;
      if (k - j >= 2 && src[k] === ']') { j = k; continue; }
      let m = k;
      let found = -1;
      while (m < n) {
        if (src[m] === '`') { found = m; break; }
        m++;
      }
      if (found >= 0) {
        let q = found;
        while (q < n && src[q] === '`') q++;
        j = q;
        continue;
      }
      return null;
    }
    if (ch === '[') {
      const m = findCloseBracket(src, j);
      if (m < 0) return null;
      j = m + 1;
      continue;
    }
    if (ch === ']') return { label: src.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

// Apakah label mengandung tag yang mulai di dalamnya dan berjalan
// melewati ujungnya (cek marked untuk tag yang meluber keluar label)?
// `labelStart` indeks karakter pertama label di `src`; `labelLen`
// panjangnya.
function tagSpillsFromLabel(src, labelStart, labelLen) {
  const label = src.slice(labelStart, labelStart + labelLen);
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = CODE_SPAN.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(labelStart + s);
    const match = HTML_TAG.exec(rest) || AUTOLINK.exec(rest);
    if (match) {
      if (match[0].length > label.length - s) return true;
      s += match[0].length - 1;
    }
  }
  return false;
}

// Apakah ada link (inline atau referensi) di dalam `text`? Dipakai
// langkah masking dan cek tokenizer reference-link itu sendiri.
function hasAnyLink(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(SKIP_BLOCKS)) {
    if (INLINE_LINK_START.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REF_LINK)) {
    const str = m[0];
    const lastBracket = str.lastIndexOf('[');
    if (!(str.charAt(0) === '!' || !Object.hasOwn(links, foldLabel(str.slice(lastBracket + 1, -1)))) &&
        !(lastBracket > 1 && hasAnyLink(str.slice(1, lastBracket - 1), links))) return true;
  }
  return false;
}

// Mask satu kecocokan reference-link untuk pencarian closer
// emphasis/delimiter: teks label diganti filler supaya run delimiter
// di dalam label referensi yang terdefinisi tidak bisa menutup emphasis.
function maskReference(match, links) {
  const lastBracket = match.lastIndexOf('[');
  if (!Object.hasOwn(links, foldLabel(match.slice(lastBracket + 1, -1)))) return match;
  if (lastBracket > 1 && match.charAt(0) !== '!') {
    const inner = match.slice(1, lastBracket - 1);
    if (hasAnyLink(inner, links)) {
      return '[' + inner.replace(REF_LINK, (m) => maskReference(m, links)) + '][' +
        'a'.repeat(match.length - lastBracket - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match.length - 2) + ']';
}

// Mask string kontainer untuk pencarian closer emphasis/delimiter:
// sembunyikan run delimiter yang ada di dalam link, code span, tag
// HTML, label referensi terdefinisi, dan punctuation yang di-escape.
// Mask menjaga panjang, jadi posisi di string hasil mask sejajar
// dengan string aslinya.
function maskDelims(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    masked = masked.replace(REF_LINK, (m) => maskReference(m, links));
  }
  // Dua pass masking di bawah hanya mengubah sesuatu bila teks
  // mengandung backtick/backslash (masking punct) atau
  // bracket/backtick/angle-bracket (skip blok); lewati pemindaian
  // regex yang mahal bila tidak ada.
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(PUNCT_OUTSIDE_CODE, (whole, span, escaped) => {
      if (escaped) return '+'.repeat(whole.length);
      if (span) return span + whole.slice(span.length, -span.length).replace(/`/g, '+') + span;
      return whole;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(SKIP_BLOCKS, (whole, _before, codeRun) => {
      const prefixLen = codeRun ? codeRun.length : 0;
      return whole.slice(0, prefixLen) + '[' + 'a'.repeat(whole.length - prefixLen - 2) + ']';
    });
  }
  return masked;
}

// Code point yang berakhir tepat sebelum indeks `idx`, dan yang mulai
// di `idx` (sadar surrogate-pair — aturan closer berjalan dengan flag `u`).
function cpBefore(str, idx) {
  if (idx <= 0) return '';
  const low = str.charCodeAt(idx - 1);
  if (low >= 0xDC00 && low <= 0xDFFF && idx >= 2) {
    const high = str.charCodeAt(idx - 2);
    if (high >= 0xD800 && high <= 0xDBFF) return str.slice(idx - 2, idx);
  }
  return str[idx - 1];
}
function cpAfter(str, idx) {
  if (idx >= str.length) return '';
  const high = str.charCodeAt(idx);
  if (high >= 0xD800 && high <= 0xDBFF && idx + 1 < str.length) {
    const low = str.charCodeAt(idx + 1);
    if (low >= 0xDC00 && low <= 0xDFFF) return str.slice(idx, idx + 2);
  }
  return str[idx];
}

// Klasifikasikan run delimiter untuk pencarian closer (grup delimiter
// marked). `ch` adalah '*' atau '_' atau '~'; `prev` karakter sebelum
// run ('' di awal), `next` karakter sesudahnya ('' di akhir).
// Kembalikan 0 (bukan closer sama sekali), 1/2 (closer biasa), 3/4
// (tidak bisa menutup — terserap ke hitungan opener), 5/6 (closer
// kondisional — rule of 3s / cek karakter sebelumnya).
function closerKind(ch, prev, next) {
  if (ch === '~') {
    // '~' memakai kelas non-GFM: '~' ADALAH punct/punctSpace, BUKAN
    // notPunctSpace.
    if (isPunctCh(prev) && (next === '' || /\s/.test(next))) return 1;
    if (isPlainWordCh(prev) && (next === '' || isPlainPunctSpaceCh(next))) return 2;
    if (isPlainPunctSpaceCh(prev) && isPlainWordCh(next)) return 3;
    if (prev !== '' && /\s/.test(prev) && isPunctCh(next)) return 4;
    if (isPunctCh(prev) && isPunctCh(next)) return 5;
    if (isPlainWordCh(prev) && isPlainWordCh(next)) return 6;
    return 0;
  }
  if (ch === '_') {
    // '_' juga memakai kelas non-GFM. Catatan: tidak ada grup 6 untuk
    // '_' ('_' intraword tidak bisa menutup).
    if (isPunctCh(prev) && (next === '' || /\s/.test(next))) return 1;
    if (isPlainWordCh(prev) && (next === '' || isPlainPunctSpaceCh(next))) return 2;
    if (isPlainPunctSpaceCh(prev) && isPlainWordCh(next)) return 3;
    if (prev !== '' && /\s/.test(prev) && isPunctCh(next)) return 4;
    if (isPunctCh(prev) && isPunctCh(next)) return 5;
    return 0;
  }
  // '*' memakai kelas GFM: '~' BUKAN punct/punctSpace, TAPI
  // notPunctSpace.
  if (isGfmPunctCh(prev) && (next === '' || /\s/.test(next))) return 1;
  if (isGfmWordCh(prev) && (next === '' || isGfmPunctSpaceCh(next))) return 2;
  if (isGfmPunctSpaceCh(prev) && isGfmWordCh(next)) return 3;
  if (prev !== '' && /\s/.test(prev) && isGfmPunctCh(next)) return 4;
  if (isGfmPunctCh(prev) && isGfmPunctCh(next)) return 5;
  if (isGfmWordCh(prev) && isGfmWordCh(next)) return 6;
  return 0;
}

// Alternatif "skip" dari aturan closer: saat mencari closer untuk `ch`,
// rentang `__...*...__` (untuk '*') atau `**..._...**` (untuk '_')
// dilewati utuh. Kembalikan indeks untuk lanjut memindai, atau -1.
function skipEmphasis(masked, from, ch) {
  const open = ch === '*' ? '__' : '**';
  const inner = ch === '*' ? '*' : '_';
  const n = masked.length;
  // `open` pertama harus delimiter pertama di teks (tidak ada * atau _
  // sebelumnya).
  let first = -1;
  for (let i = from; i < n; i++) {
    const c = masked[i];
    if (c === '*' || c === '_') {
      if (masked.startsWith(open, i)) first = i;
      break;
    }
  }
  if (first < 0) return -1;
  let second = -1;
  for (let i = first + 2; i < n; i++) {
    const c = masked[i];
    if (c === '*' || c === '_') {
      if (c === inner) second = i;
      break;
    }
  }
  if (second < 0) return -1;
  let third = -1;
  for (let i = second + 1; i < n; i++) {
    const c = masked[i];
    if (c === '*' || c === '_') {
      if (masked.startsWith(open, i)) third = i;
      break;
    }
  }
  if (third < 0) return -1;
  return third;
}

// ================================================================ D. mesin inline

// Cari email GFM yang valid mulai pada atau setelah `from` (posisi
// mulai mencari '@'); kembalikan indeks awalnya, atau -1.
const EMAIL_LOCAL_CH = /[A-Za-z0-9._+-]/;
const EMAIL_DOMAIN = /^[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;

// Karakter local-part email, lewat kode karakter (lebih cepat dari tes
// regex).
function emailLocalCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 46 || code === 95 || code === 43 || code === 45;
}

// Akhir chunk teks saat ini (aturan text GFM marked, diimplementasi
// sebagai pemindaian, bukan regex lazy). `i` adalah awal chunk. Satu
// pass menggantikan ~15 pemindaian indexOf.
function chunkEnd(src, i) {
  const n = src.length;
  let firstEnd = i + 1;
  if (src[i] === '`' || src[i] === '~') {
    while (firstEnd < n && src[firstEnd] === src[i]) firstEnd++;
  }
  for (let p = firstEnd; p < n; p++) {
    const code = src.charCodeAt(p);
    switch (code) {
      case 92: case 60: case 33: case 91: case 96: case 42: case 126: case 95: // \ < ! [ ` * ~ _
        return p;
      case 119: // w — www. (perlu batas sebelumnya)
        if (src.startsWith('www.', p)) {
          const prev = p === 0 ? '' : src[p - 1];
          if (prev === '' || /\s/.test(prev) || prev === '*' || prev === '_' || prev === '~' || prev === '(') return p;
        }
        break;
      case 109: // m — mailto:
        if (src.startsWith('mailto:', p)) {
          const prev = p === 0 ? '' : src[p - 1];
          if (prev === '' || !/[a-zA-Z0-9]/.test(prev)) return p;
        }
        break;
      case 120: // x — xmpp:
        if (src.startsWith('xmpp:', p)) {
          const prev = p === 0 ? '' : src[p - 1];
          if (prev === '' || !/[a-zA-Z0-9]/.test(prev)) return p;
        }
        break;
      case 58: // : — protocol://
        if (src.startsWith('://', p)) {
          let q = p;
          while (q > 0) {
            const d = src.charCodeAt(q - 1);
            if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) q--;
            else break;
          }
          if (q >= firstEnd) {
            const scheme = src.slice(q, p).toLowerCase();
            if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') return q;
          }
        }
        break;
      case 64: // @ — email
        {
          let start = p;
          while (start > 0 && emailLocalCode(src.charCodeAt(start - 1))) start--;
          if (start < p && EMAIL_DOMAIN.test(src.slice(p + 1))) return start <= i ? firstEnd : start;
        }
        break;
      case 10: // \n — hard break: 2+ spasi sebelumnya
        {
          let q = p - 1;
          let spaces = 0;
          while (q >= firstEnd && src.charCodeAt(q) === 32) { spaces++; q--; }
          if (spaces >= 2) return q + 1;
        }
        break;
    }
  }
  return n;
}

// Tokenizer/renderer inline. Satu instance melayani satu dokumen:
// `links` adalah tabel definisi referensi dokumen dan `st` adalah
// state inline bersama — lexer marked menyimpan SATU state untuk semua
// parse inline, hanya me-reset `inRawBlock` sebelum token inline tiap
// blok, sementara `inLink` bertahan antar blok (tag `<a ...>` yang
// tidak tertutup mematikan linkifikasi url/email GFM untuk sisa
// dokumen).
class Inline {
  constructor(links, st) {
    this.links = links;
    this.st = st || { inLink: false, linkEmitted: false, inRawBlock: false };
  }

  // Parse markdown inline jadi HTML (atau teks polos bila textMode
  // true — teks label sebuah image, atau isi teks sebuah heading).
  render(src, textMode = false) {
    const n = src.length;
    if (n === 0) return '';
    const links = this.links;
    const st = this.st;
    const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = hasDelim ? maskDelims(src, links) : src;
    const parenPossible = src.includes(')');
    let out = '';
    let i = 0;
    let prevLast = ''; // karakter terakhir token sebelumnya (untuk emStrong/del)
    let wasText = false;
    while (i < n) {
      if (!wasText) prevLast = '';
      wasText = false;
      const ch = src[i];
      // 1. Escape — dalam textMode karakternya dikembalikan mentah
      // (renderer text marked merender token escape lewat method
      // text()-nya).
      if (ch === '\\' && i + 1 < n && ASCII_PUNCT_SET.has(src[i + 1])) {
        out += textMode ? src[i + 1] : escHtml(src[i + 1]);
        i += 2;
        continue;
      }
      // 2. Tag HTML mentah.
      if (ch === '<') {
        const m = HTML_TAG.exec(src.slice(i));
        if (m) {
          const tag = m[0];
          if (!st.inLink && OPEN_ANCHOR.test(tag)) st.inLink = true;
          else if (st.inLink && CLOSE_ANCHOR.test(tag)) st.inLink = false;
          if (!st.inRawBlock && OPEN_RAW_TAG.test(tag)) st.inRawBlock = true;
          else if (st.inRawBlock && CLOSE_RAW_TAG.test(tag)) st.inRawBlock = false;
          out += tag;
          i += tag.length;
          continue;
        }
      }
      // 3. Link / image inline.
      if (parenPossible && (ch === '[' || (ch === '!' && src[i + 1] === '['))) {
        const lk = this.scanInlineLink(src, i);
        if (lk) {
          const made = this.makeLink(lk.label, lk.href, lk.title, lk.isImage, lk.end, textMode);
          if (made) {
            out += made.html;
            i = made.end;
            continue;
          }
          // Link dibuang (ada link bersarang di dalam) — jatuh ke teks.
        }
      }
      // 4. Link / image referensi.
      if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
        const rl = this.scanRefLink(src, i);
        if (rl) {
          if (tagSpillsFromLabel(src, (rl.isImage ? i + 1 : i) + 1, rl.label.length)) {
            // Tag melintasi label — bukan link; jatuh ke teks.
          } else {
            const def = links[foldLabel(rl.ref || rl.label)];
            if (def) {
              const made = this.makeLink(rl.label, def.href, def.title, rl.isImage, rl.end, textMode);
              if (made) {
                out += made.html;
                i = made.end;
                continue;
              }
            } else {
              // Tidak ter-resolve: hanya karakter pertama jadi teks.
              const first = src[i];
              out += textMode ? escHtml(first) : escHtml(decodeNumRefs(first));
              i += 1;
              if (first !== '_') prevLast = first;
              wasText = true;
              continue;
            }
          }
        }
      }
      // 5. Emphasis / strong.
      if (ch === '*' || ch === '_') {
        const em = this.tryEm(src, masked, i, prevLast, textMode);
        if (em) {
          out += em.html;
          i = em.end;
          continue;
        }
      }
      // 6. Code span.
      if (ch === '`') {
        const m = CODE_SPAN.exec(src.slice(i));
        if (m) {
          let span = m[2].replace(/\n/g, ' ');
          if (/[^ ]/.test(span) && /^ /.test(span) && / $/.test(span)) span = span.substring(1, span.length - 1);
          out += textMode ? span : '<code>' + escHtml(span, true) + '</code>';
          i += m[0].length;
          continue;
        }
      }
      // 7. Hard break (dua spasi + newline, atau backslash + newline).
      if (ch === ' ' || ch === '\\') {
        let j = i;
        if (ch === ' ') {
          while (j < n && src[j] === ' ') j++;
          if (j - i >= 2 && src[j] === '\n') {
            const rest = src.slice(j + 1);
            if (!/^\s*$/.test(rest)) {
              let k = j + 1;
              while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
              out += textMode ? '' : '<br>';
              i = k;
              continue;
            }
          }
        } else if (src[i + 1] === '\n') {
          const rest = src.slice(i + 2);
          if (!/^\s*$/.test(rest)) {
            let k = i + 2;
            while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
            out += textMode ? '' : '<br>';
            i = k;
            continue;
          }
        }
      }
      // 8. Strikethrough.
      if (ch === '~') {
        const d = this.tryStrike(src, masked, i, prevLast, textMode);
        if (d) {
          out += d.html;
          i = d.end;
          continue;
        }
      }
      // 9. Autolink <...>.
      if (ch === '<') {
        const m = AUTOLINK.exec(src.slice(i));
        if (m) {
          const isEmail = m[2] === '@';
          const text = m[1];
          const href = isEmail ? 'mailto:' + text : text;
          const clean = tidyHref(href);
          if (clean !== null) {
            if (textMode) out += text;
            else out += '<a href="' + escHtml(clean, true) + '">' + escHtml(text, true) + '</a>';
            i += m[0].length;
            continue;
          }
        }
      }
      // 10. URL / email GFM tambahan (tidak di dalam link).
      if (!st.inLink) {
        const m = EXTENDED_URL.exec(src.slice(i));
        if (m) {
          let text;
          let href;
          if (m[2] === '@') {
            text = m[0];
            href = 'mailto:' + text;
          } else {
            let raw = m[0];
            let prev;
            do {
              prev = raw;
              const bp = BACKPEDAL.exec(raw);
              raw = bp ? bp[0] : '';
            } while (raw !== prev);
            text = raw;
            href = m[1] === 'www.' ? 'http://' + raw : raw;
          }
          const clean = tidyHref(href);
          if (clean !== null) {
            if (textMode) out += text;
            else out += '<a href="' + escHtml(clean, true) + '">' + escHtml(text, true) + '</a>';
            i += text.length;
            continue;
          }
        }
      }
      // 11. Teks. Dalam textMode chunk di-decode tapi TIDAK di-escape —
      // renderer text marked mengembalikan teks token apa adanya;
      // pemanggil meng-escape saat menaruhnya di atribut.
      const end = chunkEnd(src, i);
      const chunk = src.slice(i, end);
      if (textMode) {
        out += st.inRawBlock ? chunk : decodeNumRefs(chunk);
      } else {
        out += st.inRawBlock ? chunk : escHtml(decodeNumRefs(chunk));
      }
      if (chunk.slice(-1) !== '_') prevLast = chunk.slice(-1);
      wasText = true;
      i = end;
    }
    return out;
  }

  // Coba emphasis/strong di src[i] (src[i] adalah '*' atau '_').
  // `masked` adalah string kontainer hasil mask, `prevChar` karakter
  // terakhir token sebelumnya. Kembalikan {html, end} (end = indeks
  // tepat setelah em/strong) atau null.
  tryEm(src, masked, i, prevChar, textMode) {
    const ch = src[i];
    // Run opener, lalu harus diikuti karakter punct atau karakter
    // bukan spasi.
    let j = i;
    while (j < src.length && src[j] === ch) j++;
    const runHere = j - i;
    if (j >= src.length) return null;
    const after = src[j];
    if (after === ' ' || after === '\t' || after === '\n') return null;
    const followedByPunct = isGfmPunctCh(after);
    // Run bisa memanjang ke sebelum i (token sebelumnya berakhir dengan
    // karakter yang sama).
    let runStart = i;
    while (runStart > 0 && masked[runStart - 1] === ch) runStart--;
    const charBeforeRun = runStart > 0 ? cpBefore(masked, runStart) : '';
    const beforeIsPunctOrDelim = charBeforeRun === '*' || charBeforeRun === '_' || isOpenerPunctCh(charBeforeRun);
    const charBeforeToken = runStart < i ? charBeforeRun : prevChar;
    const beforeIsOpenerPunct = runStart < i ? beforeIsPunctOrDelim : isOpenerPunctCh(charBeforeToken);
    if (ch === '_' && !followedByPunct && isAlnumCh(charBeforeToken)) return null; // _ intraword
    const punctAfter = followedByPunct ? after : '';
    if (punctAfter && charBeforeToken !== '' && !beforeIsOpenerPunct) return null; // tidak bisa membuka (bukan left-flanking)
    const fullRun = i - runStart + runHere;
    const ruleOfThreesApplies = charBeforeRun.trim() !== '' &&
      (punctAfter !== '' || (ch === '*' && !beforeIsPunctOrDelim));
    const prevIsSameDelim = prevChar === ch;
    // Pindai closer di string hasil mask, mulai setelah opener.
    let pos = i + runHere;
    const skipTo = skipEmphasis(masked, pos, ch);
    if (skipTo >= 0) pos = skipTo;
    let remaining = runHere;
    let absorbed = 0;
    while (pos < masked.length) {
      // Cari run `ch` berikutnya.
      let q = pos;
      while (q < masked.length && masked[q] !== ch) q++;
      if (q >= masked.length) break;
      let r = q;
      while (r < masked.length && masked[r] === ch) r++;
      const closerLen = r - q;
      const prev = cpBefore(masked, q);
      const next = cpAfter(masked, r);
      const group = closerKind(ch, prev, next);
      if (group === 0) { pos = r; continue; }
      if (group === 3 || group === 4) { remaining += closerLen; pos = r; continue; }
      if (group === 5 || group === 6 || ruleOfThreesApplies) {
        if (prevIsSameDelim && (group === 5 || group === 6)) break;
        if (fullRun % 3 !== 0 && (fullRun + closerLen) % 3 === 0) { absorbed += closerLen; pos = r; continue; }
      }
      remaining -= closerLen;
      if (remaining > 0) { pos = r; continue; }
      const use = Math.min(closerLen, closerLen + remaining + absorbed);
      const rawEnd = q + use;
      const raw = src.slice(i, rawEnd);
      if (Math.min(runHere, use) % 2 === 1) {
        const inner = raw.slice(1, -1);
        const html = textMode
          ? this.render(inner, textMode)
          : '<em>' + this.render(inner, textMode) + '</em>';
        return { html, end: rawEnd };
      }
      const inner = raw.slice(2, -2);
      const html = textMode
        ? this.render(inner, textMode)
        : '<strong>' + this.render(inner, textMode) + '</strong>';
      return { html, end: rawEnd };
    }
    return null;
  }

  // Coba strikethrough di src[i] (src[i] adalah '~'). Kembalikan
  // {html, end} atau null.
  tryStrike(src, masked, i, prevChar, textMode) {
    let j = i;
    while (j < src.length && src[j] === '~' && j - i < 2) j++;
    const openerLen = j - i; // panjang opener (1 atau 2)
    if (openerLen === 0) return null;
    if (j >= src.length) return null;
    const after = src[j];
    if (after === ' ' || after === '\t' || after === '\n' || after === '~') return null;
    const followedByPunct = isGfmPunctCh(after);
    if (followedByPunct && prevChar !== '' && !isOpenerPunctCh(prevChar)) return null;
    let remaining = openerLen;
    let pos = i + openerLen;
    while (pos < masked.length) {
      let q = pos;
      while (q < masked.length && masked[q] !== '~') q++;
      if (q >= masked.length) break;
      let r = q;
      while (r < masked.length && masked[r] === '~') r++;
      const closerLen = r - q;
      if (closerLen !== openerLen) { pos = r; continue; } // closer harus sama persis panjangnya dengan opener
      const prev = cpBefore(masked, q);
      const next = cpAfter(masked, r);
      const group = closerKind('~', prev, next);
      if (group === 0) { pos = r; continue; }
      if (group === 3 || group === 4) { remaining += closerLen; pos = r; continue; }
      remaining -= closerLen;
      if (remaining > 0) { pos = r; continue; }
      const use = Math.min(closerLen, closerLen + remaining);
      const rawEnd = q + use;
      const raw = src.slice(i, rawEnd);
      const inner = raw.slice(openerLen, -openerLen);
      const html = textMode
        ? this.render(inner, textMode)
        : '<del>' + this.render(inner, textMode) + '</del>';
      return { html, end: rawEnd };
    }
    return null;
  }

  // Pindai link/image inline di src[i]: [label](dest "title") atau
  // ![label](...). Kembalikan {isImage, label, href, title, end}
  // atau null.
  scanInlineLink(src, i) {
    const isImage = src[i] === '!';
    const labelStart = isImage ? i + 1 : i;
    const lab = scanLabel(src, labelStart);
    if (!lab) return null;
    if (tagSpillsFromLabel(src, labelStart + 1, lab.label.length)) return null;
    let j = lab.end;
    if (src[j] !== '(') return null;
    j++;
    while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
    let href = null;
    let angle = false;
    const destStart = j;
    let destEnd = j;
    if (src[j] === '<') {
      let k = j + 1;
      let ok = false;
      while (k < src.length) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '\n' || ch === '<') break;
        if (ch === '>') { ok = true; break; }
        k++;
      }
      if (!ok) return null;
      let backslashes = 0;
      for (let q = k - 1; q > j && src[q] === '\\'; q--) backslashes++;
      if (backslashes % 2 === 1) return null;
      href = src.slice(j + 1, k);
      angle = true;
      destEnd = k + 1;
      j = k + 1;
    } else if (src[j] === ')') {
      href = '';
      destEnd = j;
    } else {
      let k = j;
      while (k < src.length && src[k] !== ' ' && src[k] !== '\t' && src[k] !== '\n' && src.charCodeAt(k) > 31) k++;
      if (k === j) return null;
      href = src.slice(j, k);
      destEnd = k;
      j = k;
    }
    let title = null;
    let rawEnd = -1;
    if (!angle) {
      const unbalanced = parenCheck(href, '()');
      if (unbalanced === -2) return null;
      if (unbalanced > -1) {
        // Potong href di ')' yang tidak berpasangan; title dibuang dan
        // kecocokan mentah berakhir tepat setelah ')' itu.
        href = href.substring(0, unbalanced);
        rawEnd = destStart + unbalanced + 1;
        title = '';
      }
    }
    if (rawEnd < 0) {
      // Title opsional, setelah pemisah spasi/tab (dengan newline
      // opsional) atau newline.
      let k = j;
      let sep = false;
      if (src[k] === ' ' || src[k] === '\t') {
        sep = true;
        while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
        if (src[k] === '\n') {
          k++;
          while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
        }
      } else if (src[k] === '\n') {
        sep = true;
        k++;
        while (k < src.length && (src[k] === ' ' || src[k] === '\t')) k++;
      }
      if (sep) {
        const found = this.scanTitle(src, k);
        if (found) { title = found.title; k = found.end; }
      }
      while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
      if (src[k] !== ')') return null;
      // ')' penutup tidak boleh di-escape.
      let backslashes = 0;
      for (let q = k - 1; q >= 0 && src[q] === '\\'; q--) backslashes++;
      if (backslashes % 2 === 1) return null;
      rawEnd = k + 1;
    }
    return {
      isImage,
      label: lab.label.replace(/\\([\[\]])/g, '$1'),
      href: unescPunct(href.trim()),
      title: title === null ? null : unescPunct(title),
      end: rawEnd,
    };
  }

  // Pindai title link di src[i]: "..." | '...' | (...).
  // Kembalikan {title, end} atau null.
  scanTitle(src, i) {
    const quote = src[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === quote) return { title: src.slice(i + 1, j), end: j + 1 };
        j++;
      }
      return null;
    }
    if (quote === '(') {
      let j = i + 1;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === ')') return { title: src.slice(i + 1, j), end: j + 1 };
        j++;
      }
      return null;
    }
    return null;
  }

  // Pindai link referensi di src[i]: [label][ref] | [label][] | [ref] |
  // [ref][]. Kembalikan {isImage, label, ref, end} atau null. `ref`
  // adalah '' untuk bentuk collapsed (artinya "pakai label").
  scanRefLink(src, i) {
    const isImage = src[i] === '!';
    const labelStart = isImage ? i + 1 : i;
    if (src[labelStart] !== '[') return null;
    const lab = scanLabel(src, labelStart);
    if (!lab) return null;
    const afterLabel = lab.end;
    if (src[afterLabel] === '[') {
      // [label][ref] atau [label][]
      let j = afterLabel + 1;
      if (src[j] === ']') return { isImage, label: lab.label, ref: '', end: j + 1 };
      let k = j;
      while (k < src.length) {
        const ch = src[k];
        if (ch === '\\') { k += 2; continue; }
        if (ch === '[' || ch === ']') break;
        k++;
      }
      if (src[k] !== ']' || k === j) return null;
      const ref = src.slice(j, k);
      if (/^\s*\]/.test(ref) || ref.trim() === '') return null;
      return { isImage, label: lab.label, ref, end: k + 1 };
    }
    // Bentuk shortcut: [ref] atau [ref][]
    if (lab.label.length === 0) return null;
    if (/^\s/.test(lab.label) && lab.label.trim() === '') return null;
    let end = afterLabel;
    if (src[end] === '[' && src[end + 1] === ']') end += 2;
    return { isImage, label: lab.label, ref: lab.label, end };
  }

  // Bangun link/image dari label + destinasi yang sudah diparse
  // (renderer link marked). Kembalikan {html, end} atau null (bila ada
  // link bersarang yang ter-emit di dalam label, link luar dibuang).
  // `rawEnd` adalah indeks tepat setelah keseluruhan link di sumber.
  makeLink(label, href, title, isImage, rawEnd, textMode) {
    const st = this.st;
    const labelText = label.replace(/\\([\[\]])/g, '$1');
    const savedInLink = st.inLink;
    const savedEmitted = st.linkEmitted;
    const savedRaw = st.inRawBlock;
    st.inLink = true;
    st.linkEmitted = false;
    // Label image selalu dirender sebagai teks polos (alt text) —
    // bahkan saat image-nya sendiri dalam mode HTML. Label link
    // mengikuti mode pemanggil.
    const inner = this.render(labelText, isImage ? true : textMode);
    const nested = st.linkEmitted;
    st.linkEmitted = savedEmitted;
    st.inLink = savedInLink;
    if (!isImage) {
      if (nested) {
        st.inRawBlock = savedRaw;
        return null;
      }
      st.linkEmitted = true;
    }
    if (textMode) {
      // Dalam mode teks, link/image dirender sebagai teks labelnya.
      return { html: inner, end: rawEnd };
    }
    if (isImage) {
      const clean = tidyHref(href);
      if (clean === null) return { html: escHtml(inner), end: rawEnd };
      let out = `<img src="${escHtml(clean)}" alt="${escHtml(inner)}"`;
      if (title) out += ` title="${escHtml(title)}"`;
      return { html: out + '>', end: rawEnd };
    }
    const clean = tidyHref(href);
    if (clean === null) return { html: inner, end: rawEnd };
    let out = `<a href="${escHtml(clean)}"`;
    if (title) out += ` title="${escHtml(title)}"`;
    return { html: out + '>' + inner + '</a>', end: rawEnd };
  }
}

// ================================================================ E. pengenal baris blok
// Parsing blok berbasis baris. Sumber dipecah jadi baris (tanpa '\n');
// `starts[i]` adalah offset byte baris i, `starts[lines.length]`
// adalah panjang sumber, jadi raw(a, b) = src.slice(starts[a], starts[b]).

const BLOCK_TAG_NAMES = new Set('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'.split('|'));
const RAW_TAG_NAMES = new Set(['pre', 'script', 'style', 'textarea']);

function splitSourceLines(src) {
  if (src === '') return { lines: [], starts: [0] };
  const lines = src.split('\n');
  const starts = [0];
  for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
  return { lines, starts };
}

function isBlank(line) {
  return /^[ \t]*$/.test(line);
}

// Baris dengan maksimal 3 spasi/tab di depan yang dihapus (kembalikan
// sisanya dan berapa kolom yang terhapus). Tab dihitung per kolom.
function stripLead(line) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < 3) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (col + width > 3) break;
      col += width; i++;
    } else break;
  }
  return { rest: line.slice(i), col };
}

const HR_RUN = /^(?:-[\t ]*){3,}$|^(?:_[\t ]*){3,}$|^(?:\*[\t ]*){3,}$/;
function isHr(line) {
  const { rest } = stripLead(line);
  // Jangan trim whitespace depan: tab di awal adalah 4 kolom, jadi
  // `\t***` BUKAN hr (marked hanya mengizinkan 0-3 spasi). HR_RUN
  // sudah mengizinkan spasi/tab di ujung.
  return HR_RUN.test(rest) && /^(?:-|\*|_)/.test(rest);
}

function atxLevel(line) {
  const { rest } = stripLead(line);
  const m = /^(#{1,6})(?:\s|$)/.exec(rest);
  return m ? m[1].length : 0;
}

function fenceHead(line) {
  const { rest } = stripLead(line);
  const m = /^(`{3,}(?=[^`\n]*$)|~{3,})/.exec(rest);
  return m ? { ch: m[0][0], len: m[0].length, info: rest.slice(m[0].length) } : null;
}

function isQuote(line) {
  return /^ {0,3}>/.test(line);
}

// Marker list di awal baris (setelah <= 3 spasi). `anyOrdered`
// mengizinkan nomor awal berapa pun (untuk cek lazy-line / setext);
// bila tidak, hanya bullet atau "1." / "1)" yang menginterupsi
// paragraf.
function scanMarker(line, anyOrdered) {
  const { rest } = stripLead(line);
  let m = /^([*+-])(?=[ \t]|$)/.exec(rest);
  if (m) return { marker: m[1], ordered: false, start: 0, rest: rest.slice(1) };
  m = anyOrdered
    ? /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest)
    : /^(1)([.)])(?=[ \t]|$)/.exec(rest);
  if (m) return { marker: m[1] + m[2], ordered: true, start: parseInt(m[1], 10), rest: rest.slice(m[0].length) };
  return null;
}

// Apakah marker list pada baris ini menginterupsi paragraf? Aturan
// paragraf marked mensyaratkan `[ \t]+[^ \t\n]` setelah marker — item
// kosong (`*` atau `1.` saja, atau hanya diikuti whitespace) TIDAK
// menginterupsi, jadi baris itu tetap teks paragraf.
function markerBreaksPara(line) {
  const marker = scanMarker(line, false);
  if (!marker) return false;
  return /^[ \t]+[^ \t]/.test(marker.rest);
}

// Awal blok HTML (hanya tipe 1-6 — tipe 7 tidak bisa menginterupsi
// paragraf). Kembalikan nomor tipe, atau 0.
function htmlKind(line) {
  const { rest } = stripLead(line);
  if (!rest.startsWith('<')) return 0;
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]+|\n|\/?>|$)/.exec(rest);
  if (m6 && BLOCK_TAG_NAMES.has(m6[1].toLowerCase())) return 6;
  return 0;
}

// Tipe 7: tag lengkap apa pun dalam satu baris, hanya whitespace
// setelahnya.
function isHtml7(line) {
  const { rest } = stripLead(line);
  if (!rest.startsWith('<')) return false;
  const m = HTML_TAG.exec(rest);
  if (!m) return false;
  const after = rest.slice(m[0].length);
  return /^[ \t]*$/.test(after);
}

// Baris delimiter tabel (untuk cek header/delimiter).
function isDelimRow(line) {
  const { rest } = stripLead(line);
  return /^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(rest) && /[:|]/.test(rest);
}

// Apakah lines[i] (header) + lines[i+1] (delimiter) memulai tabel?
function tableBegins(lines, i) {
  if (i + 1 >= lines.length) return false;
  const header = lines[i];
  if (header.trim() === '') return false;
  if (!/^\S/.test(header.replace(/^ */, ''))) return false;
  const delim = lines[i + 1];
  if (!isDelimRow(delim)) return false;
  const headerCells = splitRowCells(header);
  const delimCells = delim.replace(/^\||\| *$/g, '').split('|');
  return headerCells.length === delimCells.length;
}

// Cek kelanjutan paragraf (aturan paragraf GFM, berbasis baris).
function paraContinues(lines, i) {
  const line = lines[i];
  if (isBlank(line)) {
    // Baris whitespace-only di ujung tanpa '\n' setelahnya (baris
    // terakhir, tidak kosong) adalah bagian paragraf: pola paragraf
    // marked mengecualikan hanya `[ \t]+\n` (whitespace + newline),
    // jadi lookahead gagal di akhir input dan baris itu ikut.
    return i === lines.length - 1 && line !== '';
  }
  if (/^[ \t]+\n?$/.test(line) && line.trim() === '') return false;
  if (isHr(line)) return false;
  if (atxLevel(line)) return false;
  if (isQuote(line)) return false;
  if (fenceHead(line)) return false;
  if (markerBreaksPara(line)) return false;
  if (htmlKind(line)) return false;
  if (tableBegins(lines, i)) return false;
  return true;
}

// Kelanjutan teks setext (aturan teks setext-heading): seperti
// paragraf, tapi bullet jenis apa pun menghentikannya, dan baris yang
// mirip delimiter tabel menghentikannya.
function setextContinues(lines, i) {
  const line = lines[i];
  if (isBlank(line)) return false;
  if (scanMarker(line, true)) return false;
  if (fenceHead(line)) return false;
  if (isQuote(line)) return false;
  if (atxLevel(line)) return false;
  if (isHr(line)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return false;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(line)) return false;
  return true;
}

function setextLevel(line) {
  const { rest } = stripLead(line);
  const m = /^((?:=+|-+))[ \t]*$/.exec(rest);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}

// Pindai definisi referensi link di awal `src` (dari `pos`).
// Kembalikan {label, href, title, rawLen} atau null. `rawLen` adalah
// jumlah karakter sumber yang terpakai (termasuk newline di ujung).
const DEF_PATTERN = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
function scanDefinition(src, pos) {
  const m = DEF_PATTERN.exec(src.slice(pos));
  if (!m) return null;
  const dest = m[2];
  if (!dest.startsWith('<') && parenCheck(dest, '()') !== -1) return null;
  const href = dest.startsWith('<')
    ? dest.slice(1, -1).replace(ESCAPED_PUNCT, '$1')
    : dest.replace(ESCAPED_PUNCT, '$1');
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ESCAPED_PUNCT, '$1') : null;
  return { label: m[1], href, title, rawLen: m[0].length };
}

// Regex penutup fence dan penutup HTML, di-cache per kunci agar tidak
// dibuat ulang untuk tiap baris yang dipindai.
const RE_CACHE = new Map();
function fenceClosePattern(ch, len) {
  const key = ch + len;
  let rx = RE_CACHE.get(key);
  if (!rx) {
    rx = new RegExp('^(' + (ch === '`' ? '`' : '~') + '{' + len + ',})[ \\t]*$');
    RE_CACHE.set(key, rx);
  }
  return rx;
}
function htmlClosePattern(tag) {
  const key = 'html/' + tag;
  let rx = RE_CACHE.get(key);
  if (!rx) {
    rx = new RegExp('</' + tag + '>', 'i');
    RE_CACHE.set(key, rx);
  }
  return rx;
}

// ================================================================ F. lexer blok
// ctx: {links, defs, top, mergePara, hadBlankBetween}
//   links: label -> {href, title} (definisi pertama menang)
//   defs:  [{raw}] dalam urutan dokumen (untuk fallback marked)
//   top:   true di level atas / dalam blockquote, false di dalam item
//          list
//   mergePara: true saat mem-parse isi dalam blockquote (hanya paragraf
//          PERTAMA dari panggilan ini yang boleh bergabung ke paragraf
//          sebelumnya)
// `into` adalah array blok bersama opsional untuk ditambahi (grup
// blockquote menumpuk ke satu array).

class BlockLexer {
  constructor(src, ctx, into) {
    const { lines, starts } = splitSourceLines(src);
    this.src = src;
    this.ctx = ctx;
    this.links = ctx.links;
    this.defs = ctx.defs;
    this.lines = lines;
    this.starts = starts;
    this.n = lines.length;
    this.blocks = into || [];
    this.i = 0;
    this.emitted = false; // ada blok yang ditambahkan panggilan ini
    this.lastEnd = 0;     // indeks baris tepat setelah blok terakhir
    this.sawBlank = false; // ada baris kosong yang dilewati setelah blok
  }

  sliceLines(a, b) {
    return this.src.slice(this.starts[a], this.starts[b]);
  }
  lastBlock() {
    return this.blocks[this.blocks.length - 1];
  }
  noteBlock(endLine) {
    if (this.sawBlank && this.emitted) this.ctx.hadBlankBetween = true;
    this.sawBlank = false;
    this.emitted = true;
    this.lastEnd = endLine;
  }

  parse() {
    while (this.i < this.n) {
      const line = this.lines[this.i];
      if (isBlank(line)) { this.sawBlank = true; this.i++; continue; }
      if (this.tryIndentCode()) continue;
      if (this.tryFence()) continue;
      if (this.tryAtx()) continue;
      if (this.tryRule()) continue;
      if (this.tryQuote()) continue;
      if (this.tryListBlock()) continue;
      if (this.tryHtml()) continue;
      if (this.tryDef()) continue;
      if (this.tryTableBlock()) continue;
      if (this.trySetext()) continue;
      this.readPara();
    }
    // Lexer marked menyimpan SATU `state.top` bersama di semua
    // pemanggilan blockTokens dan mengembalikannya ke true di akhir
    // tiap pemanggilan: setelah list/blockquote bersarang di-parse,
    // blok berikutnya di konteks pembungkus di-parse sebagai paragraf
    // (top=true), bukan token teks satu baris.
    this.ctx.top = true;
    return this.blocks;
  }

  tryIndentCode() {
    const line = this.lines[this.i];
    if (!/^(?: {4}| {0,3}\t)/.test(line) || line.trim() === '') return false;
    const { lines, src } = this;
    const n = this.n;
    let j = this.i;
    let lastCode = this.i;
    while (j < n) {
      if (/^(?: {4}| {0,3}\t)/.test(lines[j]) && lines[j].trim() !== '') { lastCode = j; j++; continue; }
      if (isBlank(lines[j])) {
        let k = j + 1;
        while (k < n && isBlank(lines[k])) k++;
        if (k < n && /^(?: {4}| {0,3}\t)/.test(lines[k]) && lines[k].trim() !== '') { j = k; continue; }
        break;
      }
      break;
    }
    // Kecocokan indented-code marked menyertakan baris kosong di
    // ujung kode, jadi trimTrailingBlank() membuangnya; tanpanya teks
    // gabungan menyimpan '\n' di ujung. Sertakan baris itu di rawText
    // (i tetap maju hanya melewati baris kode, jadi baris kosong
    // dilihat oleh loop utama).
    let rawEnd = lastCode + 1;
    while (rawEnd < n && isBlank(lines[rawEnd])) rawEnd++;
    const rawText = this.sliceLines(this.i, rawEnd);
    let text = trimTrailingBlank(rawText);
    text = text.replace(/^(?: {0,3}\t| {1,4})/gm, '');
    const prev = this.lastBlock();
    if (prev && (prev.type === 'paragraph' || prev.type === 'text') && this.i === this.lastEnd) {
      prev.text += '\n' + text;
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + rawText;
      this.lastEnd = lastCode + 1;
      this.i = lastCode + 1;
      return true;
    }
    this.blocks.push({ type: 'code', raw: rawText, text, lang: '', fenced: false });
    this.noteBlock(lastCode + 1);
    this.i = lastCode + 1;
    return true;
  }

  tryFence() {
    const fence = fenceHead(this.lines[this.i]);
    if (!fence || (fence.ch === '`' && fence.info.includes('`'))) return false;
    const { lines, src } = this;
    const n = this.n;
    let j = this.i + 1;
    let closed = -1;
    while (j < n) {
      const { rest: rest2 } = stripLead(lines[j]);
      const m = fenceClosePattern(fence.ch, fence.len).exec(rest2);
      if (m) { closed = j; break; }
      j++;
    }
    const contentEnd = closed >= 0 ? closed : n;
    let content = src.slice(this.starts[this.i + 1], this.starts[contentEnd]);
    // Grup 3 kecocokan fence marked mengecualikan newline terakhir
    // sebelum fence penutup (atau EOF); renderer menambah tepat satu.
    if (content.endsWith('\n')) content = content.slice(0, -1);
    content = dedentCode(this.sliceLines(this.i, this.i + 1), content);
    const info = fence.info.trim().replace(ESCAPED_PUNCT, '$1');
    const lang = info.match(/^\S*/)?.[0] || '';
    this.blocks.push({ type: 'code', raw: this.sliceLines(this.i, closed >= 0 ? closed + 1 : n), text: content, lang, fenced: true });
    const next = contentEnd + (closed >= 0 ? 1 : 0);
    this.noteBlock(next);
    this.i = next;
    return true;
  }

  tryAtx() {
    const line = this.lines[this.i];
    const atx = atxLevel(line);
    if (!atx) return false;
    const { rest } = stripLead(line);
    let text = rest.slice(atx);
    text = text.replace(/^[ \t]+/, '');
    const closing = /[ \t]+#+[ \t]*$/.exec(text) || /^(#+)[ \t]*$/.exec(text);
    if (closing) text = text.slice(0, text.length - closing[0].length);
    text = text.replace(/[ \t]+$/, '');
    this.blocks.push({ type: 'heading', raw: this.sliceLines(this.i, this.i + 1), depth: atx, text });
    this.noteBlock(this.i + 1);
    this.i++;
    return true;
  }

  tryRule() {
    if (!isHr(this.lines[this.i])) return false;
    this.blocks.push({ type: 'hr', raw: this.sliceLines(this.i, this.i + 1) });
    this.noteBlock(this.i + 1);
    this.i++;
    return true;
  }

  tryQuote() {
    if (!isQuote(this.lines[this.i])) return false;
    const bq = this.scanQuote(this.src, this.starts[this.i]);
    if (!bq) return false;
    this.blocks.push(bq.block);
    const consumed = this.src.slice(this.starts[this.i], this.starts[this.i] + bq.rawLen);
    let next = this.i + consumed.split('\n').length;
    if (consumed.endsWith('\n')) next--;
    this.noteBlock(next);
    this.i = next;
    return true;
  }

  tryListBlock() {
    // Nomor awal berapa pun bisa memulai list di batas blok; hanya `1`
    // yang menginterupsi paragraf, ditangani di dalam paraContinues.
    const marker = scanMarker(this.lines[this.i], true);
    if (!marker || !(marker.rest === '' || /^[ \t]/.test(marker.rest))) return false;
    const lst = this.scanList(this.src, this.starts[this.i]);
    if (!lst) return false;
    this.blocks.push(lst.block);
    const consumed = this.src.slice(this.starts[this.i], this.starts[this.i] + lst.rawLen);
    let next = this.i + consumed.split('\n').length;
    if (consumed.endsWith('\n')) next--;
    this.noteBlock(next);
    this.i = next;
    return true;
  }

  tryHtml() {
    const line = this.lines[this.i];
    const kind = htmlKind(line) || (isHtml7(line) ? 7 : 0);
    if (!kind) return false;
    const hb = this.scanHtml(this.i, kind);
    this.blocks.push({ type: 'html', raw: hb.raw, text: hb.text, pre: hb.pre });
    this.noteBlock(hb.next);
    this.i = hb.next;
    return true;
  }

  tryDef() {
    const def = scanDefinition(this.src, this.starts[this.i]);
    if (!def) return false;
    const defRaw = this.src.slice(this.starts[this.i], this.starts[this.i] + def.rawLen);
    // Baris yang tercakup: newline + 1, kecuali raw berakhir newline
    // (maka elemen split terakhir kosong dan tidak menambah baris).
    const consumed = defRaw.endsWith('\n')
      ? defRaw.split('\n').length - 1
      : defRaw.split('\n').length;
    const prev = this.lastBlock();
    if (prev && (prev.type === 'paragraph' || prev.type === 'text') && this.i === this.lastEnd) {
      // Bergabung ke paragraf/teks sebelumnya: TIDAK didaftarkan
      // sebagai link.
      prev.text += '\n' + defRaw;
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + defRaw;
      this.lastEnd = this.i + Math.max(1, consumed);
      this.i = this.lastEnd;
      return true;
    }
    const key = foldLabel(def.label);
    if (!Object.hasOwn(this.links, key)) {
      this.links[key] = { href: def.href, title: def.title };
      this.defs.push({ raw: defRaw });
    }
    // Definisi yang terdaftar adalah token tersendiri (dirender jadi
    // kosong); mendorongnya menjaga definisi berikutnya tidak bergabung
    // ke paragraf.
    this.blocks.push({ type: 'def', raw: defRaw });
    this.noteBlock(this.i + Math.max(1, consumed));
    this.i = this.i + Math.max(1, consumed);
    return true;
  }

  tryTableBlock() {
    if (!tableBegins(this.lines, this.i)) return false;
    const tb = this.scanTableRows(this.i);
    this.blocks.push(tb.block);
    this.noteBlock(tb.next);
    this.i = tb.next;
    return true;
  }

  trySetext() {
    const { lines } = this;
    const n = this.n;
    let j = this.i;
    while (j < n && setextContinues(lines, j) && !setextLevel(lines[j])) j++;
    if (j > this.i && j < n && setextLevel(lines[j])) {
      const depth = setextLevel(lines[j]);
      const text = lines.slice(this.i, j).join('\n').trim();
      this.blocks.push({ type: 'heading', raw: this.sliceLines(this.i, j + 1), depth, text });
      this.noteBlock(j + 1);
      this.i = j + 1;
      return true;
    }
    return false;
  }

  // Paragraf (level atas / blockquote) atau teks (di dalam item list).
  readPara() {
    const { lines } = this;
    const n = this.n;
    if (this.ctx.top) {
      let j = this.i;
      while (j + 1 < n && paraContinues(lines, j + 1)) j++;
      const text = lines.slice(this.i, j + 1).join('\n');
      const prev = this.lastBlock();
      if (this.ctx.mergePara && !this.emitted && prev && prev.type === 'paragraph') {
        prev.text += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + this.sliceLines(this.i, j + 1);
      } else {
        this.blocks.push({ type: 'paragraph', raw: this.sliceLines(this.i, j + 1), text });
      }
      this.noteBlock(j + 1);
      this.i = j + 1;
    } else {
      const text = lines[this.i];
      const prev = this.lastBlock();
      if (prev && prev.type === 'text' && this.i === this.lastEnd) {
        prev.text += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + this.sliceLines(this.i, this.i + 1);
      } else {
        this.blocks.push({ type: 'text', raw: this.sliceLines(this.i, this.i + 1), text });
      }
      this.noteBlock(this.i + 1);
      this.i++;
    }
  }

  // Parse blok HTML mulai dari lines[i] (tipe 1-7). Kembalikan
  // {raw, text, pre, next}. `text` adalah raw yang sudah
  // trimTrailingBlank().
  scanHtml(i, type) {
    const { lines, starts, src } = this;
    const n = lines.length;
    let end = i + 1; // indeks setelah baris terakhir blok
    const first = lines[i];
    const { rest } = stripLead(first);
    if (type === 1) {
      const tag = /^<(script|pre|style|textarea)/i.exec(rest)[1].toLowerCase();
      const closeRe = htmlClosePattern(tag);
      let j = i;
      let found = false;
      while (j < n) {
        if (closeRe.test(lines[j])) { found = true; break; }
        j++;
      }
      end = found ? j + 1 : n;
    } else if (type === 2) {
      let j = i;
      let buf = '';
      while (j < n) {
        buf += lines[j] + '\n';
        if (buf.includes('-->')) break;
        j++;
      }
      end = j + 1 <= n ? j + 1 : n;
    } else if (type === 3) {
      let j = i;
      let buf = '';
      while (j < n) {
        buf += lines[j] + '\n';
        if (buf.includes('?>')) break;
        j++;
      }
      end = j + 1 <= n ? j + 1 : n;
    } else if (type === 4) {
      let j = i;
      let buf = '';
      while (j < n) {
        buf += lines[j] + '\n';
        if (buf.includes('>')) break;
        j++;
      }
      end = j + 1 <= n ? j + 1 : n;
    } else if (type === 5) {
      let j = i;
      let buf = '';
      while (j < n) {
        buf += lines[j] + '\n';
        if (buf.includes(']]>')) break;
        j++;
      }
      end = j + 1 <= n ? j + 1 : n;
    } else {
      // Tipe 6 dan 7: sampai baris kosong.
      let j = i + 1;
      while (j < n && !isBlank(lines[j])) j++;
      end = j;
    }
    // trimTrailingBlank() berjalan pada teks yang cocok. Pola html
    // marked mengakhiri tipe 1-5 dengan `(\n+|$)` — ia menelan baris
    // yang benar-benar KOSONG (hanya "\n") sesudahnya tapi berhenti di
    // baris whitespace-only (mis. "\t"). Tipe 6-7 berakhir dengan
    // `(?:(?:\n[ \t]*)+\n|$)` — mereka menelan baris whitespace-only
    // juga. Menelan baris kosong itulah yang membuat
    // trimTrailingBlank() membuang newline ujung blok itu sendiri;
    // baris whitespace-only setelah blok tipe 1-5 menyisakan tepat
    // satu newline di ujung.
    let rawEnd = end;
    if (type >= 6) {
      while (rawEnd < n && isBlank(lines[rawEnd])) rawEnd++;
    } else {
      while (rawEnd < n && lines[rawEnd] === '') rawEnd++;
    }
    const rawText = trimTrailingBlank(this.sliceLines(i, rawEnd));
    // Raw token html marked ADALAH teks hasil trimTrailingBlank():
    // blok hanya mengonsumsi itu, BUKAN baris kosong yang tertelan
    // setelahnya. Baris kosong itu tetap ada dan menjadi token space
    // (yang membuat list jadi loose saat ada blank antara blok html dan
    // blok berikutnya di dalam item). Jadi `next` adalah baris pertama
    // pada atau setelah akhir teks hasil trimTrailingBlank().
    const rawEndByte = starts[i] + rawText.length;
    let next = i + 1;
    while (next <= n && starts[next] < rawEndByte) next++;
    const pre = /^(script|pre|style)$/i.test((/^<([A-Za-z]+)/.exec(rest) || [])[1] || '');
    return { raw: rawText, text: rawText, pre, next: Math.min(next, n) };
  }

  // Parse tabel mulai dari lines[i] (header) dengan lines[i+1] sebagai
  // delimiter.
  scanTableRows(i) {
    const { lines } = this;
    const n = lines.length;
    const headerCells = splitRowCells(lines[i]);
    const delimCells = lines[i + 1].replace(/^\||\| *$/g, '').split('|');
    const align = delimCells.map((cell) => {
      if (/^ *-+: *$/.test(cell)) return 'right';
      if (/^ *:-+: *$/.test(cell)) return 'center';
      if (/^ *:-+ *$/.test(cell)) return 'left';
      return null;
    });
    const header = headerCells.map((text, idx) => ({ text, align: align[idx] || null }));
    const rows = [];
    let j = i + 2;
    while (j < n) {
      const line = lines[j];
      // Pola tabel marked mengakhiri rangkaian baris pada ` *\n`
      // (spasi saja): baris yang hanya berisi tab adalah baris tabel
      // (kosong), bukan baris kosong.
      if (/^ *$/.test(line)) break;
      if (isHr(line)) break;
      if (atxLevel(line)) break;
      if (isQuote(line)) break;
      if (/^(?: {4}| {0,3}\t)[^\n]/.test(line) && line.trim() !== '') break;
      if (fenceHead(line)) break;
      if (scanMarker(line, false)) break;
      if (htmlKind(line)) break;
      rows.push(splitRowCells(line, header.length).map((text, idx) => ({ text, align: align[idx] || null })));
      j++;
    }
    return { block: { type: 'table', raw: this.sliceLines(i, j), header, rows }, next: j };
  }

  // ============================================================ list & blockquote
  // Parse list mulai dari `pos` di `src`. Kembalikan {block, rawLen}
  // atau null.
  scanList(src, pos) {
    const source = src.slice(pos);
    const firstMatch = LIST_OPEN.exec(source);
    if (!firstMatch) return null;
    const full = source;
    let rest = source;
    const consumed = () => full.length - rest.length;
    let markerText = firstMatch[1].trim();
    const ordered = markerText.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +markerText.slice(0, -1) : '', loose: false, items: [] };
    markerText = ordered ? `\\d{1,9}\\${markerText.slice(-1)}` : `\\${markerText}`;
    const itemRe = itemLinePatternCached(markerText);
    let pendingLoose = false;
    while (rest) {
      let emptyItem = false;
      let itemText = '';
      const itemMatch = itemRe.exec(rest);
      if (!itemMatch || HR_WHOLE.test(rest)) break;
      const itemStart = consumed();
      rest = rest.substring(itemMatch[0].length);
      const firstLine = itemMatch[2].split('\n', 1)[0];
      const markerLen = itemMatch[1].length;
      let firstContent = firstLine.replace(LEADING_WS, (ws) => expandTabStops(ws, markerLen));
      let nextLine = rest.split('\n', 1)[0];
      let isEmpty = !firstContent.trim();
      let contentIndent = 0;
      if (isEmpty) contentIndent = markerLen + 1;
      else {
        contentIndent = firstContent.search(NON_SPACE);
        contentIndent = contentIndent > 4 ? 1 : contentIndent;
        itemText = firstContent.slice(contentIndent);
        contentIndent += markerLen;
      }
      if (isEmpty && /^[ \t]*$/.test(nextLine)) { rest = rest.substring(nextLine.length + 1); emptyItem = true; }
      if (!emptyItem) {
        // Marked memoise pola break ini dengan clamp ke
        // max(0, min(3, contentIndent-1)): baris yang indent-nya lebih
        // dari itu TIDAK memutus item, melainkan isi item.
        const clamped = Math.max(0, Math.min(3, contentIndent - 1));
        const { bullet, hr, fence, heading, html, quote } = breakSet(clamped);
        while (rest) {
          const curLine = rest.split('\n', 1)[0];
          nextLine = curLine;
          // Pindai manual whitespace di depan: indeks idx karakter
          // pertama bukan spasi/tab, kolomnya col, dan apakah ada tab.
          // Ini menggantikan ekspansi tab + 6 tes pola break untuk
          // kasus umum tanpa tab.
          let idx = 0;
          let col = 0;
          let hasTab = false;
          while (idx < nextLine.length) {
            const code = nextLine.charCodeAt(idx);
            if (code === 32) { col++; idx++; }
            else if (code === 9) { hasTab = true; col += 4 - (col % 4); idx++; }
            else break;
          }
          const firstCh = idx < nextLine.length ? nextLine[idx] : '';
          let colForCompare;
          let blankLine;
          let expanded;
          if (firstCh === '\f' || firstCh === '\v') {
            // Jarang: form-feed/vertical-tab di depan merusak model
            // ekspansi tab; kembali ke komputasi berbasis regex.
            expanded = nextLine.replace(LEADING_WS, (ws) => expandTabStops(ws));
            colForCompare = expanded.search(NON_SPACE);
            blankLine = !nextLine.trim();
          } else {
            blankLine = idx === nextLine.length;
            expanded = hasTab ? nextLine.replace(LEADING_WS, (ws) => expandTabStops(ws)) : nextLine;
            colForCompare = col;
          }
          // Pola break adalah ^ {0,clamped}(marker): pola itu hanya
          // bisa cocok bila tidak ada tab di depan, jumlah spasi di
          // depan <= clamped, dan karakter pertama bisa memulai blok.
          let isBreak = false;
          if (!hasTab && col <= clamped && firstCh !== '') {
            const code = firstCh.charCodeAt(0);
            if (code === 96 || code === 126 || code === 35 || code === 60 || code === 62 ||
                code === 42 || code === 43 || code === 45 || code === 95 || (code >= 48 && code <= 57)) {
              isBreak = fence.test(nextLine) || heading.test(nextLine) || html.test(nextLine) ||
                quote.test(nextLine) || bullet.test(nextLine) || hr.test(nextLine);
            }
          }
          if (isBreak) break;
          if (colForCompare >= contentIndent || blankLine) itemText += '\n' + expanded.slice(contentIndent);
          else {
            if (isEmpty || firstContent.replace(/\t/g, '    ').search(NON_SPACE) >= 4 ||
                fence.test(firstContent) || heading.test(firstContent) || html.test(firstContent) || hr.test(firstContent)) break;
            const setextLine = SETEXT_LINE.test(nextLine) && setextTextOk(firstContent)
              ? '    ' + expanded.replace(/^ {0,3}/, '')
              : nextLine;
            itemText += '\n' + setextLine;
          }
          isEmpty = blankLine;
          rest = rest.substring(curLine.length + 1);
          firstContent = expanded.slice(contentIndent);
        }
      }
      const itemRaw = full.slice(itemStart, consumed());
      if (!list.loose) {
        if (pendingLoose) list.loose = true;
        else if (DOUBLE_BLANK.test(itemRaw)) pendingLoose = true;
      }
      list.items.push({ type: 'list_item', raw: itemRaw, task: TASK_ITEM.test(itemText), loose: false, text: itemText, tokens: [] });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return null;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = full.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      const itemCtx = { links: this.links, defs: this.defs, top: false, mergePara: false, hadBlankBetween: false };
      item.tokens = new BlockLexer(item.text, itemCtx).parse();
      if (!list.loose && itemCtx.hadBlankBetween) list.loose = true;
    }
    for (const item of list.items) {
      const firstToken = item.tokens[0];
      if (item.task && (firstToken?.type === 'text' || firstToken?.type === 'paragraph')) {
        item.text = item.text.replace(TASK_PREFIX, '');
        firstToken.raw = firstToken.raw.replace(TASK_PREFIX, '');
        firstToken.text = firstToken.text.replace(TASK_PREFIX, '');
        const checkbox = TASK_BOX.exec(item.raw);
        if (checkbox) {
          item.checked = checkbox[0] !== '[ ]';
          item.hasCheckbox = true;
        }
      } else if (item.task) item.task = false;
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) if (token.type === 'text') token.type = 'paragraph';
      }
    }
    // Pemanggilan blockTokens bersarang mengembalikan state.top bersama
    // ke true.
    this.ctx.top = true;
    return { block: list, rawLen: list.raw.length };
  }

  // Parse blockquote mulai dari `pos` di `src`. Kembalikan {block,
  // rawLen} atau null.
  scanQuote(src, pos) {
    const source = src.slice(pos);
    if (!QUOTE_START.test(source)) return null;
    const { lines } = splitSourceLines(source);
    const nLines = lines.length;
    // Kumpulkan rangkaian blockquote: baris `>` + kelanjutan lazy-nya.
    let j = 0;
    while (j < nLines) {
      if (!isQuote(lines[j])) break;
      const content = lines[j].replace(/^ {0,3}>[ \t]?/, '');
      j++;
      if (content !== '') {
        while (j < nLines) {
          const next = lines[j];
          if (isBlank(next)) break;
          if (isQuote(next)) break;
          if (lazyLineOk(next)) j++; else break;
        }
      }
    }
    let remaining = lines.slice(0, j);
    let rawAccum = '';
    let textAccum = '';
    const tokens = [];
    while (remaining.length > 0) {
      let sawMarker = false;
      const groupLines = [];
      let lineIdx;
      for (lineIdx = 0; lineIdx < remaining.length; lineIdx++) {
        if (QUOTE_START.test(remaining[lineIdx])) { groupLines.push(remaining[lineIdx]); sawMarker = true; }
        else if (!sawMarker) groupLines.push(remaining[lineIdx]);
        else break;
      }
      remaining = remaining.slice(lineIdx);
      const groupText = groupLines.join('\n');
      const stripped = groupText
        .replace(QUOTE_MARKER_WS, (whole, marker, spaces) => marker + expandTabStops(spaces, marker.length))
        .replace(QUOTE_SETEXT, '\n    $1')
        .replace(QUOTE_STRIP, '');
      rawAccum = rawAccum ? rawAccum + '\n' + groupText : groupText;
      textAccum = textAccum ? textAccum + '\n' + stripped : stripped;
      const innerCtx = { links: this.links, defs: this.defs, top: true, mergePara: true };
      new BlockLexer(stripped, innerCtx, tokens).parse();
      if (remaining.length === 0) break;
      const lastToken = tokens.at(-1);
      if (!lastToken) break;
      if (lastToken.type === 'code' || lastToken.type === 'heading' || lastToken.type === 'hr' ||
          lastToken.type === 'html' || lastToken.type === 'table') break;
      if (lastToken.type === 'blockquote') {
        const nested = lastToken;
        const restText = remaining.join('\n');
        const reparsedSrc = nested.raw + '\n' + restText.replace(QUOTE_STRIP, '');
        const reparsed = this.scanQuote(reparsedSrc, 0);
        if (!reparsed) break;
        tokens[tokens.length - 1] = reparsed.block;
        const leftover = reparsedSrc.substring(reparsed.rawLen).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const consumedGroup = leftoverLines ? remaining.slice(0, -leftoverLines) : remaining;
        if (consumedGroup.length > 0) rawAccum = rawAccum + '\n' + consumedGroup.join('\n');
        textAccum = textAccum.substring(0, textAccum.length - nested.text.length) + reparsed.block.text;
        remaining = remaining.slice(consumedGroup.length);
        if (remaining.length > 0 && QUOTE_START.test(remaining[0])) continue;
        break;
      } else if (lastToken.type === 'list') {
        const nestedList = lastToken;
        const reparsedSrc = nestedList.raw + '\n' + remaining.join('\n');
        const reparsed = this.scanList(reparsedSrc, 0);
        if (!reparsed) break;
        tokens[tokens.length - 1] = reparsed.block;
        const extraLines = reparsed.rawLen > nestedList.raw.length
          ? reparsedSrc.slice(nestedList.raw.length + 1, reparsed.rawLen).split('\n').length
          : 0;
        if (extraLines > 0) {
          const extra = remaining.slice(0, extraLines).join('\n');
          rawAccum = rawAccum + '\n' + extra;
          textAccum = textAccum + '\n' + extra;
        }
        remaining = remaining.slice(extraLines);
        continue;
      }
      // paragraph/text/def: lanjut ke grup berikutnya
    }
    // NB: blockquote marked MENYIMPAN state.top sebelum blockTokens
    // dalam dan MEMULIHKANNYA setelahnya (berbeda dengan list, yang
    // membiarkannya true), jadi ctx.top pembungkus tidak berubah di
    // sini.
    return { block: { type: 'blockquote', raw: rawAccum, text: textAccum, tokens }, rawLen: rawAccum.length };
  }
}

// ================================================================ G. pola list & blockquote

const HTML_TAG_NAMES_SRC = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const LIST_OPEN = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const HR_WHOLE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const TASK_ITEM = /^\[[ xX]\][ \t]+\S/;
const TASK_PREFIX = /^\[[ xX]\][ \t]+/;
const TASK_BOX = /\[[ xX]\]/;
const SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;
const NON_SPACE = /[^ ]/;
const LEADING_WS = /^[ \t]+/;
const QUOTE_START = /^ {0,3}>/;
const QUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const QUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const QUOTE_STRIP = /^ {0,3}>[ \t]?/gm;

function itemLineRe(marker) {
  return new RegExp(`^( {0,3}${marker})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
}
function nextMarkerRe(indent) {
  return new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
}
function hrReFor(indent) {
  return new RegExp(`^ {0,${indent}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
}
function fenceReFor(indent) {
  return new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`);
}
function headingReFor(indent) {
  return new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`);
}
function htmlReFor(indent) {
  return new RegExp(`^ {0,${indent}}(?:</?(?:${HTML_TAG_NAMES_SRC})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
}
function quoteReFor(indent) {
  return new RegExp(`^ {0,${indent}}>`);
}

// Pola break hanya bergantung pada indent hasil clamp (0..3); cache
// supaya tidak dibuat ulang (dengan `new RegExp`) untuk tiap item list.
const BREAK_CACHE = new Map();
function breakSet(clamped) {
  let hit = BREAK_CACHE.get(clamped);
  if (!hit) {
    hit = {
      bullet: nextMarkerRe(clamped),
      hr: hrReFor(clamped),
      fence: fenceReFor(clamped),
      heading: headingReFor(clamped),
      html: htmlReFor(clamped),
      quote: quoteReFor(clamped),
    };
    BREAK_CACHE.set(clamped, hit);
  }
  return hit;
}
const ITEM_RE_CACHE = new Map();
function itemLinePatternCached(marker) {
  let hit = ITEM_RE_CACHE.get(marker);
  if (!hit) { hit = itemLineRe(marker); ITEM_RE_CACHE.set(marker, hit); }
  return hit;
}

// Bisakah `line` (satu baris) menjadi teks setext heading?
function setextTextOk(line) {
  if (!line.trim()) return false;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return false;
  if (/^(?: {4}| {0,3}\t)/.test(line)) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
  if (/^ {0,3}>/.test(line)) return false;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return false;
  return true;
}

// Apakah `line` kelanjutan paragraf lazy di dalam blockquote?
function lazyLineOk(line) {
  if (isBlank(line)) return false;
  if (isHr(line)) return false;
  if (atxLevel(line)) return false;
  if (isQuote(line)) return false;
  if (fenceHead(line)) return false;
  if (scanMarker(line, true)) return false;
  if (htmlKind(line)) return false;
  return true;
}

// ================================================================ H. renderer
// `engine` adalah Inline milik dokumen: lexer marked menyimpan SATU
// state inline untuk seluruh dokumen, hanya me-reset `inRawBlock`
// sebelum token inline tiap blok. Panggil `inlineHtml` untuk teks
// milik sebuah blok.

function inlineHtml(engine, text) {
  engine.st.inRawBlock = false;
  return engine.render(text, false);
}

function renderAllBlocks(blocks, engine) {
  let out = '';
  for (const block of blocks) out += renderOneBlock(block, engine);
  return out;
}

function renderOneBlock(block, engine) {
  switch (block.type) {
    case 'space':
      return '';
    case 'code': {
      const firstWord = (block.lang || '').match(/^\S*/)?.[0] || '';
      const body = block.text ? block.text.replace(/\n$/, '') + '\n' : '';
      const inner = escHtml(body, true);
      return firstWord
        ? `<pre><code class="language-${escHtml(firstWord)}">${inner}</code></pre>\n`
        : `<pre><code>${inner}</code></pre>\n`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderAllBlocks(block.tokens, engine)}</blockquote>\n`;
    case 'html':
      return block.text;
    case 'def':
      return '';
    case 'heading':
      return `<h${block.depth}>${inlineHtml(engine, block.text)}</h${block.depth}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'list': {
      let itemsHtml = '';
      for (const item of block.items) itemsHtml += renderListItem(item, engine);
      const tag = block.ordered ? 'ol' : 'ul';
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
      return `<${tag}${start}>\n${itemsHtml}</${tag}>\n`;
    }
    case 'table': {
      let headerHtml = '';
      for (const cell of block.header) headerHtml += renderTableCell(cell, true, engine);
      const headRow = `<tr>\n${headerHtml}</tr>\n`;
      let bodyHtml = '';
      for (const row of block.rows) {
        let rowHtml = '';
        for (const cell of row) rowHtml += renderTableCell(cell, false, engine);
        bodyHtml += `<tr>\n${rowHtml}</tr>\n`;
      }
      if (bodyHtml) bodyHtml = `<tbody>${bodyHtml}</tbody>`;
      return `<table>\n<thead>\n${headRow}</thead>\n${bodyHtml}</table>\n`;
    }
    case 'paragraph':
      return `<p>${inlineHtml(engine, block.text)}</p>\n`;
    case 'text':
      return inlineHtml(engine, block.text);
    case 'checkbox':
      return `<input ${block.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    default:
      return '';
  }
}

function renderListItem(item, engine) {
  let inner = renderAllBlocks(item.tokens, engine);
  if (item.hasCheckbox) {
    const box = `<input ${item.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    if (item.loose && inner.startsWith('<p>')) inner = '<p>' + box + inner.slice(3);
    else inner = box + inner;
  }
  return `<li>${inner}</li>\n`;
}

function renderTableCell(cell, isHeader, engine) {
  const tag = isHeader ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${inlineHtml(engine, cell.text)}</${tag}>\n`;
}

// ================================================================ I. titik masuk
// Jalur cepat dengan fallback per blok ke marked (diterima sebagai
// `markedParse`). `src` dinormalisasi dulu (\r -> \n), seperti lex()
// marked. Masukan pendek langsung ke marked: jalur cepat hanya
// menguntungkan pada dokumen yang lebih panjang.
function renderFast(src, markedParse) {
  const norm = src.replace(/\r\n?/g, '\n');
  if (norm.length < 2000) return markedParse(norm);
  const ctx = { links: {}, defs: [], top: true, mergePara: false };
  const blocks = new BlockLexer(norm, ctx).parse();
  const defsText = ctx.defs.map((d) => d.raw).join('');
  const engine = new Inline(ctx.links);
  let out = '';
  for (const block of blocks) {
    try {
      out += renderOneBlock(block, engine);
    } catch (e) {
      out += markedParse(defsText + '\n' + block.raw);
    }
  }
  return out;
}

// Wrapper kompatibel-mundur di sekitar kelas di atas.
function parseBlockTokens(src, ctx, blocks) {
  return new BlockLexer(src, ctx, blocks).parse();
}
function renderInlineText(src, links, st, textMode = false) {
  return new Inline(links, st).render(src, textMode);
}
function scanListAt(src, pos, ctx) {
  return new BlockLexer(src, ctx).scanList(src, pos);
}
function scanQuoteAt(src, pos, ctx) {
  return new BlockLexer(src, ctx).scanQuote(src, pos);
}

export { renderFast, parseBlockTokens, renderInlineText, scanListAt, scanQuoteAt };
