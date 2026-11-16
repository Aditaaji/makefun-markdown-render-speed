// fast.js — a fast, byte-identical reimplementation of marked 18.1.3
// (GFM defaults) for the make.fun "markdown-render-speed-02" competition.
//
// Design: an own, hand-written parser for the constructs that dominate
// real documents, with a per-top-level-block fallback to the vendored
// marked (./vendor/marked/marked.esm.js) for anything outside the
// envelope. The fallback keeps the 720/720 gate safe while the fast path
// carries the speed.
//
// Behaviour is modelled on marked 18.1.3 with the default options
// (gfm: true, breaks: false, pedantic: false, async: false). Where a
// rule is subtle, the implementation follows marked's tokenizer code
// (MIT, Copyright (c) 2011-2014, Christopher Jeffrey; see
// vendor/marked/NOTICE). This file is an original implementation written
// for this competition, not a copy of marked's source.
//
// Public entry: fastRender(src, markedParse) -> HTML string. For inputs
// below the fast-path size threshold it hands the input straight to
// marked, since the fast path only pays off on longer documents.

// ================================================================ text utilities

// Escape for HTML text. encode=true escapes & < > " ' ; encode=false
// (noEncode) keeps & when it starts a valid entity / numeric reference.
const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_TEST_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESCAPE_REPLACE = /[&<>"']/g;
const ESCAPE_REPLACE_NO_ENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text, encode) {
  if (encode) {
    if (ESCAPE_TEST.test(text)) return text.replace(ESCAPE_REPLACE, (ch) => ESCAPE_MAP[ch]);
  } else if (ESCAPE_TEST_NO_ENCODE.test(text)) {
    return text.replace(ESCAPE_REPLACE_NO_ENCODE, (ch) => ESCAPE_MAP[ch]);
  }
  return text;
}

