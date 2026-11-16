// fast.js — a fast renderer that produces byte-identical output to
// marked 18.1.3 with its defaults (gfm on, breaks off, pedantic off,
// async off), written for the make.fun "markdown-render-speed-02"
// competition.
//
// Layout of this file:
//   1. Small string/character helpers shared by both engines.
//   2. Inline pattern constants and the label/link scanners.
//   3. InlineEngine — the inline tokenizer/renderer (one instance per
//      document, holding the link definitions and the shared inline state).
//   4. Block-level line classifiers and definition scanning.
//   5. BlockParser — the block tokenizer (one instance per block context;
//      list items and blockquotes recurse through fresh instances that
//      share the link table).
//   6. The renderer that turns block tokens into HTML.
//   7. fastRender — the entry point, with a per-block fallback to the
//      vendored marked for anything the fast path cannot render.
//
// The fast path only claims documents it can render exactly; the entry
// point hands short inputs straight to marked and falls back block by
// block on any error, so a mistake in the fast path degrades to marked
// output instead of wrong output.

// ================================================================ 1. string helpers

// HTML escaping. With encode=true every & < > " ' is escaped; with
// encode=false (marked's noEncode) an & that starts a valid entity or
// numeric reference is left alone.
const ESC_TEST = /[&<>"']/;
const ESC_TEST_KEEP_ENT = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_RE = /[&<>"']/g;
const ESC_RE_KEEP_ENT = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESC_CHARS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text, encode) {
  if (encode) {
    if (ESC_TEST.test(text)) return text.replace(ESC_RE, (ch) => ESC_CHARS[ch]);
    return text;
  }
  if (ESC_TEST_KEEP_ENT.test(text)) return text.replace(ESC_RE_KEEP_ENT, (ch) => ESC_CHARS[ch]);
  return text;
}

// Decode numeric character references only — marked never decodes named
// entities. &#0;, surrogates and values above 0x10FFFF become U+FFFD;
// &#38; decodes to "&amp;" (the caller re-escapes it); &#60; to "&lt;".
const NUM_REF_TEST = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!NUM_REF_TEST.test(text)) return text;
  return text.replace(NUM_REF_RE, (match, decimal, hex) => {
    if (decimal === undefined && hex === undefined) return '&amp;';
    const code = decimal === undefined ? parseInt(hex, 16) : parseInt(decimal, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// cleanUrl: encodeURI, then put %25 back to %. A lone surrogate makes
// encodeURI throw, which drops the whole link.
const PCT25_RE = /%25/g;

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(PCT25_RE, '%');
  } catch {
    return null;
  }
}

// Drop trailing blank lines beyond the first one.
const BLANK_RE = /^[ \t]*$/;

function stripTrailingBlanks(text) {
  const parts = text.split('\n');
  let last = parts.length - 1;
  while (last >= 0 && BLANK_RE.test(parts[last])) last--;
  if (parts.length - last <= 2) return text;
  return parts.slice(0, last + 1).join('\n');
}

// Normalise a link reference label: trim, collapse inner whitespace to
// single spaces, then lowercase/uppercase/lowercase (a rough Unicode
// case fold, matching marked's behaviour).
const WS_RUN_RE = /\s+/g;

function normalizeLabel(label) {
  return label.trim().replace(WS_RUN_RE, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row into cells. A \| stays literal; cells are trimmed;
// empty edge cells are dropped; with `count` the row is cut or padded
// to exactly that many cells.
const PIPE_RE = /\|/g;
const PIPE_SPLIT_RE = / \|/;
const ESC_PIPE_RE = /\\\|/g;

function splitTableRow(row, count) {
  const markedPipes = row.replace(PIPE_RE, (ch, offset, whole) => {
    let escaped = false;
    for (let pos = offset; --pos >= 0 && whole[pos] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = markedPipes.split(PIPE_SPLIT_RE);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1).trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(ESC_PIPE_RE, '|');
  return cells;
}

// Balanced-paren check over a string (a backslash skips the next char).
// -1 = no parens at all, or balanced; -2 = an opening paren is left
// over; >= 0 = index of an unmatched closing paren.
function parenBalance(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column starting at `start`.
function expandTabs(str, start = 0) {
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

// Dedent fenced-code content by the opening fence's indent.
const FENCE_INDENT_RE = /^(\s+)(?:```)/;
const LEADING_SPACE_RE = /^[\s]+/;

function dedentFence(fenceLine, content) {
  const match = fenceLine.match(FENCE_INDENT_RE);
  if (match === null) return content;
  const indent = match[1];
  return content.split('\n').map((line) => {
    const leading = line.match(LEADING_SPACE_RE);
    if (leading === null) return line;
    return line.slice(Math.min(leading[0].length, indent.length));
  }).join('\n');
}

// ================================================================ character classes

// A Unicode punctuation/symbol character.
const PUNCT_SYM_RE = /[\p{P}\p{S}]/u;
const ALNUM_RE = /[\p{L}\p{N}]/u;

function isPunct(ch) {
  return ch !== '' && PUNCT_SYM_RE.test(ch);
}
// GFM "punct": punctuation/symbol except '~'.
function isGfmPunct(ch) {
  return ch !== '' && ch !== '~' && PUNCT_SYM_RE.test(ch);
}
// GFM "notPunctSpace": not whitespace and not punct/symbol — or '~'.
function isGfmWord(ch) {
  return ch !== '' && (ch === '~' || (!/\s/.test(ch) && !PUNCT_SYM_RE.test(ch)));
}
// GFM "punctSpace": whitespace or punct/symbol, except '~'.
function isGfmPunctSpace(ch) {
  return ch !== '' && ch !== '~' && (/\s/.test(ch) || PUNCT_SYM_RE.test(ch));
}
// Non-GFM "notPunctSpace" / "punctSpace": here '~' counts as punctuation.
// Used by the '_' closer and the '~' closer, which both use the non-GFM
// replacements — only '*' uses the GFM ones above.
function isPlainWord(ch) {
  return ch !== '' && !/\s/.test(ch) && !PUNCT_SYM_RE.test(ch);
}
function isPlainPunctSpace(ch) {
  return ch !== '' && (/\s/.test(ch) || PUNCT_SYM_RE.test(ch));
}
function isAlnum(ch) {
  return ch !== '' && ALNUM_RE.test(ch);
}
// The punctuation check used by emphasis/del openers: whitespace or
// punct/symbol, but not '*' or '_'.
function isOpenerPunct(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && (/\s/.test(ch) || PUNCT_SYM_RE.test(ch));
}

// ================================================================ 2. inline patterns

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
// A backslash escape: backslash + ASCII punctuation.
const BACKSLASH_ESC_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const TAG_RE = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const OPEN_A_RE = /^<a /i;
const CLOSE_A_RE = /^<\/a>/i;
const OPEN_PRE_RE = /^<(pre|code|kbd|script)(\s|>)/i;
const CLOSE_PRE_RE = /^<\/(pre|code|kbd|script)(\s|>)/i;
// GFM extended autolinks: mailto:/xmpp: | scheme://... | www.... | email.
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;
const EXT_URL_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const SKIP_BLOCK_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const REFLINK_RE = /!?\[(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?\]\[(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}\]|!?\[(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}\](?:\[\])?(?!\()/g;
const INLINE_LINK_START_RE = /^!?\[.*\]\(/s;

// Resolve backslash escapes of punctuation inside a href/title.
const ESCAPED_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
function unescapePunct(str) {
  return str.replace(ESCAPED_PUNCT_RE, '$1');
}

// The ']' matching the '[' at src[j], allowing one level of nested
// [..] groups inside. Returns the index of the matching ']', or -1.
function findMatchingBracket(src, j) {
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

// Scan a [label] starting at src[i] === '['. Returns {label, end} where
// end is the index just past the closing ']', or null. Nested groups are
// one level deep (marked's label pattern only allows a single nested
// [...] group).
function readLabel(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      // A code span in a label: marked's pattern allows the closing
      // backtick run to be ANY length, not necessarily equal to the
      // opener — e.g. `` ``url` `` is one code span. But the pattern
      // also has the `` ``+(?=\]) `` alternative — a run of TWO or more
      // backticks immediately before ']' — and its lazy matching prefers
      // the shorter label, so check that FIRST (only for runs of length
      // >= 2): such a run ends the label here rather than spanning to a
      // far-away backtick. A SINGLE backtick before ']' does NOT match
      // that alternative, so it must be a code span (find a closing run)
      // or the label fails.
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
      const m = findMatchingBracket(src, j);
      if (m < 0) return null;
      j = m + 1;
      continue;
    }
    if (ch === ']') return { label: src.slice(i + 1, j), end: j + 1 };
    j++;
  }
  return null;
}

// Does the label contain a tag that starts inside it and runs past its
// end (marked's check for a tag overrunning the label)? `labelStart` is
// the index of the label's first char in `src`; `labelLen` its length.
function labelTagOverruns(src, labelStart, labelLen) {
  const label = src.slice(labelStart, labelStart + labelLen);
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = CODE_SPAN_RE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(labelStart + s);
    const match = TAG_RE.exec(rest) || AUTOLINK_RE.exec(rest);
    if (match) {
      if (match[0].length > label.length - s) return true;
      s += match[0].length - 1;
    }
  }
  return false;
}

// Is there a link (inline or reference) inside `text`? Used by the
// masking step and by the reference-link tokenizer's own check.
function containsLink(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(SKIP_BLOCK_RE)) {
    if (INLINE_LINK_START_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_RE)) {
    const str = m[0];
    const lastBracket = str.lastIndexOf('[');
    if (!(str.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(str.slice(lastBracket + 1, -1)))) &&
        !(lastBracket > 1 && containsLink(str.slice(1, lastBracket - 1), links))) return true;
  }
  return false;
}

// Mask one reference-link match for the emphasis/delimiter closer
// search: the label text is replaced by filler so delimiter runs inside
// a defined reference label cannot close an emphasis.
function maskRefLink(match, links) {
  const lastBracket = match.lastIndexOf('[');
  if (!Object.hasOwn(links, normalizeLabel(match.slice(lastBracket + 1, -1)))) return match;
  if (lastBracket > 1 && match.charAt(0) !== '!') {
    const inner = match.slice(1, lastBracket - 1);
    if (containsLink(inner, links)) {
      return '[' + inner.replace(REFLINK_RE, (m) => maskRefLink(m, links)) + '][' +
        'a'.repeat(match.length - lastBracket - 2) + ']';
    }
  }
  return '[' + 'a'.repeat(match.length - 2) + ']';
}

// Mask a container string for the emphasis/delimiter closer search: hide
// delimiter runs that sit inside links, code spans, HTML tags, defined
// reference labels and escaped punctuation. The mask keeps the length, so
// positions in the masked string line up with the real string.
function maskDelimiters(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    masked = masked.replace(REFLINK_RE, (m) => maskRefLink(m, links));
  }
  // The two masking passes below only change anything when the text
  // contains a backtick/backslash (punct masking) or a
  // bracket/backtick/angle-bracket (block skip); skip the expensive
  // regex scans otherwise.
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(PUNCT_OUTSIDE_CODE_RE, (whole, span, escaped) => {
      if (escaped) return '+'.repeat(whole.length);
      if (span) return span + whole.slice(span.length, -span.length).replace(/`/g, '+') + span;
      return whole;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(SKIP_BLOCK_RE, (whole, _before, codeRun) => {
      const prefixLen = codeRun ? codeRun.length : 0;
      return whole.slice(0, prefixLen) + '[' + 'a'.repeat(whole.length - prefixLen - 2) + ']';
    });
  }
  return masked;
}

// The code point ending just before index `idx`, and the one starting at
// `idx` (surrogate-pair aware — the closer rules run with the `u` flag).
function codePointBefore(str, idx) {
  if (idx <= 0) return '';
  const low = str.charCodeAt(idx - 1);
  if (low >= 0xDC00 && low <= 0xDFFF && idx >= 2) {
    const high = str.charCodeAt(idx - 2);
    if (high >= 0xD800 && high <= 0xDBFF) return str.slice(idx - 2, idx);
  }
  return str[idx - 1];
}
function codePointAfter(str, idx) {
  if (idx >= str.length) return '';
  const high = str.charCodeAt(idx);
  if (high >= 0xD800 && high <= 0xDBFF && idx + 1 < str.length) {
    const low = str.charCodeAt(idx + 1);
    if (low >= 0xDC00 && low <= 0xDFFF) return str.slice(idx, idx + 2);
  }
  return str[idx];
}

// Classify a delimiter run for the closer search (marked's delimiter
// groups). `ch` is '*' or '_' or '~'; `prev` is the char before the run
// ('' at the start), `next` the char after it ('' at the end). Returns 0
// (not a closer at all), 1/2 (plain closer), 3/4 (cannot close —
// absorbed into the opener count), 5/6 (conditional closer — rule of
// 3s / previous-char check).
function classifyCloser(ch, prev, next) {
  if (ch === '~') {
    // '~' uses the non-GFM classes: '~' IS punct/punctSpace, NOT
    // notPunctSpace.
    if (isPunct(prev) && (next === '' || /\s/.test(next))) return 1;
    if (isPlainWord(prev) && (next === '' || isPlainPunctSpace(next))) return 2;
    if (isPlainPunctSpace(prev) && isPlainWord(next)) return 3;
    if (prev !== '' && /\s/.test(prev) && isPunct(next)) return 4;
    if (isPunct(prev) && isPunct(next)) return 5;
    if (isPlainWord(prev) && isPlainWord(next)) return 6;
    return 0;
  }
  if (ch === '_') {
    // '_' uses the non-GFM classes too. Note: no group 6 for '_'
    // (intraword '_' cannot close).
    if (isPunct(prev) && (next === '' || /\s/.test(next))) return 1;
    if (isPlainWord(prev) && (next === '' || isPlainPunctSpace(next))) return 2;
    if (isPlainPunctSpace(prev) && isPlainWord(next)) return 3;
    if (prev !== '' && /\s/.test(prev) && isPunct(next)) return 4;
    if (isPunct(prev) && isPunct(next)) return 5;
    return 0;
  }
  // '*' uses the GFM classes: '~' is NOT punct/punctSpace, IS
  // notPunctSpace.
  if (isGfmPunct(prev) && (next === '' || /\s/.test(next))) return 1;
  if (isGfmWord(prev) && (next === '' || isGfmPunctSpace(next))) return 2;
  if (isGfmPunctSpace(prev) && isGfmWord(next)) return 3;
  if (prev !== '' && /\s/.test(prev) && isGfmPunct(next)) return 4;
  if (isGfmPunct(prev) && isGfmPunct(next)) return 5;
  if (isGfmWord(prev) && isGfmWord(next)) return 6;
  return 0;
}

// The "skip" alternative of the closer rules: when scanning for a closer
// for `ch`, a span `__...*...__` (for '*') or `**..._...**` (for '_') is
// skipped wholesale. Returns the index to resume scanning at, or -1.
function skipEmphasisSpan(masked, from, ch) {
  const open = ch === '*' ? '__' : '**';
  const inner = ch === '*' ? '*' : '_';
  const n = masked.length;
  // The first `open` must be the first delimiter in the text (no * or _
  // before it).
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

// ================================================================ 3. inline engine

// Find a valid GFM email starting at or after `from` (the position to
// start looking for '@'); returns its start index, or -1.
const EMAIL_LOCAL_RE = /[A-Za-z0-9._+-]/;
const EMAIL_DOMAIN_RE = /^[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;

// Email local-part char, by char code (faster than a regex test).
function isEmailLocalCode(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 46 || code === 95 || code === 43 || code === 45;
}

// End of the current text chunk (marked's GFM text rule, implemented as
// a scan instead of the lazy regex). `i` is the chunk start. A single
// pass replaces ~15 indexOf scans.
function textChunkEnd(src, i) {
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
      case 119: // w — www. (needs a boundary before it)
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
          while (start > 0 && isEmailLocalCode(src.charCodeAt(start - 1))) start--;
          if (start < p && EMAIL_DOMAIN_RE.test(src.slice(p + 1))) return start <= i ? firstEnd : start;
        }
        break;
      case 10: // \n — hard break: 2+ spaces before it
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

// The inline tokenizer/renderer. One instance serves a whole document:
// `links` is the document's reference-definition table and `st` is the
// shared inline state — marked's lexer keeps ONE state across all inline
// parses, resetting only `inRawBlock` before each block's inline tokens,
// while `inLink` persists across blocks (an unclosed `<a ...>` tag
// disables GFM url/email linkification for the rest of the document).
class InlineEngine {
  constructor(links, st) {
    this.links = links;
    this.st = st || { inLink: false, linkEmitted: false, inRawBlock: false };
  }

  // Parse inline markdown into HTML (or plain text when textMode is
  // true — the label text of an image, or a heading's text content).
  render(src, textMode = false) {
    const n = src.length;
    if (n === 0) return '';
    const links = this.links;
    const st = this.st;
    const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
    const masked = hasDelim ? maskDelimiters(src, links) : src;
    const parenPossible = src.includes(')');
    let out = '';
    let i = 0;
    let prevLast = ''; // previous token's last char (for emStrong/del)
    let wasText = false;
    while (i < n) {
      if (!wasText) prevLast = '';
      wasText = false;
      const ch = src[i];
      // 1. Escape — in textMode the char is returned raw (marked's text
      // renderer renders an escape token via its text() method).
      if (ch === '\\' && i + 1 < n && ASCII_PUNCT.has(src[i + 1])) {
        out += textMode ? src[i + 1] : escapeHtml(src[i + 1]);
        i += 2;
        continue;
      }
      // 2. Raw HTML tag.
      if (ch === '<') {
        const m = TAG_RE.exec(src.slice(i));
        if (m) {
          const tag = m[0];
          if (!st.inLink && OPEN_A_RE.test(tag)) st.inLink = true;
          else if (st.inLink && CLOSE_A_RE.test(tag)) st.inLink = false;
          if (!st.inRawBlock && OPEN_PRE_RE.test(tag)) st.inRawBlock = true;
          else if (st.inRawBlock && CLOSE_PRE_RE.test(tag)) st.inRawBlock = false;
          out += tag;
          i += tag.length;
          continue;
        }
      }
      // 3. Inline link / image.
      if (parenPossible && (ch === '[' || (ch === '!' && src[i + 1] === '['))) {
        const lk = this.readInlineLink(src, i);
        if (lk) {
          const made = this.buildLink(lk.label, lk.href, lk.title, lk.isImage, lk.end, textMode);
          if (made) {
            out += made.html;
            i = made.end;
            continue;
          }
          // Link dropped (a nested link inside) — fall through to text.
        }
      }
      // 4. Reference link / image.
      if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
        const rl = this.readReferenceLink(src, i);
        if (rl) {
          if (labelTagOverruns(src, (rl.isImage ? i + 1 : i) + 1, rl.label.length)) {
            // A tag crossing the label — not a link; fall through to text.
          } else {
            const def = links[normalizeLabel(rl.ref || rl.label)];
            if (def) {
              const made = this.buildLink(rl.label, def.href, def.title, rl.isImage, rl.end, textMode);
              if (made) {
                out += made.html;
                i = made.end;
                continue;
              }
            } else {
              // Unresolved: only the first char becomes text.
              const first = src[i];
              out += textMode ? escapeHtml(first) : escapeHtml(decodeNumericRefs(first));
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
        const em = this.tryEmphasis(src, masked, i, prevLast, textMode);
        if (em) {
          out += em.html;
          i = em.end;
          continue;
        }
      }
      // 6. Code span.
      if (ch === '`') {
        const m = CODE_SPAN_RE.exec(src.slice(i));
        if (m) {
          let span = m[2].replace(/\n/g, ' ');
          if (/[^ ]/.test(span) && /^ /.test(span) && / $/.test(span)) span = span.substring(1, span.length - 1);
          out += textMode ? span : '<code>' + escapeHtml(span, true) + '</code>';
          i += m[0].length;
          continue;
        }
      }
      // 7. Hard break (two spaces + newline, or backslash + newline).
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
        const d = this.tryDel(src, masked, i, prevLast, textMode);
        if (d) {
          out += d.html;
          i = d.end;
          continue;
        }
      }
      // 9. Autolink <...>.
      if (ch === '<') {
        const m = AUTOLINK_RE.exec(src.slice(i));
        if (m) {
          const isEmail = m[2] === '@';
          const text = m[1];
          const href = isEmail ? 'mailto:' + text : text;
          const clean = cleanUrl(href);
          if (clean !== null) {
            if (textMode) out += text;
            else out += '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(text, true) + '</a>';
            i += m[0].length;
            continue;
          }
        }
      }
      // 10. GFM extended URL / email (not inside a link).
      if (!st.inLink) {
        const m = EXT_URL_RE.exec(src.slice(i));
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
              const bp = BACKPEDAL_RE.exec(raw);
              raw = bp ? bp[0] : '';
            } while (raw !== prev);
            text = raw;
            href = m[1] === 'www.' ? 'http://' + raw : raw;
          }
          const clean = cleanUrl(href);
          if (clean !== null) {
            if (textMode) out += text;
            else out += '<a href="' + escapeHtml(clean, true) + '">' + escapeHtml(text, true) + '</a>';
            i += text.length;
            continue;
          }
        }
      }
      // 11. Text. In textMode the chunk is decoded but NOT escaped —
      // marked's text renderer returns the token text as-is; the caller
      // escapes it when placing it in an attribute.
      const end = textChunkEnd(src, i);
      const chunk = src.slice(i, end);
      if (textMode) {
        out += st.inRawBlock ? chunk : decodeNumericRefs(chunk);
      } else {
        out += st.inRawBlock ? chunk : escapeHtml(decodeNumericRefs(chunk));
      }
      if (chunk.slice(-1) !== '_') prevLast = chunk.slice(-1);
      wasText = true;
      i = end;
    }
    return out;
  }

  // Try emphasis/strong at src[i] (src[i] is '*' or '_'). `masked` is
  // the masked container string, `prevChar` the previous token's last
  // char. Returns {html, end} (end = index just past the em/strong) or
  // null.
  tryEmphasis(src, masked, i, prevChar, textMode) {
    const ch = src[i];
    // Opener run, then a punct char or a non-space char must follow.
    let j = i;
    while (j < src.length && src[j] === ch) j++;
    const runHere = j - i;
    if (j >= src.length) return null;
    const after = src[j];
    if (after === ' ' || after === '\t' || after === '\n') return null;
    const followedByPunct = isGfmPunct(after);
    // The run may extend before i (a previous token ended with the same
    // char).
    let runStart = i;
    while (runStart > 0 && masked[runStart - 1] === ch) runStart--;
    const charBeforeRun = runStart > 0 ? codePointBefore(masked, runStart) : '';
    const beforeIsPunctOrDelim = charBeforeRun === '*' || charBeforeRun === '_' || isOpenerPunct(charBeforeRun);
    const charBeforeToken = runStart < i ? charBeforeRun : prevChar;
    const beforeIsOpenerPunct = runStart < i ? beforeIsPunctOrDelim : isOpenerPunct(charBeforeToken);
    if (ch === '_' && !followedByPunct && isAlnum(charBeforeToken)) return null; // intraword _
    const punctAfter = followedByPunct ? after : '';
    if (punctAfter && charBeforeToken !== '' && !beforeIsOpenerPunct) return null; // cannot open (not left-flanking)
    const fullRun = i - runStart + runHere;
    const ruleOfThreesApplies = charBeforeRun.trim() !== '' &&
      (punctAfter !== '' || (ch === '*' && !beforeIsPunctOrDelim));
    const prevIsSameDelim = prevChar === ch;
    // Scan for a closer in the masked string, starting after the opener.
    let pos = i + runHere;
    const skipTo = skipEmphasisSpan(masked, pos, ch);
    if (skipTo >= 0) pos = skipTo;
    let remaining = runHere;
    let absorbed = 0;
    while (pos < masked.length) {
      // Find the next run of ch.
      let q = pos;
      while (q < masked.length && masked[q] !== ch) q++;
      if (q >= masked.length) break;
      let r = q;
      while (r < masked.length && masked[r] === ch) r++;
      const closerLen = r - q;
      const prev = codePointBefore(masked, q);
      const next = codePointAfter(masked, r);
      const group = classifyCloser(ch, prev, next);
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

  // Try strikethrough at src[i] (src[i] is '~'). Returns {html, end}
  // or null.
  tryDel(src, masked, i, prevChar, textMode) {
    let j = i;
    while (j < src.length && src[j] === '~' && j - i < 2) j++;
    const openerLen = j - i; // opener length (1 or 2)
    if (openerLen === 0) return null;
    if (j >= src.length) return null;
    const after = src[j];
    if (after === ' ' || after === '\t' || after === '\n' || after === '~') return null;
    const followedByPunct = isGfmPunct(after);
    if (followedByPunct && prevChar !== '' && !isOpenerPunct(prevChar)) return null;
    let remaining = openerLen;
    let pos = i + openerLen;
    while (pos < masked.length) {
      let q = pos;
      while (q < masked.length && masked[q] !== '~') q++;
      if (q >= masked.length) break;
      let r = q;
      while (r < masked.length && masked[r] === '~') r++;
      const closerLen = r - q;
      if (closerLen !== openerLen) { pos = r; continue; } // closer must be exactly the opener length
      const prev = codePointBefore(masked, q);
      const next = codePointAfter(masked, r);
      const group = classifyCloser('~', prev, next);
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

  // Scan an inline link/image at src[i]: [label](dest "title") or
  // ![label](...). Returns {isImage, label, href, title, end} or null.
  readInlineLink(src, i) {
    const isImage = src[i] === '!';
    const labelStart = isImage ? i + 1 : i;
    const lab = readLabel(src, labelStart);
    if (!lab) return null;
    if (labelTagOverruns(src, labelStart + 1, lab.label.length)) return null;
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
      const unbalanced = parenBalance(href, '()');
      if (unbalanced === -2) return null;
      if (unbalanced > -1) {
        // Truncate the href at the unmatched ')'; the title is dropped
        // and the raw match ends right after that ')'.
        href = href.substring(0, unbalanced);
        rawEnd = destStart + unbalanced + 1;
        title = '';
      }
    }
    if (rawEnd < 0) {
      // Optional title, after a separator of spaces/tabs (with an
      // optional newline) or a newline.
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
        const found = this.readLinkTitle(src, k);
        if (found) { title = found.title; k = found.end; }
      }
      while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
      if (src[k] !== ')') return null;
      // The closing ')' must not be escaped.
      let backslashes = 0;
      for (let q = k - 1; q >= 0 && src[q] === '\\'; q--) backslashes++;
      if (backslashes % 2 === 1) return null;
      rawEnd = k + 1;
    }
    return {
      isImage,
      label: lab.label.replace(/\\([\[\]])/g, '$1'),
      href: unescapePunct(href.trim()),
      title: title === null ? null : unescapePunct(title),
      end: rawEnd,
    };
  }

  // Scan a link title at src[i]: "..." | '...' | (...).
  // Returns {title, end} or null.
  readLinkTitle(src, i) {
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

  // Scan a reference link at src[i]: [label][ref] | [label][] | [ref] |
  // [ref][]. Returns {isImage, label, ref, end} or null. `ref` is ''
  // for the collapsed form (meaning "use the label").
  readReferenceLink(src, i) {
    const isImage = src[i] === '!';
    const labelStart = isImage ? i + 1 : i;
    if (src[labelStart] !== '[') return null;
    const lab = readLabel(src, labelStart);
    if (!lab) return null;
    const afterLabel = lab.end;
    if (src[afterLabel] === '[') {
      // [label][ref] or [label][]
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
    // Shortcut form: [ref] or [ref][]
    if (lab.label.length === 0) return null;
    if (/^\s/.test(lab.label) && lab.label.trim() === '') return null;
    let end = afterLabel;
    if (src[end] === '[' && src[end + 1] === ']') end += 2;
    return { isImage, label: lab.label, ref: lab.label, end };
  }

  // Build a link/image from a parsed label + destination (marked's
  // link renderer). Returns {html, end} or null (when a nested link was
  // emitted inside the label, the outer link is dropped). `rawEnd` is
  // the index just past the whole link in the source.
  buildLink(label, href, title, isImage, rawEnd, textMode) {
    const st = this.st;
    const labelText = label.replace(/\\([\[\]])/g, '$1');
    const savedInLink = st.inLink;
    const savedEmitted = st.linkEmitted;
    const savedRaw = st.inRawBlock;
    st.inLink = true;
    st.linkEmitted = false;
    // An image's label is always rendered as plain text (the alt text) —
    // even when the image itself is in HTML mode. A link's label follows
    // the caller's mode.
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
      // In text mode a link/image renders as its label text.
      return { html: inner, end: rawEnd };
    }
    if (isImage) {
      const clean = cleanUrl(href);
      if (clean === null) return { html: escapeHtml(inner), end: rawEnd };
      let out = `<img src="${escapeHtml(clean)}" alt="${escapeHtml(inner)}"`;
      if (title) out += ` title="${escapeHtml(title)}"`;
      return { html: out + '>', end: rawEnd };
    }
    const clean = cleanUrl(href);
    if (clean === null) return { html: inner, end: rawEnd };
    let out = `<a href="${escapeHtml(clean)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return { html: out + '>' + inner + '</a>', end: rawEnd };
  }
}

// ================================================================ 4. block line classifiers
// Line-based block parsing. The source is split into lines (without the
// '\n'); `starts[i]` is the byte offset of line i, `starts[lines.length]`
// is the source length, so raw(a, b) = src.slice(starts[a], starts[b]).

const BLOCK_TAGS = new Set('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'.split('|'));
const RAW_BLOCK_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

function splitLines(src) {
  if (src === '') return { lines: [], starts: [0] };
  const lines = src.split('\n');
  const starts = [0];
  for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
  return { lines, starts };
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

// The line with up to 3 leading spaces/tabs stripped (returns the rest
// and how many columns were stripped). Tabs count by column.
function stripLead3(line) {
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

const HR_RUN_RE = /^(?:-[\t ]*){3,}$|^(?:_[\t ]*){3,}$|^(?:\*[\t ]*){3,}$/;
function isHorizontalRule(line) {
  const { rest } = stripLead3(line);
  // Do NOT trim the leading whitespace: a tab at the start is 4 columns,
  // so `\t***` is NOT an hr (marked allows only 0-3 spaces). HR_RUN_RE
  // already allows trailing spaces/tabs.
  return HR_RUN_RE.test(rest) && /^(?:-|\*|_)/.test(rest);
}

function atxDepth(line) {
  const { rest } = stripLead3(line);
  const m = /^(#{1,6})(?:\s|$)/.exec(rest);
  return m ? m[1].length : 0;
}

function fenceInfo(line) {
  const { rest } = stripLead3(line);
  const m = /^(`{3,}(?=[^`\n]*$)|~{3,})/.exec(rest);
  return m ? { ch: m[0][0], len: m[0].length, info: rest.slice(m[0].length) } : null;
}

function isQuoteLine(line) {
  return /^ {0,3}>/.test(line);
}

// A list marker at the start of a line (after <= 3 spaces). `anyOrdered`
// allows any start number (for the lazy-line / setext checks); otherwise
// only a bullet or "1." / "1)" interrupts a paragraph.
function readListMarker(line, anyOrdered) {
  const { rest } = stripLead3(line);
  let m = /^([*+-])(?=[ \t]|$)/.exec(rest);
  if (m) return { marker: m[1], ordered: false, start: 0, rest: rest.slice(1) };
  m = anyOrdered
    ? /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest)
    : /^(1)([.)])(?=[ \t]|$)/.exec(rest);
  if (m) return { marker: m[1] + m[2], ordered: true, start: parseInt(m[1], 10), rest: rest.slice(m[0].length) };
  return null;
}

// Does the list marker on this line interrupt a paragraph? Marked's
// paragraph rule requires `[ \t]+[^ \t\n]` after the marker — an empty
// item (`*` or `1.` alone, or with only trailing whitespace) does NOT
// interrupt, so the line stays paragraph text.
function markerBreaksParagraph(line) {
  const marker = readListMarker(line, false);
  if (!marker) return false;
  return /^[ \t]+[^ \t]/.test(marker.rest);
}

// HTML block start (types 1-6 only — type 7 cannot interrupt a
// paragraph). Returns the type number or 0.
function htmlBlockKind(line) {
  const { rest } = stripLead3(line);
  if (!rest.startsWith('<')) return 0;
  const m1 = /^<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(rest);
  if (m1) return 1;
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(rest)) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]+|\n|\/?>|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) return 6;
  return 0;
}

// Type 7: any complete tag on one line, only whitespace after it.
function isHtmlTypeSeven(line) {
  const { rest } = stripLead3(line);
  if (!rest.startsWith('<')) return false;
  const m = TAG_RE.exec(rest);
  if (!m) return false;
  const after = rest.slice(m[0].length);
  return /^[ \t]*$/.test(after);
}

// A table delimiter line (for the header/delimiter check).
function isDelimiterRow(line) {
  const { rest } = stripLead3(line);
  return /^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(rest) && /[:|]/.test(rest);
}

// Does lines[i] (header) + lines[i+1] (delimiter) start a table?
function beginsTable(lines, i) {
  if (i + 1 >= lines.length) return false;
  const header = lines[i];
  if (header.trim() === '') return false;
  if (!/^\S/.test(header.replace(/^ */, ''))) return false;
  const delim = lines[i + 1];
  if (!isDelimiterRow(delim)) return false;
  const headerCells = splitTableRow(header);
  const delimCells = delim.replace(/^\||\| *$/g, '').split('|');
  return headerCells.length === delimCells.length;
}

// Paragraph continuation check (GFM paragraph rule, line-based).
function paragraphContinues(lines, i) {
  const line = lines[i];
  if (isBlankLine(line)) {
    // A trailing whitespace-only line with no '\n' after it (last line,
    // non-empty) is part of the paragraph: marked's paragraph pattern
    // excludes only `[ \t]+\n` (whitespace + newline), so the lookahead
    // fails at end of input and the line is included.
    return i === lines.length - 1 && line !== '';
  }
  if (/^[ \t]+\n?$/.test(line) && line.trim() === '') return false;
  if (isHorizontalRule(line)) return false;
  if (atxDepth(line)) return false;
  if (isQuoteLine(line)) return false;
  if (fenceInfo(line)) return false;
  if (markerBreaksParagraph(line)) return false;
  if (htmlBlockKind(line)) return false;
  if (beginsTable(lines, i)) return false;
  return true;
}

// Setext text continuation (the setext-heading text rule): like a
// paragraph, but a bullet of any kind stops it, and a
// table-delimiter-like line stops it.
function setextTextContinues(lines, i) {
  const line = lines[i];
  if (isBlankLine(line)) return false;
  if (readListMarker(line, true)) return false;
  if (fenceInfo(line)) return false;
  if (isQuoteLine(line)) return false;
  if (atxDepth(line)) return false;
  if (isHorizontalRule(line)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return false;
  if (/^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/.test(line)) return false;
  return true;
}

function setextDepth(line) {
  const { rest } = stripLead3(line);
  const m = /^((?:=+|-+))[ \t]*$/.exec(rest);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}

// Scan a link reference definition at the start of `src` (from `pos`).
// Returns {label, href, title, rawLen} or null. `rawLen` is the number
// of source characters consumed (including trailing newlines).
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
function readDefinitionAt(src, pos) {
  const m = DEF_RE.exec(src.slice(pos));
  if (!m) return null;
  const dest = m[2];
  if (!dest.startsWith('<') && parenBalance(dest, '()') !== -1) return null;
  const href = dest.startsWith('<')
    ? dest.slice(1, -1).replace(ESCAPED_PUNCT_RE, '$1')
    : dest.replace(ESCAPED_PUNCT_RE, '$1');
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ESCAPED_PUNCT_RE, '$1') : null;
  return { label: m[1], href, title, rawLen: m[0].length };
}

// Fence-closing and HTML-close regexes, cached per key instead of
// rebuilding one for every line scanned.
const REGEX_CACHE = new Map();
function closingFenceRegex(ch, len) {
  const key = ch + len;
  let rx = REGEX_CACHE.get(key);
  if (!rx) {
    rx = new RegExp('^(' + (ch === '`' ? '`' : '~') + '{' + len + ',})[ \\t]*$');
    REGEX_CACHE.set(key, rx);
  }
  return rx;
}
function htmlCloseRegex(tag) {
  const key = 'html/' + tag;
  let rx = REGEX_CACHE.get(key);
  if (!rx) {
    rx = new RegExp('</' + tag + '>', 'i');
    REGEX_CACHE.set(key, rx);
  }
  return rx;
}

// ================================================================ 5. block parser
// ctx: {links, defs, top, mergePara, hadBlankBetween}
//   links: label -> {href, title} (first definition wins)
//   defs:  [{raw}] in document order (for the marked fallback)
//   top:   true at the top level / inside blockquotes, false inside list
//          items
//   mergePara: true when parsing blockquote inner content (only the
//          FIRST paragraph of this call may merge into a previous
//          paragraph)
// `into` is an optional shared blocks array to append to (blockquote
// groups accumulate into one array).

class BlockParser {
  constructor(src, ctx, into) {
    const { lines, starts } = splitLines(src);
    this.src = src;
    this.ctx = ctx;
    this.links = ctx.links;
    this.defs = ctx.defs;
    this.lines = lines;
    this.starts = starts;
    this.n = lines.length;
    this.blocks = into || [];
    this.i = 0;
    this.emitted = false; // any block appended by this call yet
    this.lastEnd = 0;     // line index just after the last emitted block
    this.sawBlank = false; // a blank line was skipped after a block
  }

  rawOf(a, b) {
    return this.src.slice(this.starts[a], this.starts[b]);
  }
  prevBlock() {
    return this.blocks[this.blocks.length - 1];
  }
  mark(endLine) {
    if (this.sawBlank && this.emitted) this.ctx.hadBlankBetween = true;
    this.sawBlank = false;
    this.emitted = true;
    this.lastEnd = endLine;
  }

  parse() {
    while (this.i < this.n) {
      const line = this.lines[this.i];
      if (isBlankLine(line)) { this.sawBlank = true; this.i++; continue; }
      if (this.tryIndentedCode()) continue;
      if (this.tryFencedCode()) continue;
      if (this.tryAtxHeading()) continue;
      if (this.tryHr()) continue;
      if (this.tryBlockquote()) continue;
      if (this.tryList()) continue;
      if (this.tryHtmlBlock()) continue;
      if (this.tryDefinition()) continue;
      if (this.tryTable()) continue;
      if (this.trySetextHeading()) continue;
      this.readParagraphOrText();
    }
    // Marked's lexer keeps ONE shared `state.top` across all blockTokens
    // calls and sets it back to true at the end of each call: after a
    // nested list/blockquote is parsed, the following blocks in the
    // enclosing context are parsed as paragraphs (top=true), not
    // one-line text tokens.
    this.ctx.top = true;
    return this.blocks;
  }

  tryIndentedCode() {
    const line = this.lines[this.i];
    if (!/^(?: {4}| {0,3}\t)/.test(line) || line.trim() === '') return false;
    const { lines, src } = this;
    const n = this.n;
    let j = this.i;
    let lastCode = this.i;
    while (j < n) {
      if (/^(?: {4}| {0,3}\t)/.test(lines[j]) && lines[j].trim() !== '') { lastCode = j; j++; continue; }
      if (isBlankLine(lines[j])) {
        let k = j + 1;
        while (k < n && isBlankLine(lines[k])) k++;
        if (k < n && /^(?: {4}| {0,3}\t)/.test(lines[k]) && lines[k].trim() !== '') { j = k; continue; }
        break;
      }
      break;
    }
    // Marked's indented-code match includes the trailing blank lines
    // after the code, so stripTrailingBlanks() strips them; without them
    // the merged text keeps a trailing '\n'. Include them in rawText (i
    // still advances only past the code lines, so the blanks are seen by
    // the main loop).
    let rawEnd = lastCode + 1;
    while (rawEnd < n && isBlankLine(lines[rawEnd])) rawEnd++;
    const rawText = this.rawOf(this.i, rawEnd);
    let text = stripTrailingBlanks(rawText);
    text = text.replace(/^(?: {0,3}\t| {1,4})/gm, '');
    const prev = this.prevBlock();
    if (prev && (prev.type === 'paragraph' || prev.type === 'text') && this.i === this.lastEnd) {
      prev.text += '\n' + text;
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + rawText;
      this.lastEnd = lastCode + 1;
      this.i = lastCode + 1;
      return true;
    }
    this.blocks.push({ type: 'code', raw: rawText, text, lang: '', fenced: false });
    this.mark(lastCode + 1);
    this.i = lastCode + 1;
    return true;
  }

  tryFencedCode() {
    const fence = fenceInfo(this.lines[this.i]);
    if (!fence || (fence.ch === '`' && fence.info.includes('`'))) return false;
    const { lines, src } = this;
    const n = this.n;
    let j = this.i + 1;
    let closed = -1;
    while (j < n) {
      const { rest: rest2 } = stripLead3(lines[j]);
      const m = closingFenceRegex(fence.ch, fence.len).exec(rest2);
      if (m) { closed = j; break; }
      j++;
    }
    const contentEnd = closed >= 0 ? closed : n;
    let content = src.slice(this.starts[this.i + 1], this.starts[contentEnd]);
    // Marked's fence match group 3 excludes the final newline before the
    // closing fence (or EOF); the renderer re-adds exactly one.
    if (content.endsWith('\n')) content = content.slice(0, -1);
    content = dedentFence(this.rawOf(this.i, this.i + 1), content);
    const info = fence.info.trim().replace(ESCAPED_PUNCT_RE, '$1');
    const lang = info.match(/^\S*/)?.[0] || '';
    this.blocks.push({ type: 'code', raw: this.rawOf(this.i, closed >= 0 ? closed + 1 : n), text: content, lang, fenced: true });
    const next = contentEnd + (closed >= 0 ? 1 : 0);
    this.mark(next);
    this.i = next;
    return true;
  }

  tryAtxHeading() {
    const line = this.lines[this.i];
    const atx = atxDepth(line);
    if (!atx) return false;
    const { rest } = stripLead3(line);
    let text = rest.slice(atx);
    text = text.replace(/^[ \t]+/, '');
    const closing = /[ \t]+#+[ \t]*$/.exec(text) || /^(#+)[ \t]*$/.exec(text);
    if (closing) text = text.slice(0, text.length - closing[0].length);
    text = text.replace(/[ \t]+$/, '');
    this.blocks.push({ type: 'heading', raw: this.rawOf(this.i, this.i + 1), depth: atx, text });
    this.mark(this.i + 1);
    this.i++;
    return true;
  }

  tryHr() {
    if (!isHorizontalRule(this.lines[this.i])) return false;
    this.blocks.push({ type: 'hr', raw: this.rawOf(this.i, this.i + 1) });
    this.mark(this.i + 1);
    this.i++;
    return true;
  }

  tryBlockquote() {
    if (!isQuoteLine(this.lines[this.i])) return false;
    const bq = this.readBlockquoteAt(this.src, this.starts[this.i]);
    if (!bq) return false;
    this.blocks.push(bq.block);
    const consumed = this.src.slice(this.starts[this.i], this.starts[this.i] + bq.rawLen);
    let next = this.i + consumed.split('\n').length;
    if (consumed.endsWith('\n')) next--;
    this.mark(next);
    this.i = next;
    return true;
  }

  tryList() {
    // Any ordered start can begin a list at a block boundary; only `1`
    // interrupts a paragraph, handled inside paragraphContinues.
    const marker = readListMarker(this.lines[this.i], true);
    if (!marker || !(marker.rest === '' || /^[ \t]/.test(marker.rest))) return false;
    const lst = this.readListAt(this.src, this.starts[this.i]);
    if (!lst) return false;
    this.blocks.push(lst.block);
    const consumed = this.src.slice(this.starts[this.i], this.starts[this.i] + lst.rawLen);
    let next = this.i + consumed.split('\n').length;
    if (consumed.endsWith('\n')) next--;
    this.mark(next);
    this.i = next;
    return true;
  }

  tryHtmlBlock() {
    const line = this.lines[this.i];
    const htmlKind = htmlBlockKind(line) || (isHtmlTypeSeven(line) ? 7 : 0);
    if (!htmlKind) return false;
    const hb = this.readHtmlBlock(this.i, htmlKind);
    this.blocks.push({ type: 'html', raw: hb.raw, text: hb.text, pre: hb.pre });
    this.mark(hb.next);
    this.i = hb.next;
    return true;
  }

  tryDefinition() {
    const def = readDefinitionAt(this.src, this.starts[this.i]);
    if (!def) return false;
    const defRaw = this.src.slice(this.starts[this.i], this.starts[this.i] + def.rawLen);
    // Lines spanned: newlines + 1, unless the raw ends with a newline
    // (then the last split element is empty and adds no line).
    const consumed = defRaw.endsWith('\n')
      ? defRaw.split('\n').length - 1
      : defRaw.split('\n').length;
    const prev = this.prevBlock();
    if (prev && (prev.type === 'paragraph' || prev.type === 'text') && this.i === this.lastEnd) {
      // Merged into the previous paragraph/text: NOT registered as a link.
      prev.text += '\n' + defRaw;
      prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + defRaw;
      this.lastEnd = this.i + Math.max(1, consumed);
      this.i = this.lastEnd;
      return true;
    }
    const key = normalizeLabel(def.label);
    if (!Object.hasOwn(this.links, key)) {
      this.links[key] = { href: def.href, title: def.title };
      this.defs.push({ raw: defRaw });
    }
    // A registered definition is a token of its own (renders as
    // nothing); pushing it keeps the next definition from merging into a
    // paragraph.
    this.blocks.push({ type: 'def', raw: defRaw });
    this.mark(this.i + Math.max(1, consumed));
    this.i = this.i + Math.max(1, consumed);
    return true;
  }

  tryTable() {
    if (!beginsTable(this.lines, this.i)) return false;
    const tb = this.readTable(this.i);
    this.blocks.push(tb.block);
    this.mark(tb.next);
    this.i = tb.next;
    return true;
  }

  trySetextHeading() {
    const { lines } = this;
    const n = this.n;
    let j = this.i;
    while (j < n && setextTextContinues(lines, j) && !setextDepth(lines[j])) j++;
    if (j > this.i && j < n && setextDepth(lines[j])) {
      const depth = setextDepth(lines[j]);
      const text = lines.slice(this.i, j).join('\n').trim();
      this.blocks.push({ type: 'heading', raw: this.rawOf(this.i, j + 1), depth, text });
      this.mark(j + 1);
      this.i = j + 1;
      return true;
    }
    return false;
  }

  // Paragraph (top level / blockquote) or text (inside list items).
  readParagraphOrText() {
    const { lines } = this;
    const n = this.n;
    if (this.ctx.top) {
      let j = this.i;
      while (j + 1 < n && paragraphContinues(lines, j + 1)) j++;
      const text = lines.slice(this.i, j + 1).join('\n');
      const prev = this.prevBlock();
      if (this.ctx.mergePara && !this.emitted && prev && prev.type === 'paragraph') {
        prev.text += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + this.rawOf(this.i, j + 1);
      } else {
        this.blocks.push({ type: 'paragraph', raw: this.rawOf(this.i, j + 1), text });
      }
      this.mark(j + 1);
      this.i = j + 1;
    } else {
      const text = lines[this.i];
      const prev = this.prevBlock();
      if (prev && prev.type === 'text' && this.i === this.lastEnd) {
        prev.text += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + this.rawOf(this.i, this.i + 1);
      } else {
        this.blocks.push({ type: 'text', raw: this.rawOf(this.i, this.i + 1), text });
      }
      this.mark(this.i + 1);
      this.i++;
    }
  }

  // Parse an HTML block starting at lines[i] (type 1-7). Returns
  // {raw, text, pre, next}. `text` is the stripTrailingBlanks()'d raw.
  readHtmlBlock(i, type) {
    const { lines, starts, src } = this;
    const n = lines.length;
    let end = i + 1; // index past the last line of the block
    const first = lines[i];
    const { rest } = stripLead3(first);
    if (type === 1) {
      const tag = /^<(script|pre|style|textarea)/i.exec(rest)[1].toLowerCase();
      const closeRe = htmlCloseRegex(tag);
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
      // Types 6 and 7: until a blank line.
      let j = i + 1;
      while (j < n && !isBlankLine(lines[j])) j++;
      end = j;
    }
    // stripTrailingBlanks() runs on the matched text. Marked's html
    // pattern ends types 1-5 with `(\n+|$)` — it swallows following
    // truly EMPTY lines (just "\n") but stops at a whitespace-only line
    // (e.g. "\t"). Types 6-7 end with `(?:(?:\n[ \t]*)+\n|$)` — they
    // swallow whitespace-only lines too. Swallowing the blank lines is
    // what makes stripTrailingBlanks() strip the block's own trailing
    // newline; a whitespace-only line after a type 1-5 block leaves
    // exactly one trailing newline.
    let rawEnd = end;
    if (type >= 6) {
      while (rawEnd < n && isBlankLine(lines[rawEnd])) rawEnd++;
    } else {
      while (rawEnd < n && lines[rawEnd] === '') rawEnd++;
    }
    const rawText = stripTrailingBlanks(this.rawOf(i, rawEnd));
    // Marked's html token raw IS the stripTrailingBlanks()'d text: the
    // block consumes only that, NOT the swallowed blank lines after it.
    // Those blanks stay and become a space token (which is what makes a
    // list loose when a blank sits between an html block and the next
    // block in an item). So `next` is the first line at or after the end
    // of the stripTrailingBlanks()'d text.
    const rawEndByte = starts[i] + rawText.length;
    let next = i + 1;
    while (next <= n && starts[next] < rawEndByte) next++;
    const pre = /^(script|pre|style)$/i.test((/^<([A-Za-z]+)/.exec(rest) || [])[1] || '');
    return { raw: rawText, text: rawText, pre, next: Math.min(next, n) };
  }

  // Parse a table starting at lines[i] (header) with lines[i+1] the
  // delimiter.
  readTable(i) {
    const { lines } = this;
    const n = lines.length;
    const headerCells = splitTableRow(lines[i]);
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
      // Marked's table pattern ends a row run on ` *\n` (spaces only): a
      // line holding just a tab is a (blank) table row, not a blank line.
      if (/^ *$/.test(line)) break;
      if (isHorizontalRule(line)) break;
      if (atxDepth(line)) break;
      if (isQuoteLine(line)) break;
      if (/^(?: {4}| {0,3}\t)[^\n]/.test(line) && line.trim() !== '') break;
      if (fenceInfo(line)) break;
      if (readListMarker(line, false)) break;
      if (htmlBlockKind(line)) break;
      rows.push(splitTableRow(line, header.length).map((text, idx) => ({ text, align: align[idx] || null })));
      j++;
    }
    return { block: { type: 'table', raw: this.rawOf(i, j), header, rows }, next: j };
  }

  // ============================================================ list & blockquote
  // Parse a list starting at `pos` in `src`. Returns {block, rawLen}
  // or null.
  readListAt(src, pos) {
    const source = src.slice(pos);
    const firstMatch = LIST_OPEN_RE.exec(source);
    if (!firstMatch) return null;
    const full = source;
    let rest = source;
    const consumed = () => full.length - rest.length;
    let markerText = firstMatch[1].trim();
    const ordered = markerText.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +markerText.slice(0, -1) : '', loose: false, items: [] };
    markerText = ordered ? `\\d{1,9}\\${markerText.slice(-1)}` : `\\${markerText}`;
    const itemRe = cachedItemLinePattern(markerText);
    let pendingLoose = false;
    while (rest) {
      let emptyItem = false;
      let itemText = '';
      const itemMatch = itemRe.exec(rest);
      if (!itemMatch || HR_WHOLE_RE.test(rest)) break;
      const itemStart = consumed();
      rest = rest.substring(itemMatch[0].length);
      const firstLine = itemMatch[2].split('\n', 1)[0];
      const markerLen = itemMatch[1].length;
      let firstContent = firstLine.replace(LEADING_WS_RE, (ws) => expandTabs(ws, markerLen));
      let nextLine = rest.split('\n', 1)[0];
      let isEmpty = !firstContent.trim();
      let contentIndent = 0;
      if (isEmpty) contentIndent = markerLen + 1;
      else {
        contentIndent = firstContent.search(NON_SPACE_RE);
        contentIndent = contentIndent > 4 ? 1 : contentIndent;
        itemText = firstContent.slice(contentIndent);
        contentIndent += markerLen;
      }
      if (isEmpty && /^[ \t]*$/.test(nextLine)) { rest = rest.substring(nextLine.length + 1); emptyItem = true; }
      if (!emptyItem) {
        // Marked memoises these break patterns with a clamp to
        // max(0, min(3, contentIndent-1)): a line indented more than
        // that does NOT break the item, it is item content.
        const clamped = Math.max(0, Math.min(3, contentIndent - 1));
        const { bullet, hr, fence, heading, html, quote } = breakSetFor(clamped);
        while (rest) {
          const curLine = rest.split('\n', 1)[0];
          nextLine = curLine;
          // Manual scan of the leading whitespace: index idx of the
          // first non-space/tab char, its column col, and whether a tab
          // occurs. This replaces the tab-expansion + 6 break-pattern
          // tests for the common no-tab case.
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
            // Rare: leading form-feed/vertical-tab breaks the
            // tab-expansion model; fall back to the regex-based
            // computation.
            expanded = nextLine.replace(LEADING_WS_RE, (ws) => expandTabs(ws));
            colForCompare = expanded.search(NON_SPACE_RE);
            blankLine = !nextLine.trim();
          } else {
            blankLine = idx === nextLine.length;
            expanded = hasTab ? nextLine.replace(LEADING_WS_RE, (ws) => expandTabs(ws)) : nextLine;
            colForCompare = col;
          }
          // The break patterns are ^ {0,clamped}(marker): they can only
          // match when there is no leading tab, the leading-space count
          // is <= clamped, and the first char can start a block.
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
            if (isEmpty || firstContent.replace(/\t/g, '    ').search(NON_SPACE_RE) >= 4 ||
                fence.test(firstContent) || heading.test(firstContent) || html.test(firstContent) || hr.test(firstContent)) break;
            const setextLine = SETEXT_LINE_RE.test(nextLine) && canBeSetextText(firstContent)
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
        else if (DOUBLE_BLANK_RE.test(itemRaw)) pendingLoose = true;
      }
      list.items.push({ type: 'list_item', raw: itemRaw, task: TASK_ITEM_RE.test(itemText), loose: false, text: itemText, tokens: [] });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return null;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = full.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      const itemCtx = { links: this.links, defs: this.defs, top: false, mergePara: false, hadBlankBetween: false };
      item.tokens = new BlockParser(item.text, itemCtx).parse();
      if (!list.loose && itemCtx.hadBlankBetween) list.loose = true;
    }
    for (const item of list.items) {
      const firstToken = item.tokens[0];
      if (item.task && (firstToken?.type === 'text' || firstToken?.type === 'paragraph')) {
        item.text = item.text.replace(TASK_PREFIX_RE, '');
        firstToken.raw = firstToken.raw.replace(TASK_PREFIX_RE, '');
        firstToken.text = firstToken.text.replace(TASK_PREFIX_RE, '');
        const checkbox = TASK_CHECKBOX_RE.exec(item.raw);
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
    // The nested blockTokens calls set the shared state.top back to true.
    this.ctx.top = true;
    return { block: list, rawLen: list.raw.length };
  }

  // Parse a blockquote starting at `pos` in `src`. Returns {block,
  // rawLen} or null.
  readBlockquoteAt(src, pos) {
    const source = src.slice(pos);
    if (!QUOTE_START_RE.test(source)) return null;
    const { lines } = splitLines(source);
    const nLines = lines.length;
    // Collect the blockquote run: a `>` line + its lazy continuations.
    let j = 0;
    while (j < nLines) {
      if (!isQuoteLine(lines[j])) break;
      const content = lines[j].replace(/^ {0,3}>[ \t]?/, '');
      j++;
      if (content !== '') {
        while (j < nLines) {
          const next = lines[j];
          if (isBlankLine(next)) break;
          if (isQuoteLine(next)) break;
          if (isLazyLine(next)) j++; else break;
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
        if (QUOTE_START_RE.test(remaining[lineIdx])) { groupLines.push(remaining[lineIdx]); sawMarker = true; }
        else if (!sawMarker) groupLines.push(remaining[lineIdx]);
        else break;
      }
      remaining = remaining.slice(lineIdx);
      const groupText = groupLines.join('\n');
      const stripped = groupText
        .replace(QUOTE_MARKER_WS_RE, (whole, marker, spaces) => marker + expandTabs(spaces, marker.length))
        .replace(QUOTE_SETEXT_RE, '\n    $1')
        .replace(QUOTE_STRIP_RE, '');
      rawAccum = rawAccum ? rawAccum + '\n' + groupText : groupText;
      textAccum = textAccum ? textAccum + '\n' + stripped : stripped;
      const innerCtx = { links: this.links, defs: this.defs, top: true, mergePara: true };
      new BlockParser(stripped, innerCtx, tokens).parse();
      if (remaining.length === 0) break;
      const lastToken = tokens.at(-1);
      if (!lastToken) break;
      if (lastToken.type === 'code' || lastToken.type === 'heading' || lastToken.type === 'hr' ||
          lastToken.type === 'html' || lastToken.type === 'table') break;
      if (lastToken.type === 'blockquote') {
        const nested = lastToken;
        const restText = remaining.join('\n');
        const reparsedSrc = nested.raw + '\n' + restText.replace(QUOTE_STRIP_RE, '');
        const reparsed = this.readBlockquoteAt(reparsedSrc, 0);
        if (!reparsed) break;
        tokens[tokens.length - 1] = reparsed.block;
        const leftover = reparsedSrc.substring(reparsed.rawLen).replace(/^\n/, '');
        const leftoverLines = leftover ? leftover.split('\n').length : 0;
        const consumedGroup = leftoverLines ? remaining.slice(0, -leftoverLines) : remaining;
        if (consumedGroup.length > 0) rawAccum = rawAccum + '\n' + consumedGroup.join('\n');
        textAccum = textAccum.substring(0, textAccum.length - nested.text.length) + reparsed.block.text;
        remaining = remaining.slice(consumedGroup.length);
        if (remaining.length > 0 && QUOTE_START_RE.test(remaining[0])) continue;
        break;
      } else if (lastToken.type === 'list') {
        const nestedList = lastToken;
        const reparsedSrc = nestedList.raw + '\n' + remaining.join('\n');
        const reparsed = this.readListAt(reparsedSrc, 0);
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
      // paragraph/text/def: continue with the next group
    }
    // NB: marked's blockquote SAVES state.top before the inner
    // blockTokens and RESTORES it after (unlike a list, which leaves it
    // true), so the enclosing ctx.top is unchanged here.
    return { block: { type: 'blockquote', raw: rawAccum, text: textAccum, tokens }, rawLen: rawAccum.length };
  }
}

// ================================================================ list & blockquote patterns

const HTML_BLOCK_TAGS_SRC = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const LIST_OPEN_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const HR_WHOLE_RE = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const DOUBLE_BLANK_RE = /\n[ \t]*\n[ \t]*$/;
const TASK_ITEM_RE = /^\[[ xX]\][ \t]+\S/;
const TASK_PREFIX_RE = /^\[[ xX]\][ \t]+/;
const TASK_CHECKBOX_RE = /\[[ xX]\]/;
const SETEXT_LINE_RE = /^ {0,3}(?:=+|-+) *$/;
const NON_SPACE_RE = /[^ ]/;
const LEADING_WS_RE = /^[ \t]+/;
const QUOTE_START_RE = /^ {0,3}>/;
const QUOTE_MARKER_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const QUOTE_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const QUOTE_STRIP_RE = /^ {0,3}>[ \t]?/gm;

function itemLinePattern(marker) {
  return new RegExp(`^( {0,3}${marker})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
}
function nextMarkerPattern(indent) {
  return new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
}
function hrPatternFor(indent) {
  return new RegExp(`^ {0,${indent}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
}
function fencePatternFor(indent) {
  return new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`);
}
function headingPatternFor(indent) {
  return new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`);
}
function htmlPatternFor(indent) {
  return new RegExp(`^ {0,${indent}}(?:</?(?:${HTML_BLOCK_TAGS_SRC})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
}
function quotePatternFor(indent) {
  return new RegExp(`^ {0,${indent}}>`);
}

// Break patterns depend only on the clamped indent (0..3); cache them
// instead of rebuilding (with `new RegExp`) for every list item.
const BREAK_SET_CACHE = new Map();
function breakSetFor(clamped) {
  let hit = BREAK_SET_CACHE.get(clamped);
  if (!hit) {
    hit = {
      bullet: nextMarkerPattern(clamped),
      hr: hrPatternFor(clamped),
      fence: fencePatternFor(clamped),
      heading: headingPatternFor(clamped),
      html: htmlPatternFor(clamped),
      quote: quotePatternFor(clamped),
    };
    BREAK_SET_CACHE.set(clamped, hit);
  }
  return hit;
}
const ITEM_LINE_CACHE = new Map();
function cachedItemLinePattern(marker) {
  let hit = ITEM_LINE_CACHE.get(marker);
  if (!hit) { hit = itemLinePattern(marker); ITEM_LINE_CACHE.set(marker, hit); }
  return hit;
}

// Can `line` (a single line) be the text of a setext heading?
function canBeSetextText(line) {
  if (!line.trim()) return false;
  if (/^ {0,3}(?:[*+-]|\d{1,9}[.)]) /.test(line)) return false;
  if (/^(?: {4}| {0,3}\t)/.test(line)) return false;
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return false;
  if (/^ {0,3}>/.test(line)) return false;
  if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) return false;
  if (/^ {0,3}<[^\n>]+>$/.test(line)) return false;
  return true;
}

// Is `line` a lazy paragraph continuation inside a blockquote?
function isLazyLine(line) {
  if (isBlankLine(line)) return false;
  if (isHorizontalRule(line)) return false;
  if (atxDepth(line)) return false;
  if (isQuoteLine(line)) return false;
  if (fenceInfo(line)) return false;
  if (readListMarker(line, true)) return false;
  if (htmlBlockKind(line)) return false;
  return true;
}

// ================================================================ 6. renderer
// `engine` is the document's InlineEngine: marked's lexer keeps ONE
// inline state for the whole document, resetting only `inRawBlock`
// before each block's inline tokens. Call `renderBlockInline` for a
// block's own text.

function renderBlockInline(engine, text) {
  engine.st.inRawBlock = false;
  return engine.render(text, false);
}

function renderBlocks(blocks, engine) {
  let out = '';
  for (const block of blocks) out += renderBlock(block, engine);
  return out;
}

function renderBlock(block, engine) {
  switch (block.type) {
    case 'space':
      return '';
    case 'code': {
      const firstWord = (block.lang || '').match(/^\S*/)?.[0] || '';
      const body = block.text ? block.text.replace(/\n$/, '') + '\n' : '';
      const inner = escapeHtml(body, true);
      return firstWord
        ? `<pre><code class="language-${escapeHtml(firstWord)}">${inner}</code></pre>\n`
        : `<pre><code>${inner}</code></pre>\n`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(block.tokens, engine)}</blockquote>\n`;
    case 'html':
      return block.text;
    case 'def':
      return '';
    case 'heading':
      return `<h${block.depth}>${renderBlockInline(engine, block.text)}</h${block.depth}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'list': {
      let itemsHtml = '';
      for (const item of block.items) itemsHtml += renderItem(item, engine);
      const tag = block.ordered ? 'ol' : 'ul';
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
      return `<${tag}${start}>\n${itemsHtml}</${tag}>\n`;
    }
    case 'table': {
      let headerHtml = '';
      for (const cell of block.header) headerHtml += renderCell(cell, true, engine);
      const headRow = `<tr>\n${headerHtml}</tr>\n`;
      let bodyHtml = '';
      for (const row of block.rows) {
        let rowHtml = '';
        for (const cell of row) rowHtml += renderCell(cell, false, engine);
        bodyHtml += `<tr>\n${rowHtml}</tr>\n`;
      }
      if (bodyHtml) bodyHtml = `<tbody>${bodyHtml}</tbody>`;
      return `<table>\n<thead>\n${headRow}</thead>\n${bodyHtml}</table>\n`;
    }
    case 'paragraph':
      return `<p>${renderBlockInline(engine, block.text)}</p>\n`;
    case 'text':
      return renderBlockInline(engine, block.text);
    case 'checkbox':
      return `<input ${block.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    default:
      return '';
  }
}

function renderItem(item, engine) {
  let inner = renderBlocks(item.tokens, engine);
  if (item.hasCheckbox) {
    const box = `<input ${item.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    if (item.loose && inner.startsWith('<p>')) inner = '<p>' + box + inner.slice(3);
    else inner = box + inner;
  }
  return `<li>${inner}</li>\n`;
}

function renderCell(cell, isHeader, engine) {
  const tag = isHeader ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderBlockInline(engine, cell.text)}</${tag}>\n`;
}

// ================================================================ 7. entry point
// Fast path with a per-block fallback to marked (passed in as
// `markedParse`). `src` is normalised (\r -> \n) first, like marked's
// lex(). Short inputs go straight to marked: the fast path only pays
// off on longer documents.
function fastRender(src, markedParse) {
  const norm = src.replace(/\r\n?/g, '\n');
  if (norm.length < 2000) return markedParse(norm);
  const ctx = { links: {}, defs: [], top: true, mergePara: false };
  const blocks = new BlockParser(norm, ctx).parse();
  const defsText = ctx.defs.map((d) => d.raw).join('');
  const engine = new InlineEngine(ctx.links);
  let out = '';
  for (const block of blocks) {
    try {
      out += renderBlock(block, engine);
    } catch (e) {
      out += markedParse(defsText + '\n' + block.raw);
    }
  }
  return out;
}

// Backwards-compatible wrappers around the classes above.
function parseBlockList(src, ctx, blocks) {
  return new BlockParser(src, ctx, blocks).parse();
}
function renderInline(src, links, st, textMode = false) {
  return new InlineEngine(links, st).render(src, textMode);
}
function readList(src, pos, ctx) {
  return new BlockParser(src, ctx).readListAt(src, pos);
}
function readBlockquote(src, pos, ctx) {
  return new BlockParser(src, ctx).readBlockquoteAt(src, pos);
}

export { fastRender, parseBlockList, renderInline, readList, readBlockquote };