// Decode numeric character references only (marked does NOT decode named
// entities). &#0;, surrogates and >0x10FFFF become U+FFFD; &#38; becomes
// "&amp;" (decoded then re-escaped by the caller); &#60; -> "&lt;" etc.
const NUMERIC_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUMERIC_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!NUMERIC_REF.test(text)) return text;
  return text.replace(NUMERIC_REF_OR_AMP, (match, decimal, hex) => {
    if (decimal === undefined && hex === undefined) return '&amp;';
    const code = decimal === undefined ? parseInt(hex, 16) : parseInt(decimal, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// cleanUrl: encodeURI, then un-escape %25 back to %. Throws on lone
// surrogates (encodeURI throws) -> the link is dropped entirely.
const PERCENT_25 = /%25/g;

function cleanUrl(href) {
  try {
    return encodeURI(href).replace(PERCENT_25, '%');
  } catch {
    return null;
  }
}

// stripTrailingBlanks: strip trailing blank lines beyond the first one.
const BLANK_LINE_RE = /^[ \t]*$/;

function stripTrailingBlanks(text) {
  const parts = text.split('\n');
  let last = parts.length - 1;
  for (; last >= 0 && BLANK_LINE_RE.test(parts[last]);) last--;
  return parts.length - last <= 2 ? text : parts.slice(0, last + 1).join('\n');
}

// Normalise a link reference label: trim, collapse whitespace, lowercase
// then uppercase then lowercase (Unicode case folding approximation).
const WHITESPACE_RUN = /\s+/g;

function normalizeLabel(label) {
  return label.trim().replace(WHITESPACE_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Split a table row into cells. Escaped pipes (\|) stay literal; cells
// are trimmed; empty edge cells are dropped; extra cells are cut /
// missing cells are padded to `count` when given.
const PIPE_RE = /\|/g;
const PIPE_SPLIT_RE = / \|/;
const ESCAPED_PIPE_RE = /\\\|/g;

function splitTableRow(row, count) {
  const markedPipes = row.replace(PIPE_RE, (ch, offset, whole) => {
    let escaped = false, pos = offset;
    for (; --pos >= 0 && whole[pos] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = markedPipes.split(PIPE_SPLIT_RE);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(ESCAPED_PIPE_RE, '|');
  return cells;
}

// parenBalance: balanced-paren check on a string (backslashes skip the
// next char). -1 = no parens or balanced; -2 = unmatched opening paren
// left over; >=0 = index of an unmatched closing paren.
function parenBalance(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// stripTrailingChars: strip trailing occurrences of `ch` (default: strip
// trailing backslashes). With `invert`, strip trailing chars that are
// NOT `ch` instead.
function stripTrailingChars(str, ch, invert) {
  const len = str.length;
  if (len === 0) return '';
  let cut = 0;
  for (; cut < len;) {
    const last = str.charAt(len - cut - 1);
    if (last === ch && !invert) cut++;
    else if (last !== ch && invert) cut++;
    else break;
  }
  return str.slice(0, len - cut);
}

// expandTabs: expand tabs in `str` to spaces, starting at column `start`.
function expandTabs(str, start = 0) {
  let col = start, out = '';
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

// dedentFence: dedent fenced-code content by the opening fence's indent.
const FENCE_INDENT_RE = /^(\s+)(?:```)/;
const LEADING_SPACE_RE = /^[\s]+/;

function dedentFence(fenceLine, content) {
  const match = fenceLine.match(FENCE_INDENT_RE);
  if (match === null) return content;
  const indent = match[1];
  return content.split('\n').map((line) => {
    const leading = line.match(LEADING_SPACE_RE);
    if (leading === null) return line;
    const [spaces] = leading;
    return line.slice(Math.min(spaces.length, indent.length));
  }).join('\n');
}

// Column of the first non-space char in a line (tab-aware from column 0).
function indentColumns(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else return col;
  }
  return col;
}

// Strip up to `cols` columns from the start of a line (tab-aware).
function stripColumns(line, cols) {
  let col = 0, i = 0;
  while (i < line.length && col < cols) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const width = 4 - (col % 4);
      if (col + width > cols) return ' '.repeat(col + width - cols) + line.slice(i + 1);
      col += width; i++;
    } else break;
  }
  return line.slice(i);
}

// ================================================================ character classes

// Is the character a Unicode punctuation/symbol (for flanking rules)?
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;
function isPunctChar(ch) {
  return ch !== '' && PUNCT_OR_SYMBOL.test(ch);
}
// GFM "punct" for emphasis: punctuation/symbol except '~'.
function isGfmPunct(ch) {
  return ch !== '' && ch !== '~' && PUNCT_OR_SYMBOL.test(ch);
}
// GFM "notPunctSpace": not whitespace, not punct/symbol — or '~'.
function isGfmNonPunctNonSpace(ch) {
  return ch !== '' && (ch === '~' || (!/\s/.test(ch) && !PUNCT_OR_SYMBOL.test(ch)));
}
// "punctSpace" for emphasis: whitespace or punct/symbol, except '~'.
function isGfmPunctOrSpace(ch) {
  return ch !== '' && ch !== '~' && (/\s/.test(ch) || PUNCT_OR_SYMBOL.test(ch));
}
// Non-GFM "notPunctSpace" / "punctSpace" (marked's X / j): '~' counts as
// punctuation here. Used by the '_' closer (closerGroup) and the '~'
// closer, which both use the non-GFM replacements — only '*' uses the
// GFM ones above.
function isPlainNonPunctNonSpace(ch) {
  return ch !== '' && !/\s/.test(ch) && !PUNCT_OR_SYMBOL.test(ch);
}
function isPlainPunctOrSpace(ch) {
  return ch !== '' && (/\s/.test(ch) || PUNCT_OR_SYMBOL.test(ch));
}
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
function isAlphanumeric(ch) {
  return ch !== '' && UNICODE_ALNUM.test(ch);
}
// The `punctuation` check used by the emStrong/del openers: whitespace or
// punct/symbol, but not '*' or '_'.
function isOpenerPunct(ch) {
  return ch !== '' && ch !== '*' && ch !== '_' && (/\s/.test(ch) || PUNCT_OR_SYMBOL.test(ch));
}

// ================================================================ inline patterns

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
// Escape tokenizer: backslash + ASCII punctuation.
const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const AUTOLINK_RE = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const TAG_RE = /^<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_TAG = /^<\/(pre|code|kbd|script)(\s|>)/i;
// GFM extended URL: mailto:/xmpp: | scheme://... | www.... | email
const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTO_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/;
const URL_RE = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
const ANY_PUNCT_OUTSIDE_CODE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const BLOCK_SKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const REFLINK_SEARCH_RE = /!?\[(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?\]\[(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}\]|!?\[(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}\](?:\[\])?(?!\()/g;
const LINK_INLINE_RE = /^!?\[.*\]\(/s;

// Resolve escapes in a href/title: backslash + punctuation -> the punctuation.
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
function unescapePunct(str) {
  return str.replace(ANY_PUNCT_RE, '$1');
}

// Find the ']' matching the '[' at src[j], allowing one level of nested
// [..] groups inside (marked's `re`: a nested group is
// `\[(?:brackets|...)*?\]` where `brackets` is a [...] with no '[' inside).
// Returns the index of the matching ']', or -1.
function findMatchingBracket(src, j) {
  const n = src.length;
  let k = j + 1;
  while (k < n) {
    const ch = src[k];
    if (ch === '\\') { k += 2; continue; }
    if (ch === '[') {
      // a Le group: '[' then chars with no '[' until ']'
      let m = k + 1, ok = false;
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
// one level deep (marked's label regex only allows a single nested [...]
// group).
function readLabel(src, i) {
  let j = i + 1;
  const n = src.length;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') {
      // A code span in a label: marked's `re` allows the closing backtick
      // run to be ANY length (`` `+(?!`)[^`]*?`+(?!`) ``), not necessarily
      // equal to the opener — e.g. `` ``url` `` is one code span. But the
      // `re` also has the `` ``+(?=\]) `` alternative — a run of TWO or
      // more backticks immediately before ']' — and its lazy matching
      // prefers the shorter label, so check that FIRST (only for runs of
      // length >= 2): a run followed by ']' ends the label here rather
      // than spanning to a far-away backtick. A SINGLE backtick before ']'
      // does NOT match that alternative (it needs `` ``+ ``), so it must
      // be a code span (find a closing run) or the label fails.
      let k = j;
      while (k < n && src[k] === '`') k++;
      if (k - j >= 2 && src[k] === ']') { j = k; continue; }
      let m = k, found = -1;
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

// Does the label text contain a tag that starts inside it and runs past
// its end (marked's Be check)? `labelStart` is the index of the label's
// first char in `src`; `labelLen` is the label's length.
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

// Is there a link (inline or reference) inside `text`? Used by the masking
// step and by the reflink tokenizer's own check.
function containsLink(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCK_SKIP_RE)) {
    if (LINK_INLINE_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH_RE)) {
    const str = m[0], lastBracket = str.lastIndexOf('[');
    if (!(str.charAt(0) === '!' || !Object.hasOwn(links, normalizeLabel(str.slice(lastBracket + 1, -1)))) && !(lastBracket > 1 && containsLink(str.slice(1, lastBracket - 1), links))) return true;
  }
  return false;
}

// Mask a container string for the emphasis/delimiter closer search: hide
// delimiter runs that sit inside links, code spans, HTML tags, defined
// reference labels and escaped punctuation. The mask keeps the length, so
// positions in the masked string line up with the real string.
function maskDelimiters(src, links) {
  let masked = src;
  if (links && src.includes('[')) {
    const repl = (match) => {
      const lastBracket = match.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match.slice(lastBracket + 1, -1)))) return match;
      if (lastBracket > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, lastBracket - 1);
        if (containsLink(inner, links)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, repl) + '][' + 'a'.repeat(match.length - lastBracket - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    masked = masked.replace(REFLINK_SEARCH_RE, repl);
  }
  // The two masking passes only change anything when the text contains a
  // backtick/backslash (punct masking) or a bracket/backtick/angle-bracket
  // (block skip); skip the expensive regex scans otherwise.
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(ANY_PUNCT_OUTSIDE_CODE, (whole, span, escaped) => {
      if (escaped) return '+'.repeat(whole.length);
      if (span) return span + whole.slice(span.length, -span.length).replace(/`/g, '+') + span;
      return whole;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(BLOCK_SKIP_RE, (whole, before, codeRun) => {
      const prefixLen = codeRun ? codeRun.length : 0;
      return whole.slice(0, prefixLen) + '[' + 'a'.repeat(whole.length - prefixLen - 2) + ']';
    });
  }
  return masked;
}

// The code point ending just before index `idx`, and starting at `idx`
// (surrogate-pair aware — the RDelim regexes run with the `u` flag).
function prevCodePoint(str, idx) {
  if (idx <= 0) return '';
  const low = str.charCodeAt(idx - 1);
  if (low >= 0xDC00 && low <= 0xDFFF && idx >= 2) {
    const high = str.charCodeAt(idx - 2);
    if (high >= 0xD800 && high <= 0xDBFF) return str.slice(idx - 2, idx);
  }
  return str[idx - 1];
}
function codePointAt(str, idx) {
  if (idx >= str.length) return '';
  const high = str.charCodeAt(idx);
  if (high >= 0xD800 && high <= 0xDBFF && idx + 1 < str.length) {
    const low = str.charCodeAt(idx + 1);
    if (low >= 0xDC00 && low <= 0xDFFF) return str.slice(idx, idx + 2);
  }
  return str[idx];
}

// Classify a delimiter run for the closer search (marked's RDelim groups).
// `ch` is '*' or '_' or '~'; `prev` is the char before the run ('' at the
// start), `next` is the char after the run ('' at the end). Returns 0 (not
// a closer at all), 1/2 (plain closer), 3/4 (cannot close — absorbs into
// the opener count), 5/6 (conditional closer — rule of 3s / previous-char
// check).
function closerGroup(ch, prev, next) {
  if (ch === '~') {
    // Rt uses X/j/$ (non-GFM): '~' IS punct/punctSpace, NOT notPunctSpace.
    if (isPunctChar(prev) && (next === '' || /\s/.test(next))) return 1;
    if (isPlainNonPunctNonSpace(prev) && (next === '' || isPlainPunctOrSpace(next))) return 2;
    if (isPlainPunctOrSpace(prev) && isPlainNonPunctNonSpace(next)) return 3;
    if (prev !== '' && /\s/.test(prev) && isPunctChar(next)) return 4;
    if (isPunctChar(prev) && isPunctChar(next)) return 5;
    if (isPlainNonPunctNonSpace(prev) && isPlainNonPunctNonSpace(next)) return 6;
    return 0;
  }
  if (ch === '_') {
    // kt uses X/j/$ (non-GFM): '~' IS punct/punctSpace, NOT notPunctSpace.
    // Note: no group 6 for '_' (intraword '_' cannot close).
    if (isPunctChar(prev) && (next === '' || /\s/.test(next))) return 1;
    if (isPlainNonPunctNonSpace(prev) && (next === '' || isPlainPunctOrSpace(next))) return 2;
    if (isPlainPunctOrSpace(prev) && isPlainNonPunctNonSpace(next)) return 3;
    if (prev !== '' && /\s/.test(prev) && isPunctChar(next)) return 4;
    if (isPunctChar(prev) && isPunctChar(next)) return 5;
    return 0;
  }
  // '*' — ht uses it/st/ye (GFM): '~' is NOT punct/punctSpace, IS notPunctSpace.
  if (isGfmPunct(prev) && (next === '' || /\s/.test(next))) return 1;
  if (isGfmNonPunctNonSpace(prev) && (next === '' || isGfmPunctOrSpace(next))) return 2;
  if (isGfmPunctOrSpace(prev) && isGfmNonPunctNonSpace(next)) return 3;
  if (prev !== '' && /\s/.test(prev) && isGfmPunct(next)) return 4;
  if (isGfmPunct(prev) && isGfmPunct(next)) return 5;
  if (isGfmNonPunctNonSpace(prev) && isGfmNonPunctNonSpace(next)) return 6;
  return 0;
}

// The "skip" alternative of the RDelim regexes: when scanning for a closer
// for `ch`, a span `__...*...__` (for '*') or `**..._...**` (for '_') is
// skipped wholesale. Returns the index to resume scanning at, or -1.
function skipEmphasisSpan(masked, from, ch) {
  const open = ch === '*' ? '__' : '**';
  const inner = ch === '*' ? '*' : '_';
  const n = masked.length;
  // first `open` must be the first delimiter in the text (no * or _ before it)
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

// Try emphasis/strong at src[i] (src[i] is '*' or '_'). `masked` is the
// masked container string, `prevChar` the previous token's last char.
// Returns {html, end} (end = index just past the em/strong) or null.
function tryEmphasis(src, masked, i, prevChar, links, st, textMode) {
  const ch = src[i];
  // LDelim: a run of ch, then a punct char (group 1/3) or a non-space char.
  let j = i;
  while (j < src.length && src[j] === ch) j++;
  const runHere = j - i; // opener run length (within this token)
  if (j >= src.length) return null;
  const after = src[j];
  if (after === ' ' || after === '\t' || after === '\n') return null;
  const followedByPunct = isGfmPunct(after);
  // The run may extend before i (a previous token ended with the same char).
  let runStart = i;
  while (runStart > 0 && masked[runStart - 1] === ch) runStart--;
  const charBeforeRun = runStart > 0 ? [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '' : '';
  const beforeIsPunctOrDelim = charBeforeRun === '*' || charBeforeRun === '_' || isOpenerPunct(charBeforeRun);
  const charBeforeToken = runStart < i ? charBeforeRun : prevChar;
  const beforeIsOpenerPunct = runStart < i ? beforeIsPunctOrDelim : isOpenerPunct(charBeforeToken);
  if (ch === '_' && !followedByPunct && isAlphanumeric(charBeforeToken)) return null; // intraword _
  const punctAfter = followedByPunct ? after : '';
  if (punctAfter && charBeforeToken !== '' && !beforeIsOpenerPunct) return null; // cannot open (not left-flanking)
  const fullRun = i - runStart + runHere; // full run length
  const ruleOfThreesApplies = charBeforeRun.trim() !== '' && (punctAfter !== '' || (ch === '*' && !beforeIsPunctOrDelim));
  const prevIsSameDelim = prevChar === ch;
  // Scan for a closer in the masked string, starting after the opener.
  const scanFrom = i + runHere;
  let pos = scanFrom;
  const skipTo = skipEmphasisSpan(masked, scanFrom, ch);
  if (skipTo >= 0) pos = skipTo;
  let remaining = runHere, absorbed = 0;
  while (pos < masked.length) {
    // find the next run of ch
    let q = pos;
    while (q < masked.length && masked[q] !== ch) q++;
    if (q >= masked.length) break;
    let r = q;
    while (r < masked.length && masked[r] === ch) r++;
    const closerLen = r - q;
    const prev = prevCodePoint(masked, q);
    const next = codePointAt(masked, r);
    const group = closerGroup(ch, prev, next);
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
        ? renderInline(inner, links, st, textMode)
        : '<em>' + renderInline(inner, links, st, textMode) + '</em>';
      return { html, end: rawEnd };
    }
    const inner = raw.slice(2, -2);
    const html = textMode
      ? renderInline(inner, links, st, textMode)
      : '<strong>' + renderInline(inner, links, st, textMode) + '</strong>';
    return { html, end: rawEnd };
  }
  return null;
}

// Try strikethrough at src[i] (src[i] is '~'). Returns {html, end} or null.
function tryStrikethrough(src, masked, i, prevChar, links, st, textMode) {
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
    const prev = prevCodePoint(masked, q);
    const next = codePointAt(masked, r);
    const group = closerGroup('~', prev, next);
    if (group === 0) { pos = r; continue; }
    if (group === 3 || group === 4) { remaining += closerLen; pos = r; continue; }
    remaining -= closerLen;
    if (remaining > 0) { pos = r; continue; }
    const use = Math.min(closerLen, closerLen + remaining);
    const rawEnd = q + use;
    const raw = src.slice(i, rawEnd);
    const inner = raw.slice(openerLen, -openerLen);
    const html = textMode
      ? renderInline(inner, links, st, textMode)
      : '<del>' + renderInline(inner, links, st, textMode) + '</del>';
    return { html, end: rawEnd };
  }
  return null;
}

// ================================================================ link parsing

// Clean implementation of the inline link scanner (kept separate so the
// truncation bookkeeping stays exact).
function readInlineLink(src, i) {
  const isImage = src[i] === '!';
  const labelStart = isImage ? i + 1 : i;
  const lab = readLabel(src, labelStart);
  if (!lab) return null;
  if (labelTagOverruns(src, labelStart + 1, lab.label.length)) return null;
  let j = lab.end;
  if (src[j] !== '(') return null;
  j++;
  while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n')) j++;
  let href = null, angle = false, destStart = j, destEnd = j;
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
      // truncate the href at the unmatched ')'; the title is dropped and
      // the raw match ends right after that ')'.
      href = href.substring(0, unbalanced);
      rawEnd = destStart + unbalanced + 1;
      title = '';
    }
  }
  if (rawEnd < 0) {
    // optional title
    let k = j;
    // separator: spaces/tabs (+ optional newline) or a newline
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
      const found = readLinkTitle(src, k);
      if (found) { title = found.title; k = found.end; }
    }
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n')) k++;
    if (src[k] !== ')') return null;
    // the closing ')' must not be escaped
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

// Scan a link title at src[i]: "..." | '...' | (...). Returns {title, end}.
function readLinkTitle(src, i) {
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

// Scan a reference link at src[i]: [label][ref] | [label][] | [ref] | [ref][].
// Returns {isImage, label, ref, end} or null. `ref` is '' for the collapsed
// form (meaning "use the label").
function readReferenceLink(src, i) {
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
  // nolink: [ref] or [ref][]
  if (lab.label.length === 0) return null;
  if (/^\s/.test(lab.label) && lab.label.trim() === '') return null;
  let end = afterLabel;
  if (src[end] === '[' && src[end + 1] === ']') end += 2;
  return { isImage, label: lab.label, ref: lab.label, end };
}

// Create a link/image from a parsed label + destination (marked's De).
// Returns {html, end} or null (when a nested link was emitted inside the
// label, the outer link is dropped). `rawEnd` is the index just past the
// whole link in the source.
function buildLink(label, href, title, isImage, rawEnd, links, st, textMode) {
  const labelText = label.replace(/\\([\[\]])/g, '$1');
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  // An image's label is always rendered as plain text (the alt text, via
  // marked's textRenderer) — even when the image itself is in HTML mode.
  // A link's label follows the caller's mode.
  const inner = renderInline(labelText, links, st, isImage ? true : textMode);
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

// ================================================================ text chunks

const EMAIL_LOCAL = /[A-Za-z0-9._+-]/;
const EMAIL_DOMAIN = /^[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
// Find a valid GFM email starting at or after `from`; returns its start
// index, or -1. `from` is the position to start looking for '@'.
function locateEmail(src, from) {
  let at = src.indexOf('@', from);
  while (at >= 0) {
    let start = at;
    while (start > 0 && EMAIL_LOCAL.test(src[start - 1])) start--;
    if (start < at && EMAIL_DOMAIN.test(src.slice(at + 1))) return start;
    at = src.indexOf('@', at + 1);
  }
  return -1;
}

// End of the current text chunk (marked's GFM text rule, implemented as a
// scan instead of the lazy regex). `i` is the chunk start.
// Email local-part char: [A-Za-z0-9._+-] (char-code check, faster than regex).
function isEmailLocalChar(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
    code === 46 || code === 95 || code === 43 || code === 45;
}
// Single-pass scan for the end of a text chunk (replaces ~15 indexOf scans).
// Returns the first position >= firstEnd where the chunk must end, or n.
function textRunEnd(src, i) {
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
          while (q > 0) { const d = src.charCodeAt(q - 1); if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122)) q--; else break; }
          if (q >= firstEnd) {
            const scheme = src.slice(q, p).toLowerCase();
            if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') return q;
          }
        }
        break;
      case 64: // @ — email
        {
          let start = p;
          while (start > 0 && isEmailLocalChar(src.charCodeAt(start - 1))) start--;
          if (start < p && EMAIL_DOMAIN.test(src.slice(p + 1))) return start <= i ? firstEnd : start;
        }
        break;
      case 10: // \n — hard break: 2+ spaces before it
        {
          let q = p - 1, spaces = 0;
          while (q >= firstEnd && src.charCodeAt(q) === 32) { spaces++; q--; }
          if (spaces >= 2) return q + 1;
        }
        break;
    }
  }
  return n;
}

// ================================================================ inline main loop

// Parse inline markdown into HTML (or plain text when textMode is true).
// `st` is the shared state {inLink, linkEmitted, inRawBlock}.
function renderInline(src, links, st, textMode = false) {
  const n = src.length;
  if (n === 0) return '';
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
    // 1. escape (in textMode the char is returned raw — marked's
    // TextRenderer renders an escape token via its text() method)
    if (ch === '\\' && i + 1 < n && ASCII_PUNCT.has(src[i + 1])) {
      out += textMode ? src[i + 1] : escapeHtml(src[i + 1]);
      i += 2;
      continue;
    }
    // 2. tag
    if (ch === '<') {
      const m = TAG_RE.exec(src.slice(i));
      if (m) {
        const tag = m[0];
        if (!st.inLink && START_A_TAG.test(tag)) st.inLink = true;
        else if (st.inLink && END_A_TAG.test(tag)) st.inLink = false;
        if (!st.inRawBlock && START_PRE_TAG.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && END_PRE_TAG.test(tag)) st.inRawBlock = false;
        out += tag;
        i += tag.length;
        continue;
      }
    }
    // 3. inline link / image
    if (parenPossible && (ch === '[' || (ch === '!' && src[i + 1] === '['))) {
      const lk = readInlineLink(src, i);
      if (lk) {
        const made = buildLink(lk.label, lk.href, lk.title, lk.isImage, lk.end, links, st, textMode);
        if (made) {
          out += made.html;
          i = made.end;
          continue;
        }
        // link dropped (nested link inside) -> fall through to text
      }
    }
    // 4. reference link / image
    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const rl = readReferenceLink(src, i);
      if (rl) {
        if (labelTagOverruns(src, (rl.isImage ? i + 1 : i) + 1, rl.label.length)) {
          // tag crossing the label -> not a link; fall through to text
        } else {
          const def = links[normalizeLabel(rl.ref || rl.label)];
          if (def) {
            const made = buildLink(rl.label, def.href, def.title, rl.isImage, rl.end, links, st, textMode);
            if (made) {
              out += made.html;
              i = made.end;
              continue;
            }
          } else {
            // unresolved: only the first char becomes text
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
    // 5. emphasis / strong
    if (ch === '*' || ch === '_') {
      const em = tryEmphasis(src, masked, i, prevLast, links, st, textMode);
      if (em) {
        out += em.html;
        i = em.end;
        continue;
      }
    }
    // 6. code span
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
    // 7. hard break (two spaces + newline, or backslash + newline)
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
    // 8. strikethrough
    if (ch === '~') {
      const d = tryStrikethrough(src, masked, i, prevLast, links, st, textMode);
      if (d) {
        out += d.html;
        i = d.end;
        continue;
      }
    }
    // 9. autolink <...>
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
    // 10. GFM extended URL / email (not inside a link)
    if (!st.inLink) {
      const m = URL_RE.exec(src.slice(i));
      if (m) {
        let text, href;
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
    // 11. text (in textMode the chunk is decoded but NOT escaped — marked's
    // TextRenderer.text returns the token text as-is; the caller escapes it
    // when placing it in an attribute)
    const end = textRunEnd(src, i);
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

// ================================================================ block parsing
// Line-based block parser. The source is split into lines (without the
// '\n'); `starts[i]` is the byte offset of line i, `starts[lines.length]`
// is the source length, so raw(a, b) = src.slice(starts[a], starts[b]).

const BLOCK_TAGS = new Set('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'.split('|'));
const RAW_BLOCK_TAGS = new Set(['pre', 'script', 'style', 'textarea']);

function splitIntoLines(src) {
  if (src === '') return { lines: [], starts: [0] };
  const lines = src.split('\n');
  const starts = [0];
  for (let i = 0; i < lines.length; i++) starts.push(starts[i] + lines[i].length + 1);
  return { lines, starts };
}

// Leading whitespace columns of a line (tab-aware), and the index of the
// first non-space char.
function measureIndent(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { col, idx: i };
}
function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}
// The line, with up to 3 leading spaces/tabs stripped (returns the rest
// and how many columns were stripped). Tabs count by column.
function stripUpToThree(line) {
  let col = 0, i = 0;
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
  const { rest } = stripUpToThree(line);
  // Do NOT trim the leading whitespace: a tab at the start is 4 columns,
  // so `\t***` is NOT an hr (marked's W allows only 0-3 spaces). HR_RUN_RE
  // already allows trailing spaces/tabs.
  return HR_RUN_RE.test(rest) && /^(?:-|\*|_)/.test(rest);
}
function atxDepth(line) {
  const { rest } = stripUpToThree(line);
  const m = /^(#{1,6})(?:\s|$)/.exec(rest);
  return m ? m[1].length : 0;
}
function fenceInfo(line) {
  const { rest } = stripUpToThree(line);
  const m = /^(`{3,}(?=[^`\n]*$)|~{3,})/.exec(rest);
  return m ? { ch: m[0][0], len: m[0].length, info: rest.slice(m[0].length) } : null;
}
function isQuoteLine(line) {
  return /^ {0,3}>/.test(line);
}
// A list marker at the start of a line (after <=3 spaces). `anyOrdered`
// allows any start number (for the lazy-line / setext checks); otherwise
// only a bullet or "1." / "1)" interrupts a paragraph.
function readListMarker(line, anyOrdered) {
  const { rest } = stripUpToThree(line);
  let m = /^([*+-])(?=[ \t]|$)/.exec(rest);
  if (m) return { marker: m[1], ordered: false, start: 0, rest: rest.slice(1) };
  m = anyOrdered
    ? /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(rest)
    : /^(1)([.)])(?=[ \t]|$)/.exec(rest);
  if (m) return { marker: m[1] + m[2], ordered: true, start: parseInt(m[1], 10), rest: rest.slice(m[0].length) };
  return null;
}
// Does the list marker on this line interrupt a paragraph? Marked's
// paragraph regex requires `[ \t]+[^ \t\n]` after the marker — an empty
// item (`*` or `1.` alone, or with only trailing whitespace) does NOT
// interrupt, so the line stays paragraph text.
function markerBreaksParagraph(line) {
  const marker = readListMarker(line, false);
  if (!marker) return false;
  return /^[ \t]+[^ \t]/.test(marker.rest);
}
// HTML block start (types 1-6 only — type 7 cannot interrupt a paragraph).
// Returns the type number or 0.
function htmlBlockKind(line) {
  const { rest } = stripUpToThree(line);
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
  const { rest } = stripUpToThree(line);
  if (!rest.startsWith('<')) return false;
  const m = TAG_RE.exec(rest);
  if (!m) return false;
  const after = rest.slice(m[0].length);
  return /^[ \t]*$/.test(after);
}
// A table delimiter line (for the header/delimiter check).
function isDelimiterRow(line) {
  const { rest } = stripUpToThree(line);
  return /^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(rest) && /[:|]/.test(rest);
}
// Does lines[i] (header) + lines[i+1] (delimiter) start a table?
function beginsTable(lines, i) {
  if (i + 1 >= lines.length) return false;
  const header = lines[i];
  if (header.trim() === '' || header.startsWith(' ') && header[0] === ' ') {
    // header must match ^ *([^\n ].*) — any leading spaces, then a non-space
    if (/^ +$/.test(header)) return false;
  }
  if (!/^\S/.test(header.replace(/^ */, ''))) return false;
  const delim = lines[i + 1];
  if (!isDelimiterRow(delim)) return false;
  const headerCells = splitTableRow(header);
  const delimCells = delim.replace(/^\||\| *$/g, '').split('|');
  return headerCells.length === delimCells.length;
}
// Paragraph continuation check (GFM paragraph regex, line-based).
function paragraphContinues(lines, i) {
  const line = lines[i];
  if (isBlankLine(line)) {
    // A trailing whitespace-only line with no '\n' after it (last line,
    // non-empty) is part of the paragraph: marked's paragraph regex
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
// Setext text continuation (lheading regex): like a paragraph, but a bullet
// of any kind stops it, and a table-delimiter-like line stops it.
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
  const { rest } = stripUpToThree(line);
  const m = /^((?:=+|-+))[ \t]*$/.exec(rest);
  return m ? (m[1][0] === '=' ? 1 : 2) : 0;
}

// Scan a link reference definition at the start of `src` (from `pos`).
// Returns {label, href, title, rawLen} or null. `rawLen` is the number of
// source characters consumed (including trailing newlines).
const DEF_RE = /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/;
function readDefinitionAt(src, pos) {
  const m = DEF_RE.exec(src.slice(pos));
  if (!m) return null;
  const dest = m[2];
  if (!dest.startsWith('<') && parenBalance(dest, '()') !== -1) return null;
  const href = dest.startsWith('<')
    ? dest.slice(1, -1).replace(ANY_PUNCT_RE, '$1')
    : dest.replace(ANY_PUNCT_RE, '$1');
  const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_RE, '$1') : null;
  return { label: m[1], href, title, rawLen: m[0].length };
}

// Fence-closing regexes, cached per (fence char, fence length) instead of
// rebuilding one for every line scanned inside a fenced code block.
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

// ================================================================ main block loop
// ctx: {links, defs, top, mergePara}
//   links: label -> {href, title} (first definition wins)
//   defs:  [{raw}] in document order (for the marked fallback)
//   top:   true at the top level / inside blockquotes, false inside list items
//   mergePara: true when parsing blockquote inner content (only the FIRST
//              paragraph of this call may merge into a previous paragraph)
// blocks: array to append to (shared across blockquote groups)

function parseBlockList(src, ctx, blocks) {
  blocks = blocks || [];
  const { lines, starts } = splitIntoLines(src);
  const rawOf = (a, b) => src.slice(starts[a], starts[b]);
  let i = 0;
  const n = lines.length;
  let emitted = false; // any block appended by this call yet
  let lastEnd = 0;     // line index just after the last emitted block
  let sawBlank = false; // a blank line was skipped after a block
  const prevBlock = () => blocks[blocks.length - 1];
  const mark = (endLine) => {
    if (sawBlank && emitted) ctx.hadBlankBetween = true;
    sawBlank = false;
    emitted = true;
    lastEnd = endLine;
  };
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { sawBlank = true; i++; continue; }
    const { rest } = stripUpToThree(line);
    // --- indented code
    if (/^(?: {4}| {0,3}\t)/.test(line) && line.trim() !== '') {
      let j = i, lastCode = i;
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
      // marked's Ze match includes the trailing blank lines after the
      // code, so stripTrailingBlanks() strips them; without them the merged
      // text keeps a trailing '\n'. Include them in rawText (i still
      // advances only past the code lines, so the blanks are seen by the
      // main loop).
      let rawEnd = lastCode + 1;
      while (rawEnd < n && isBlankLine(lines[rawEnd])) rawEnd++;
      const rawText = rawOf(i, rawEnd);
      let text = stripTrailingBlanks(rawText);
      text = text.replace(/^(?: {0,3}\t| {1,4})/gm, '');
      const prev = prevBlock();
      if (prev && (prev.type === 'paragraph' || prev.type === 'text') && i === lastEnd) {
        prev.text += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + rawText;
        lastEnd = lastCode + 1;
        i = lastCode + 1;
        continue;
      }
      blocks.push({ type: 'code', raw: rawText, text, lang: '', fenced: false });
      mark(lastCode + 1);
      i = lastCode + 1;
      continue;
    }
    // --- fenced code
    const fence = fenceInfo(line);
    if (fence && (fence.ch !== '`' || !fence.info.includes('`'))) {
      let j = i + 1, closed = -1;
      while (j < n) {
        const line2 = lines[j];
        const { rest: rest2 } = stripUpToThree(line2);
        const m = closingFenceRegex(fence.ch, fence.len).exec(rest2);
        if (m) { closed = j; break; }
        j++;
      }
      const contentEnd = closed >= 0 ? closed : n;
      let content = src.slice(starts[i + 1], starts[contentEnd]);
      // marked's fence regex group 3 excludes the final newline before the
      // closing fence (or EOF); the renderer re-adds exactly one.
      if (content.endsWith('\n')) content = content.slice(0, -1);
      content = dedentFence(rawOf(i, i + 1), content);
      const info = fence.info.trim().replace(ANY_PUNCT_RE, '$1');
      const lang = info.match(/^\S*/)?.[0] || '';
      blocks.push({ type: 'code', raw: rawOf(i, closed >= 0 ? closed + 1 : n), text: content, lang, fenced: true });
      mark(contentEnd + (closed >= 0 ? 1 : 0));
      i = contentEnd + (closed >= 0 ? 1 : 0);
      continue;
    }
    // --- ATX heading
    const atx = atxDepth(line);
    if (atx) {
      let text = rest.slice(atx);
      text = text.replace(/^[ \t]+/, '');
      const closing = /[ \t]+#+[ \t]*$/.exec(text) || /^(#+)[ \t]*$/.exec(text);
      if (closing) text = text.slice(0, text.length - closing[0].length);
      text = text.replace(/[ \t]+$/, '');
      blocks.push({ type: 'heading', raw: rawOf(i, i + 1), depth: atx, text });
      mark(i + 1);
      i++;
      continue;
    }
    // --- hr
    if (isHorizontalRule(line)) {
      blocks.push({ type: 'hr', raw: rawOf(i, i + 1) });
      mark(i + 1);
      i++;
      continue;
    }
    // --- blockquote
    if (isQuoteLine(line)) {
      const bq = readBlockquote(src, starts[i], ctx);
      if (bq) {
        blocks.push(bq.block);
        const consumed = src.slice(starts[i], starts[i] + bq.rawLen);
        let next = i + consumed.split('\n').length;
        if (consumed.endsWith('\n')) next--;
        mark(next);
        i = next;
        continue;
      }
    }
    // --- list (any ordered start can begin a list at a block boundary;
    // only `1` interrupts a paragraph, handled inside paragraphContinues)
    const marker = readListMarker(line, true);
    if (marker && (marker.rest === '' || /^[ \t]/.test(marker.rest))) {
      const lst = readList(src, starts[i], ctx);
      if (lst) {
        blocks.push(lst.block);
        const consumed = src.slice(starts[i], starts[i] + lst.rawLen);
        let next = i + consumed.split('\n').length;
        if (consumed.endsWith('\n')) next--;
        mark(next);
        i = next;
        continue;
      }
    }
    // --- html block (types 1-7)
    const htmlKind = htmlBlockKind(line) || (isHtmlTypeSeven(line) ? 7 : 0);
    if (htmlKind) {
      const hb = readHtmlBlock(lines, starts, src, i, htmlKind);
      blocks.push({ type: 'html', raw: hb.raw, text: hb.text, pre: hb.pre });
      mark(hb.next);
      i = hb.next;
      continue;
    }
    // --- link reference definition
    const def = readDefinitionAt(src, starts[i]);
    if (def) {
      const defRaw = src.slice(starts[i], starts[i] + def.rawLen);
      // lines spanned: newlines + 1, unless the raw ends with a newline
      // (then the last split element is empty and adds no line)
      const consumed = defRaw.endsWith('\n')
        ? defRaw.split('\n').length - 1
        : defRaw.split('\n').length;
      const prev = prevBlock();
      if (prev && (prev.type === 'paragraph' || prev.type === 'text') && i === lastEnd) {
        // merged into the previous paragraph/text: NOT registered as a link
        prev.text += '\n' + defRaw;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + defRaw;
        lastEnd = i + Math.max(1, consumed);
        i = lastEnd;
        continue;
      }
      const key = normalizeLabel(def.label);
      if (!Object.hasOwn(ctx.links, key)) {
        ctx.links[key] = { href: def.href, title: def.title };
        ctx.defs.push({ raw: defRaw });
      }
      // A registered definition is a token of its own (renders as nothing);
      // pushing it keeps the next definition from merging into a paragraph.
      blocks.push({ type: 'def', raw: defRaw });
      mark(i + Math.max(1, consumed));
      i = i + Math.max(1, consumed);
      continue;
    }
    // --- table
    if (beginsTable(lines, i)) {
      const tb = readTable(lines, starts, src, i);
      blocks.push(tb.block);
      mark(tb.next);
      i = tb.next;
      continue;
    }
    // --- setext heading
    {
      let j = i;
      while (j < n && setextTextContinues(lines, j) && !setextDepth(lines[j])) j++;
      if (j > i && j < n && setextDepth(lines[j])) {
        const depth = setextDepth(lines[j]);
        const text = lines.slice(i, j).join('\n').trim();
        blocks.push({ type: 'heading', raw: rawOf(i, j + 1), depth, text });
        mark(j + 1);
        i = j + 1;
        continue;
      }
    }
    // --- paragraph (top level / blockquote) or text (inside list items)
    if (ctx.top) {
      let j = i;
      while (j + 1 < n && paragraphContinues(lines, j + 1)) j++;
      const text = lines.slice(i, j + 1).join('\n');
      const prev = prevBlock();
      if (ctx.mergePara && !emitted && prev && prev.type === 'paragraph') {
        prev.text += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + rawOf(i, j + 1);
      } else {
        blocks.push({ type: 'paragraph', raw: rawOf(i, j + 1), text });
      }
      mark(j + 1);
      i = j + 1;
      continue;
    } else {
      const text = line;
      const prev = prevBlock();
      if (prev && prev.type === 'text' && i === lastEnd) {
        prev.text += '\n' + text;
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + rawOf(i, i + 1);
      } else {
        blocks.push({ type: 'text', raw: rawOf(i, i + 1), text });
      }
      mark(i + 1);
      i++;
      continue;
    }
  }
  // marked's lexer keeps ONE shared `state.top` across all blockTokens
  // calls and sets it back to true at the end of each call: after a nested
  // list/blockquote is parsed, the following blocks in the enclosing
  // context are parsed as paragraphs (top=true), not one-line text tokens.
  ctx.top = true;
  return blocks;
}

// Parse an HTML block starting at lines[i] (type 1-7). Returns
// {raw, text, pre, next}. `text` is the stripTrailingBlanks()'d raw.
function readHtmlBlock(lines, starts, src, i, type) {
  const n = lines.length;
  const rawOf = (a, b) => src.slice(starts[a], starts[b]);
  let end = i + 1; // index past the last line of the block
  const first = lines[i];
  const { rest } = stripUpToThree(first);
  if (type === 1) {
    const tag = /^<(script|pre|style|textarea)/i.exec(rest)[1].toLowerCase();
    let closeRe = REGEX_CACHE.get('html/' + tag);
    if (!closeRe) { closeRe = new RegExp('</' + tag + '>', 'i'); REGEX_CACHE.set('html/' + tag, closeRe); }
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
    // types 6 and 7: until a blank line
    let j = i + 1;
    while (j < n && !isBlankLine(lines[j])) j++;
    end = j;
  }
  // stripTrailingBlanks() runs on the matched text. Marked's html regex
  // ends types 1-5 with `(\n+|$)` — it swallows following truly EMPTY
  // lines (just "\n") but stops at a whitespace-only line (e.g. "\t").
  // Types 6-7 end with `(?:(?:\n[ \t]*)+\n|$)` — they swallow
  // whitespace-only lines too. Swallowing the blank lines is what makes
  // stripTrailingBlanks() strip the block's own trailing newline; a
  // whitespace-only line after a type 1-5 block leaves exactly one
  // trailing newline.
  let rawEnd = end;
  if (type >= 6) {
    while (rawEnd < n && isBlankLine(lines[rawEnd])) rawEnd++;
  } else {
    while (rawEnd < n && lines[rawEnd] === '') rawEnd++;
  }
  const rawText = stripTrailingBlanks(rawOf(i, rawEnd));
  // marked's html token raw IS the stripTrailingBlanks()'d text: the block
  // consumes only that, NOT the swallowed blank lines after it. Those
  // blanks stay and become a space token (which is what makes a list loose
  // when a blank sits between an html block and the next block in an
  // item). So `next` is the first line at or after the end of the
  // stripTrailingBlanks()'d text.
  const rawEndByte = starts[i] + rawText.length;
  let next = i + 1;
  while (next <= n && starts[next] < rawEndByte) next++;
  const pre = /^(script|pre|style)$/i.test((/^<([A-Za-z]+)/.exec(rest) || [])[1] || '');
  return { raw: rawText, text: rawText, pre, next: Math.min(next, n) };
}

// Parse a table starting at lines[i] (header) with lines[i+1] the delimiter.
function readTable(lines, starts, src, i) {
  const n = lines.length;
  const rawOf = (a, b) => src.slice(starts[a], starts[b]);
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
    // marked's table regex ends a row run on ` *\n` (spaces only): a line
    // holding just a tab is a (blank) table row, not a blank line.
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
  return { block: { type: 'table', raw: rawOf(i, j), header, rows }, next: j };
}

// ================================================================ list & blockquote
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

function itemLineRegex(marker) {
  return new RegExp(`^( {0,3}${marker})((?:[\\t ][^\\n]*)?(?:\\n|$))`);
}
function nextMarkerRegex(indent) {
  return new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
}
// Break regexes depend only on the clamped indent cR (0..3); cache them
// instead of rebuilding (with `new RegExp`) for every list item.
const BREAK_RX_CACHE = new Map();
function breakPatterns(clamped) {
  let hit = BREAK_RX_CACHE.get(clamped);
  if (!hit) {
    hit = {
      bullet: nextMarkerRegex(clamped), hr: hrPattern(clamped), fence: fenceStartPattern(clamped),
      heading: headingStartPattern(clamped), html: htmlStartPattern(clamped), quote: quoteStartPattern(clamped),
    };
    BREAK_RX_CACHE.set(clamped, hit);
  }
  return hit;
}
const ITEM_LINE_RX_CACHE = new Map();
function cachedItemLineRegex(marker) {
  let hit = ITEM_LINE_RX_CACHE.get(marker);
  if (!hit) { hit = itemLineRegex(marker); ITEM_LINE_RX_CACHE.set(marker, hit); }
  return hit;
}
function hrPattern(indent) {
  return new RegExp(`^ {0,${indent}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
}
function fenceStartPattern(indent) {
  return new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`);
}
function headingStartPattern(indent) {
  return new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`);
}
function htmlStartPattern(indent) {
  return new RegExp(`^ {0,${indent}}(?:</?(?:${HTML_BLOCK_TAGS_SRC})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
}
function quoteStartPattern(indent) {
  return new RegExp(`^ {0,${indent}}>`);
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

// Parse a list starting at `pos` in `src`. Returns {block, rawLen} or null.
function readList(src, pos, ctx) {
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
  const itemRe = cachedItemLineRegex(markerText);
  let pendingLoose = false;
  while (rest) {
    let emptyItem = false, itemText = '';
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
    else { contentIndent = firstContent.search(NON_SPACE_RE); contentIndent = contentIndent > 4 ? 1 : contentIndent; itemText = firstContent.slice(contentIndent); contentIndent += markerLen; }
    if (isEmpty && /^[ \t]*$/.test(nextLine)) { rest = rest.substring(nextLine.length + 1); emptyItem = true; }
    if (!emptyItem) {
      // marked memoises these break regexes with D(), which clamps the
      // indent to max(0, min(3, contentIndent-1)): a line indented more
      // than that does NOT break the item, it is item content.
      const clamped = Math.max(0, Math.min(3, contentIndent - 1));
      const { bullet, hr, fence, heading, html, quote } = breakPatterns(clamped);
      while (rest) {
        const curLine = rest.split('\n', 1)[0];
        nextLine = curLine;
        // Manual scan of the leading whitespace: index idx of the first
        // non-space/tab char, its column col, and whether a tab occurs.
        // This replaces Z.replace(J) + Z.search + 6 break-regex tests for
        // the common no-tab case.
        let idx = 0, col = 0, hasTab = false;
        while (idx < nextLine.length) {
          const code = nextLine.charCodeAt(idx);
          if (code === 32) { col++; idx++; }
          else if (code === 9) { hasTab = true; col += 4 - (col % 4); idx++; }
          else break;
        }
        const firstCh = idx < nextLine.length ? nextLine[idx] : '';
        let colForCompare, blankLine, expanded;
        if (firstCh === '\f' || firstCh === '\v') {
          // Rare: leading form-feed/vertical-tab breaks the tab-expansion
          // model; fall back to the original regex-based computation.
          expanded = nextLine.replace(LEADING_WS_RE, (ws) => expandTabs(ws));
          colForCompare = expanded.search(NON_SPACE_RE);
          blankLine = !nextLine.trim();
        } else {
          blankLine = idx === nextLine.length;
          expanded = hasTab ? nextLine.replace(LEADING_WS_RE, (ws) => expandTabs(ws)) : nextLine;
          colForCompare = col;
        }
        // The break regexes are ^ {0,clamped}(marker): they can only match
        // when there is no leading tab, the leading-space count is <=
        // clamped, and the first char can start a block.
        let isBreak = false;
        if (!hasTab && col <= clamped && firstCh !== '') {
          const code = firstCh.charCodeAt(0);
          if (code === 96 || code === 126 || code === 35 || code === 60 || code === 62 ||
              code === 42 || code === 43 || code === 45 || code === 95 || (code >= 48 && code <= 57)) {
            isBreak = fence.test(nextLine) || heading.test(nextLine) || html.test(nextLine) || quote.test(nextLine) || bullet.test(nextLine) || hr.test(nextLine);
          }
        }
        if (isBreak) break;
        if (colForCompare >= contentIndent || blankLine) itemText += '\n' + expanded.slice(contentIndent);
        else {
          if (isEmpty || firstContent.replace(/\t/g, '    ').search(NON_SPACE_RE) >= 4 || fence.test(firstContent) || heading.test(firstContent) || html.test(firstContent) || hr.test(firstContent)) break;
          const setextLine = SETEXT_LINE_RE.test(nextLine) && canBeSetextText(firstContent) ? '    ' + expanded.replace(/^ {0,3}/, '') : nextLine;
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
    const itemCtx = { links: ctx.links, defs: ctx.defs, top: false, mergePara: false, hadBlankBetween: false };
    item.tokens = parseBlockList(item.text, itemCtx);
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
  ctx.top = true;
  return { block: list, rawLen: list.raw.length };
}

// Is `line` a lazy paragraph continuation inside a blockquote (per Ke)?
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

// Parse a blockquote starting at `pos` in `src`. Returns {block, rawLen} or null.
function readBlockquote(src, pos, ctx) {
  const source = src.slice(pos);
  if (!QUOTE_START_RE.test(source)) return null;
  const { lines } = splitIntoLines(source);
  const nLines = lines.length;
  // collect the blockquote run (Xe): a `>` line + its lazy continuations
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
  let rawAccum = '', textAccum = '', tokens = [];
  while (remaining.length > 0) {
    let sawMarker = false, groupLines = [], lineIdx;
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
    const innerCtx = { links: ctx.links, defs: ctx.defs, top: true, mergePara: true };
    parseBlockList(stripped, innerCtx, tokens);
    if (remaining.length === 0) break;
    const lastToken = tokens.at(-1);
    if (!lastToken) break;
    if (lastToken.type === 'code' || lastToken.type === 'heading' || lastToken.type === 'hr' || lastToken.type === 'html' || lastToken.type === 'table') break;
    if (lastToken.type === 'blockquote') {
      const nested = lastToken;
      const restText = remaining.join('\n');
      const reparsedSrc = nested.raw + '\n' + restText.replace(QUOTE_STRIP_RE, '');
      const reparsed = readBlockquote(reparsedSrc, 0, ctx);
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
      const reparsed = readList(reparsedSrc, 0, ctx);
      if (!reparsed) break;
      tokens[tokens.length - 1] = reparsed.block;
      const extraLines = reparsed.rawLen > nestedList.raw.length ? reparsedSrc.slice(nestedList.raw.length + 1, reparsed.rawLen).split('\n').length : 0;
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
  // NB: marked's blockquote SAVES state.top before the inner blockTokens
  // and RESTORES it after (unlike a list, which leaves it true), so the
  // enclosing ctx.top is unchanged here.
  return { block: { type: 'blockquote', raw: rawAccum, text: textAccum, tokens }, rawLen: rawAccum.length };
}

// ================================================================ renderer (phase 2)
// `st` is the shared inline state for the whole document: marked's lexer
// keeps ONE state across all inline parses, resetting only `inRawBlock`
// before each block's inline tokens, while `inLink` persists across blocks
// (an unclosed `<a ...>` tag disables GFM url/email linkification for the
// rest of the document). Call `renderBlockInline` for a block's own text.
function renderBlockInline(st, text, links) {
  st.inRawBlock = false;
  return renderInline(text, links, st);
}

function renderAllBlocks(blocks, links, st) {
  let out = '';
  for (const block of blocks) out += renderOneBlock(block, links, st);
  return out;
}

function renderOneBlock(block, links, st) {
  switch (block.type) {
    case 'space':
      return '';
    case 'code': {
      const firstWord = (block.lang || '').match(/^\S*/)?.[0] || '';
      const body = block.text ? block.text.replace(/\n$/, '') + '\n' : '';
      const inner = escapeHtml(body, true);
      return firstWord ? `<pre><code class="language-${escapeHtml(firstWord)}">${inner}</code></pre>\n`
               : `<pre><code>${inner}</code></pre>\n`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderAllBlocks(block.tokens, links, st)}</blockquote>\n`;
    case 'html':
      return block.text;
    case 'def':
      return '';
    case 'heading':
      return `<h${block.depth}>${renderBlockInline(st, block.text, links)}</h${block.depth}>\n`;
    case 'hr':
      return '<hr>\n';
    case 'list': {
      let itemsHtml = '';
      for (const item of block.items) itemsHtml += renderItem(item, links, st);
      const tag = block.ordered ? 'ol' : 'ul';
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
      return `<${tag}${start}>\n${itemsHtml}</${tag}>\n`;
    }
    case 'table': {
      let headerHtml = '';
      for (const cell of block.header) headerHtml += renderCell(cell, true, links, st);
      const headRow = `<tr>\n${headerHtml}</tr>\n`;
      let bodyHtml = '';
      for (const row of block.rows) {
        let rowHtml = '';
        for (const cell of row) rowHtml += renderCell(cell, false, links, st);
        bodyHtml += `<tr>\n${rowHtml}</tr>\n`;
      }
      if (bodyHtml) bodyHtml = `<tbody>${bodyHtml}</tbody>`;
      return `<table>\n<thead>\n${headRow}</thead>\n${bodyHtml}</table>\n`;
    }
    case 'paragraph':
      return `<p>${renderBlockInline(st, block.text, links)}</p>\n`;
    case 'text':
      return renderBlockInline(st, block.text, links);
    case 'checkbox':
      return `<input ${block.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    default:
      return '';
  }
}

function renderItem(item, links, st) {
  let inner = renderAllBlocks(item.tokens, links, st);
  if (item.hasCheckbox) {
    const box = `<input ${item.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
    if (item.loose && inner.startsWith('<p>')) inner = '<p>' + box + inner.slice(3);
    else inner = box + inner;
  }
  return `<li>${inner}</li>\n`;
}

function renderCell(cell, isHeader, links, st) {
  const tag = isHeader ? 'th' : 'td';
  const align = cell.align ? ` align="${cell.align}"` : '';
  return `<${tag}${align}>${renderBlockInline(st, cell.text, links)}</${tag}>\n`;
}

// ================================================================ fastRender
// Fast path with a per-block fallback to marked (passed in as `markedParse`).
// `src` is normalised (\r -> \n) first, like marked's lex().
function fastRender(src, markedParse) {
  const norm = src.replace(/\r\n?/g, '\n');
  if (norm.length < 2000) return markedParse(norm);
  const ctx = { links: {}, defs: [], top: true, mergePara: false };
  const blocks = parseBlockList(norm, ctx);
  const defsText = ctx.defs.map((d) => d.raw).join('');
  // One shared inline state for the whole document (see renderer note).
  const st = { inLink: false, inRawBlock: false };
  let out = '';
  for (const block of blocks) {
    try {
      out += renderOneBlock(block, ctx.links, st);
    } catch (e) {
      out += markedParse(defsText + '\n' + block.raw);
    }
  }
  return out;
}

export { fastRender, parseBlockList, renderInline, readList, readBlockquote };
