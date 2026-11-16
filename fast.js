
// fast.js — hand-written fast renderer for CommonMark 0.31.2 + GFM.
// Anything this file cannot handle throws Error('fast-bail') and the
// caller (parse.js) falls back to the vendored marked.

const BACKSLASH = 92;
const NL = 10;
const CR = 13;
const SPACE = 32;
const TAB = 9;
const QUOT = 34;
const APOS = 39;
const LANGLE = 60;
const RANGLE = 62;
const LPAR = 40;
const RPAR = 41;
const LBR = 91;
const RBR = 93;
const BANG = 33;
const STAR = 42;
const UNDER = 95;
const TILDE = 126;
const BACKTICK = 96;
const AMP = 38;

export function bail() {
  throw new Error('fast-bail');
}

function isSpace(c) {
  return c === SPACE || c === TAB || c === NL || c === CR;
}
function isDigit(c) {
  return c >= 48 && c <= 57;
}
function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnum(c) {
  return isAlpha(c) || isDigit(c);
}
// ASCII punctuation, plus the non-ASCII punctuation ranges that show up
// in real documents (general punctuation, CJK and fullwidth punctuation).
// CommonMark counts Unicode categories P *and* S (symbols, incl.
// currency) as punctuation for flanking purposes.
function isPunct(c) {
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  if (c >= 0x2010 && c <= 0x2027) return true;
  if (c >= 0x2030 && c <= 0x205f) return true;
  if (c === 0x00a1 || c === 0x00ab || c === 0x00bb || c === 0x00bf || c === 0x00b7) return true;
  if (c >= 0x2e00 && c <= 0x2e7f) return true;
  if (c >= 0x3001 && c <= 0x303f) return true;
  if (c >= 0x00a2 && c <= 0x00a5) return true;
  if (c === 0x00a6 || c === 0x00a9 || c === 0x00ac || c === 0x00ae || c === 0x00b0 || c === 0x00b1 || c === 0x00d7 || c === 0x00f7) return true;
  if (c >= 0x20a0 && c <= 0x20bf) return true;
  if (c >= 0x2190 && c <= 0x22ff) return true;
  if (c >= 0x2300 && c <= 0x23ff) return true;
  if (c >= 0x2500 && c <= 0x27bf) return true;
  if (
    (c >= 0xff01 && c <= 0xff0f) ||
    (c >= 0xff1a && c <= 0xff20) ||
    (c >= 0xff3b && c <= 0xff40) ||
    (c >= 0xff5b && c <= 0xff65)
  ) {
    return true;
  }
  return false;
}
function isWordChar(c) {
  return isAlnum(c) || c === UNDER;
}
// ASCII punctuation only. Backslash escapes only work before these;
// non-ASCII punctuation (like « or —) is NOT escapable.
function isAsciiPunct(c) {
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}
// Unicode whitespace (for emphasis flanking rules).
function isUniWs(c) {
  if (c === SPACE || c === TAB || c === NL || c === CR || c === 11 || c === 12) return true;
  if (c === 0x00a0 || c === 0x1680 || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000) return true;
  if (c >= 0x2000 && c <= 0x200a) return true;
  return false;
}

// Length of the entity reference starting at s[i] (s[i] === '&'), or 0.
// Named references are matched by the pattern &[A-Za-z0-9_]+; and are
// passed through unchanged; numeric references must have 1-7 decimal or
// 1-6 hex digits followed by ';'.
function entityLenAt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return 0;
  if (s.charCodeAt(i + 1) === 35) {
    let p = i + 2;
    let hex = false;
    if (p < n && (s.charCodeAt(p) === 120 || s.charCodeAt(p) === 88)) {
      hex = true;
      p++;
    }
    const ds = p;
    while (p < n) {
      const d = s.charCodeAt(p);
      if (isDigit(d)) p++;
      else if (hex && ((d >= 65 && d <= 70) || (d >= 97 && d <= 102))) p++;
      else break;
    }
    const nd = p - ds;
    if (nd === 0) return 0;
    if (hex ? nd > 6 : nd > 7) return 0;
    if (p >= n || s.charCodeAt(p) !== 59) return 0;
    return p + 1 - i;
  }
  let p = i + 1;
  while (p < n) {
    const d = s.charCodeAt(p);
    if (isAlnum(d) || d === UNDER) p++;
    else break;
  }
  if (p === i + 1) return 0;
  if (p >= n || s.charCodeAt(p) !== 59) return 0;
  return p + 1 - i;
}

// Code point value of the numeric entity starting at s[i], or -1.
function numericEntityAt(s, i) {
  const n = s.length;
  if (i + 1 >= n || s.charCodeAt(i + 1) !== 35) return -1;
  let p = i + 2;
  let hex = false;
  if (p < n && (s.charCodeAt(p) === 120 || s.charCodeAt(p) === 88)) {
    hex = true;
    p++;
  }
  const ds = p;
  let v = 0;
  while (p < n) {
    const d = s.charCodeAt(p);
    let dv = -1;
    if (isDigit(d)) dv = d - 48;
    else if (hex && d >= 65 && d <= 70) dv = d - 55;
    else if (hex && d >= 97 && d <= 102) dv = d - 87;
    else break;
    v = v * (hex ? 16 : 10) + dv;
    p++;
  }
  const nd = p - ds;
  if (nd === 0) return -1;
  if (hex ? nd > 6 : nd > 7) return -1;
  if (p >= n || s.charCodeAt(p) !== 59) return -1;
  return v;
}

function codePointToString(cp) {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

// No-encode escape: '&' is escaped only when it does not start a valid
// reference. Used for plain text, titles and language strings.
function escText(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === AMP) {
      const el = entityLenAt(s, i);
      if (el > 0) {
        out += s.slice(i, i + el);
        i += el;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === LANGLE) {
      out += '&lt;';
      i++;
      continue;
    }
    if (c === RANGLE) {
      out += '&gt;';
      i++;
      continue;
    }
    if (c === QUOT) {
      out += '&quot;';
      i++;
      continue;
    }
    if (c === APOS) {
      out += '&#39;';
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// Encode-all escape: every '&' is escaped, even inside '&copy;'.
// Used for code spans and code blocks.
function escCode(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === AMP) out += '&amp;';
    else if (c === LANGLE) out += '&lt;';
    else if (c === RANGLE) out += '&gt;';
    else if (c === QUOT) out += '&quot;';
    else if (c === APOS) out += '&#39;';
    else out += s[i];
  }
  return out;
}

// Escape a run of inline text: numeric entities are decoded (and the
// decoded character re-escaped when needed), named entities pass through,
// other '&' become '&amp;'.
function escTextRun(s) {
  if (!/[&<>"']/.test(s)) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === AMP) {
      const el = entityLenAt(s, i);
      if (el > 0) {
        if (s.charCodeAt(i + 1) === 35) {
          const cp = numericEntityAt(s, i);
          if (cp >= 0) {
            const ch = codePointToString(cp);
            if (ch === '&') out += '&amp;';
            else if (ch === '<') out += '&lt;';
            else if (ch === '>') out += '&gt;';
            else if (ch === '"') out += '&quot;';
            else if (ch === "'") out += '&#39;';
            else out += ch;
            i += el;
            continue;
          }
        }
        out += s.slice(i, i + el);
        i += el;
        continue;
      }
      out += '&amp;';
      i++;
      continue;
    }
    if (c === LANGLE) {
      out += '&lt;';
      i++;
      continue;
    }
    if (c === RANGLE) {
      out += '&gt;';
      i++;
      continue;
    }
    if (c === QUOT) {
      out += '&quot;';
      i++;
      continue;
    }
    if (c === APOS) {
      out += '&#39;';
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// Clean an href: encodeURI, then un-escape the '%' that encodeURI added
// for a literal '%', then the no-encode escape. Returns null when the
// href cannot be encoded (lone surrogate) — the link is dropped.
function cleanHref(href) {
  try {
    return escText(encodeURI(href).replace(/%25/g, '%'));
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------- inline-parser helpers

const HTML_TAG_NAMES = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section',
  'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

function normalizeLabel(label) {
  // Unicode case folding: ß/ẞ fold to "ss" (toLowerCase alone gives ß)
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

function runLen(s, i, ch) {
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) === ch) n++;
  return n;
}

// Find a closing backtick run of exactly length n at or after i.
// Returns the index of its first backtick, or -1.
function findCodeClose(s, i, n) {
  let p = i;
  while (p < s.length) {
    if (s.charCodeAt(p) !== BACKTICK) {
      p++;
      continue;
    }
    const r = runLen(s, p, BACKTICK);
    if (r === n) return p;
    p += r;
  }
  return -1;
}

// Skip spaces/tabs and at most one newline. Returns the new index, or -1
// when a blank line is crossed.
function skipInlineWs(s, i) {
  const n = s.length;
  let p = i;
  let seenNl = false;
  for (;;) {
    if (p >= n) return p;
    const c = s.charCodeAt(p);
    if (c === SPACE || c === TAB) {
      p++;
      continue;
    }
    if (c === NL || c === CR) {
      if (seenNl) return -1;
      seenNl = true;
      if (c === CR && p + 1 < n && s.charCodeAt(p + 1) === NL) p += 2;
      else p++;
      continue;
    }
    return p;
  }
}

// Process backslash escapes only (no entity decoding). Used for the
// fenced-code info string, where entities stay as-is.
function unescapeBackslash(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === BACKSLASH && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i++;
    } else {
      out += s[i];
    }
  }
  return out;
}

// Process backslash escapes and decode numeric entities. Named entities
// pass through unchanged.
function unescapeText(s) {
  if (s.indexOf('\\') < 0 && s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === BACKSLASH && i + 1 < n && isAsciiPunct(s.charCodeAt(i + 1))) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (c === AMP) {
      const el = entityLenAt(s, i);
      if (el > 0 && s.charCodeAt(i + 1) === 35) {
        const cp = numericEntityAt(s, i);
        if (cp >= 0) {
          out += codePointToString(cp);
          i += el;
          continue;
        }
      }
      out += '&';
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// Parse a link tail starting at s[i] === '('. Returns
// {href, title, end} (end is just past the closing ')') or null.
function parseLinkTail(s, i) {
  const n = s.length;
  let p = skipInlineWs(s, i + 1);
  if (p < 0) return null;
  let href;
  if (p < n && s.charCodeAt(p) === LANGLE) {
    let q = p + 1;
    while (q < n) {
      const c = s.charCodeAt(q);
      // a backslash-escaped '>' does not close the angle destination
      if (c === BACKSLASH && q + 1 < n && isAsciiPunct(s.charCodeAt(q + 1))) {
        q += 2;
        continue;
      }
      if (c === RANGLE || c === NL || c === CR) break;
      q++;
    }
    if (q >= n || s.charCodeAt(q) !== RANGLE) return null;
    href = unescapeText(s.slice(p + 1, q));
    p = q + 1;
  } else {
    let q = p;
    let depth = 0;
    let has = false;
    while (q < n) {
      const c = s.charCodeAt(q);
      if (c === BACKSLASH) {
        if (q + 1 < n) {
          q += 2;
          has = true;
          continue;
        }
        break;
      }
      if (c === LPAR) {
        depth++;
        q++;
        has = true;
        continue;
      }
      if (c === RPAR) {
        if (depth === 0) break;
        depth--;
        q++;
        has = true;
        continue;
      }
      if (c === SPACE || c === TAB || c === NL || c === CR || c < 32 || c === 127) break;
      q++;
      has = true;
    }
    if (depth !== 0) return null;
    href = has ? unescapeText(s.slice(p, q)) : '';
    p = q;
  }
  let title = null;
  const save = p;
  p = skipInlineWs(s, p);
  if (p < 0) return null;
  if (p < n && (s.charCodeAt(p) === QUOT || s.charCodeAt(p) === APOS || s.charCodeAt(p) === LPAR)) {
    const open = s.charCodeAt(p);
    const close = open === LPAR ? RPAR : open;
    let q = p + 1;
    let ok = false;
    while (q < n) {
      const c = s.charCodeAt(q);
      if (c === BACKSLASH && q + 1 < n && isAsciiPunct(s.charCodeAt(q + 1))) {
        q += 2;
        continue;
      }
      if (c === close) {
        ok = true;
        break;
      }
      if (c === NL || c === CR) {
        // a blank line inside the title kills the link
        const nlEnd = c === CR && q + 1 < n && s.charCodeAt(q + 1) === NL ? q + 2 : q + 1;
        let r = nlEnd;
        while (r < n && (s.charCodeAt(r) === SPACE || s.charCodeAt(r) === TAB)) r++;
        if (r < n && (s.charCodeAt(r) === NL || s.charCodeAt(r) === CR)) return null;
        q = nlEnd;
        continue;
      }
      q++;
    }
    if (!ok) return null;
    title = unescapeText(s.slice(p + 1, q));
    p = q + 1;
  } else {
    p = save;
  }
  p = skipInlineWs(s, p);
  if (p < 0) return null;
  if (p >= n || s.charCodeAt(p) !== RPAR) return null;
  return { href, title, end: p + 1 };
}

// Scan a link label starting at s[i] === '['. Returns the index of the
// matching ']' (depth-counting, skipping code spans and escapes), or -1.
// An unterminated code span is literal text and does not block the scan.
function scanLabel(s, i) {
  const n = s.length;
  let depth = 0;
  let p = i;
  while (p < n) {
    const c = s.charCodeAt(p);
    if (c === BACKSLASH && p + 1 < n && isAsciiPunct(s.charCodeAt(p + 1))) {
      p += 2;
      continue;
    }
    if (c === BACKTICK) {
      const r = runLen(s, p, BACKTICK);
      const close = findCodeClose(s, p + r, r);
      if (close < 0) {
        p += r;
        continue;
      }
      p = close + r;
      continue;
    }
    if (c === LBR) {
      depth++;
      p++;
      continue;
    }
    if (c === RBR) {
      depth--;
      if (depth === 0) return p;
      p++;
      continue;
    }
    p++;
  }
  return -1;
}

// ------------------------------------------------------------ GFM autolinks

function isEmailLocalChar(c) {
  return (
    isAlnum(c) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
    c === 39 || c === 42 || c === 43 || c === 45 || c === 47 || c === 61 ||
    c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 ||
    c === 125 || c === 126
  );
}
function isDomainChar(c) {
  return isAlnum(c) || c === 45 || c === 95;
}

// Scan a GFM extended autolink (www., http/https/ftp, email, mailto:) that
// starts at or after `from` and before `limit`. Returns
// {start, end, href, text} or null. The start must not be preceded by a
// word character (an autolink cannot sit inside a word).
function scanGfmAutolink(s, from, limit) {
  const n = s.length;
  let pos = from;
  for (;;) {
    const atWww = s.indexOf('www.', pos);
    const atAt = s.indexOf('@', pos);
    const atScheme = s.indexOf('://', pos);
    let kind = -1;
    let idx = n;
    if (atWww >= 0 && atWww < idx) {
      idx = atWww;
      kind = 0;
    }
    if (atAt >= 0 && atAt < idx) {
      idx = atAt;
      kind = 1;
    }
    if (atScheme >= 0 && atScheme < idx) {
      idx = atScheme;
      kind = 2;
    }
    if (kind < 0 || idx >= limit) return null;
    if (kind === 0) {
      // www. : needs a boundary before it and at least one URL char after
      if (idx > 0 && isWordChar(s.charCodeAt(idx - 1))) {
        pos = idx + 4;
        continue;
      }
      const url = scanGfmUrl(s, idx, n);
      if (!url) {
        pos = idx + 4;
        continue;
      }
      return {
        start: idx,
        end: url.end,
        href: cleanHref('http://' + url.text),
        text: url.text,
      };
    }
    if (kind === 2) {
      // scheme:// : look back for http, https or ftp (case-insensitive)
      let st = idx - 1;
      while (st >= 0 && isAlpha(s.charCodeAt(st))) st--;
      st++;
      const scheme = s.slice(st, idx).toLowerCase();
      if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ftp') {
        pos = idx + 3;
        continue;
      }
      if (st > 0 && isWordChar(s.charCodeAt(st - 1))) {
        pos = idx + 3;
        continue;
      }
      const url = scanGfmUrl(s, st, n);
      if (!url) {
        pos = idx + 3;
        continue;
      }
      return { start: st, end: url.end, href: cleanHref(url.text), text: url.text };
    }
    // email: extend the local part left from '@', the domain right
    let ls = idx - 1;
    while (ls >= 0 && isEmailLocalChar(s.charCodeAt(ls)) && !isEscaped(s, ls)) {
      // a '__' run is an opening emphasis delimiter, not part of the
      // local part: stop before it (a single '_' is fine)
      if (s.charCodeAt(ls) === 95 && ls - 1 >= 0 && s.charCodeAt(ls - 1) === 95) break;
      ls--;
    }
    ls++;
    if (ls >= idx) {
      pos = idx + 1;
      continue;
    }
    // a scheme prefix (mailto:, xmpp:, ...) belongs to the link when
    // it directly precedes the email: scheme = letter followed by
    // letters/digits/+/-/. then ':'
    let start = ls;
    let schemeEnd = -1;
    if (ls >= 2 && s.charCodeAt(ls - 1) === 58) {
      let ss = ls - 2;
      while (ss >= 0) {
        const cc = s.charCodeAt(ss);
        if (isAlnum(cc) || cc === 43 || cc === 45 || cc === 46) ss--;
        else break;
      }
      ss++;
      if (ss < ls - 1 && isAlpha(s.charCodeAt(ss))) {
        if (ss === 0 || !isWordChar(s.charCodeAt(ss - 1))) {
          start = ss;
          schemeEnd = ls - 1;
        }
      }
    }
    let de = idx + 1;
    while (de < n && (isDomainChar(s.charCodeAt(de)) || s.charCodeAt(de) === 46)) {
      // a '__' run is a closing emphasis delimiter, not part of the
      // domain: stop the domain before it (a single '_' is fine)
      if (s.charCodeAt(de) === 95 && de + 1 < n && s.charCodeAt(de + 1) === 95) break;
      de++;
    }
    // the domain must contain a dot and end in a domain character
    let dom = s.slice(idx + 1, de);
    // trim trailing dots only; a domain ending in - or _ is not an
    // email at all (reject, do not link a trimmed version)
    while (dom.length > 0 && dom.charCodeAt(dom.length - 1) === 46) {
      dom = dom.slice(0, -1);
      de--;
    }
    if (dom.length > 0) {
      const lastDom = dom.charCodeAt(dom.length - 1);
      if (lastDom === 45 || lastDom === 95) {
        pos = idx + 1;
        continue;
      }
    }
    if (dom.indexOf('.') < 0 || dom.length === 0) {
      pos = idx + 1;
      continue;
    }
    // the local part may not start or end with a dot
    let local = s.slice(ls, idx);
    while (local.length > 0 && local.charCodeAt(0) === 46) {
      local = local.slice(1);
      ls++;
    }
    while (local.length > 0 && local.charCodeAt(local.length - 1) === 46) local = local.slice(0, -1);
    if (local.length === 0) {
      pos = idx + 1;
      continue;
    }
    const email = local + '@' + dom;
    const prefix = start === ls ? '' : s.slice(start, ls);
    // a schemed email (e.g. xmpp:) may carry one /resource segment
    let end = de;
    if (prefix !== '' && prefix.toLowerCase() !== 'mailto:' && end < n && s.charCodeAt(end) === 47) {
      let pe = end + 1;
      while (pe < n) {
        const cc = s.charCodeAt(pe);
        if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 60 || cc === 34 || cc === 39 || cc === 47) break;
        pe++;
      }
      // trim trailing punctuation from the segment
      while (pe > end + 1) {
        const cc = s.charCodeAt(pe - 1);
        if (cc === 63 || cc === 33 || cc === 46 || cc === 44 || cc === 58 || cc === 59 || cc === 42 || cc === 95 || cc === 126 || cc === 41) pe--;
        else break;
      }
      if (pe > end + 1) end = pe;
    }
    return {
      start,
      end,
      href: cleanHref(prefix === '' ? 'mailto:' + email : prefix + email + s.slice(de, end)),
      text: prefix + email + s.slice(de, end),
    };
  }
}

// Scan a GFM URL starting at s[i] (the prefix is included). Returns
// {text, end} with trailing punctuation trimmed and parens balanced, or
// null when there is nothing to link.
function scanGfmUrl(s, i, limit) {
  const n = Math.min(s.length, limit);
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === SPACE || c === TAB || c === NL || c === CR || c === LANGLE || c === QUOT || c === APOS) break;
    j++;
  }
  if (j === i) return null;
  let end = j;
  // a trailing &name; / &#num; / &#xhex; (entity reference) is not
  // part of the URL: cut back to the '&'
  if (end > i && s.charCodeAt(end - 1) === 59) {
    let amp = end - 2;
    while (amp >= i && isAlnum(s.charCodeAt(amp))) amp--;
    if (amp >= i && s.charCodeAt(amp) === 38 && end - 1 - amp - 1 >= 1) {
      end = amp;
    } else if (amp >= i + 1 && s.charCodeAt(amp) === 35 && s.charCodeAt(amp - 1) === 38) {
      end = amp - 1;
    }
  }
  // trim trailing punctuation and balance parens, looping until
  // stable: dropping a ')' can expose punctuation ('a..)' -> 'a..'
  // -> 'a') and trimming punctuation can expose an unmatched ')'
  // ('a).' -> 'a)' -> 'a').
  for (;;) {
    const before = end;
    for (;;) {
      if (end <= i) return null;
      const c = s.charCodeAt(end - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 || c === 42 || c === UNDER || c === TILDE) {
        end--;
        continue;
      }
      break;
    }
    // balance parens with a stack: a ')' with no open '(' before it
    // is unmatched, and a '(' that is never closed makes the URL end
    // just before it (a ')' before the '(' does not close it, so
    // totals alone are not enough: 'a.io)x(y' must end at the '(').
    {
      const stack = [];
      const unmatchedClose = new Set();
      for (let k = i; k < end; k++) {
        if (s.charCodeAt(k) === LPAR) {
          stack.push(k);
        } else if (s.charCodeAt(k) === RPAR) {
          if (stack.length > 0) stack.pop();
          else unmatchedClose.add(k);
        }
      }
      while (end > i && s.charCodeAt(end - 1) === RPAR && unmatchedClose.has(end - 1)) {
        end--;
      }
      if (stack.length > 0) end = stack[0];
    }
    if (end === before) break;
  }
  if (end <= i) return null;
  return { text: s.slice(i, end), end };
}

// ------------------------------------------------------- bracketed autolinks

// Try a <...> autolink or raw HTML tag at s[i] (s[i] === '<'). Returns
// {kind: 'link'|'html', href, text, end} or null. `end` is just past '>'.
function scanAngle(s, i) {
  const n = s.length;
  const gt = s.indexOf('>', i + 1);
  if (gt < 0 || gt - i > 1000) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.length === 0) return null;
  // autolink: scheme:... or email, with no spaces or '<'
  if (inner.indexOf(' ') < 0 && inner.indexOf('\t') < 0 && inner.indexOf('\n') < 0 && inner.indexOf('<') < 0) {
    const colon = inner.indexOf(':');
    if (colon > 0) {
      const scheme = inner.slice(0, colon);
      if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$/.test(scheme)) {
        return { kind: 'link', href: cleanHref(inner), text: inner, end: gt + 1 };
      }
    }
    // email autolink: local@domain with a dot
    if (/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(inner)) {
      return { kind: 'link', href: cleanHref('mailto:' + inner), text: inner, end: gt + 1 };
    }
  }
  // raw HTML: comment, processing instruction, declaration, CDATA, tag
  if (inner.startsWith('!--')) {
    // abrupt closing: <!--> and <!---> are complete comments
    if (s.charCodeAt(i + 4) === 62) return { kind: 'html', text: s.slice(i, i + 5), end: i + 5 };
    if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return { kind: 'html', text: s.slice(i, i + 6), end: i + 6 };
    const end = s.indexOf('-->', i + 4);
    if (end >= 0) return { kind: 'html', text: s.slice(i, end + 3), end: end + 3 };
    return null;
  }
  if (inner.startsWith('?')) {
    const end = s.indexOf('?>', i + 2);
    if (end >= 0) return { kind: 'html', text: s.slice(i, end + 2), end: end + 2 };
    return null;
  }
  if (inner.startsWith('![CDATA[')) {
    const end = s.indexOf(']]>', i + 9);
    if (end >= 0) return { kind: 'html', text: s.slice(i, end + 3), end: end + 3 };
    return null;
  }
  if (inner.startsWith('!')) {
    // declaration: <! + letter, up to '>'
    if (inner.length > 1 && isAlpha(inner.charCodeAt(1))) {
      return { kind: 'html', text: s.slice(i, gt + 1), end: gt + 1 };
    }
    return null;
  }
  // open or close tag
  const tag = matchHtmlTag(s, i);
  if (tag) return { kind: 'html', text: tag.text, end: tag.end };
  return null;
}

// Match an open or close HTML tag at s[i] ('<'). Returns {text, end} or null.
function matchHtmlTag(s, i) {
  const n = s.length;
  let p = i + 1;
  let closing = false;
  if (p < n && s.charCodeAt(p) === 47) {
    closing = true;
    p++;
  }
  const nameStart = p;
  if (p >= n || !isAlpha(s.charCodeAt(p))) return null;
  while (p < n && (isAlnum(s.charCodeAt(p)) || s.charCodeAt(p) === 45)) p++;
  if (p === nameStart) return null;
  if (closing) {
    // optional whitespace, then '>'
    while (p < n && (s.charCodeAt(p) === SPACE || s.charCodeAt(p) === TAB || s.charCodeAt(p) === NL || s.charCodeAt(p) === CR)) p++;
    if (p < n && s.charCodeAt(p) === RANGLE) return { text: s.slice(i, p + 1), end: p + 1 };
    return null;
  }
  // attributes: whitespace + name, optional = value (quoted or unquoted).
  // An attribute must be preceded by whitespace; a bare name char, ':',
  // '.' or '_' right after the tag name (or after a quoted value) is
  // not a valid attribute, so the tag is not valid.
  for (;;) {
    const wsStart = p;
    while (p < n && (s.charCodeAt(p) === SPACE || s.charCodeAt(p) === TAB || s.charCodeAt(p) === NL || s.charCodeAt(p) === CR)) p++;
    if (p >= n) return null;
    const c = s.charCodeAt(p);
    if (c === RANGLE) return { text: s.slice(i, p + 1), end: p + 1 };
    if (c === 47) {
      if (p + 1 < n && s.charCodeAt(p + 1) === RANGLE) return { text: s.slice(i, p + 2), end: p + 2 };
      return null;
    }
    if (p === wsStart) return null;
    // attribute name
    if (!isAlpha(s.charCodeAt(p)) && s.charCodeAt(p) !== UNDER && s.charCodeAt(p) !== 58 && s.charCodeAt(p) !== 46) return null;
    while (p < n) {
      const a = s.charCodeAt(p);
      if (isAlnum(a) || a === UNDER || a === 58 || a === 46 || a === 45) p++;
      else break;
    }
    // optional = value: only consume the whitespace before '=' when an
    // '=' actually follows, otherwise leave it for the next attribute
    const afterName = p;
    while (p < n && (s.charCodeAt(p) === SPACE || s.charCodeAt(p) === TAB || s.charCodeAt(p) === NL || s.charCodeAt(p) === CR)) p++;
    if (p < n && s.charCodeAt(p) === 61) {
      p++;
      while (p < n && (s.charCodeAt(p) === SPACE || s.charCodeAt(p) === TAB || s.charCodeAt(p) === NL || s.charCodeAt(p) === CR)) p++;
      if (p >= n) return null;
      const q = s.charCodeAt(p);
      if (q === QUOT || q === APOS) {
        p++;
        while (p < n && s.charCodeAt(p) !== q) p++;
        if (p >= n) return null;
        p++;
      } else {
        while (p < n) {
          const v = s.charCodeAt(p);
          if (v === SPACE || v === TAB || v === NL || v === CR || v === QUOT || v === APOS || v === 61 || v === LANGLE || v === RANGLE || v === BACKTICK) break;
          p++;
        }
        if (p >= n) return null;
      }
    } else {
      // no '=': restore to just after the attribute name so the
      // whitespace before the next attribute is not consumed here
      p = afterName;
    }
  }
}

// ------------------------------------------------------------ inline parser

function escChar(ch) {
  if (ch === '&') return '&amp;';
  if (ch === '<') return '&lt;';
  if (ch === '>') return '&gt;';
  if (ch === '"') return '&quot;';
  if (ch === "'") return '&#39;';
  return ch;
}

// Plain-text version of a text run: numeric entities are decoded, the
// rest passes through raw (no HTML escaping). Used for image alt text.
function plainTextRun(s) {
  if (s.indexOf('&') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    if (s.charCodeAt(i) === AMP) {
      const el = entityLenAt(s, i);
      if (el > 0 && s.charCodeAt(i + 1) === 35) {
        const cp = numericEntityAt(s, i);
        if (cp >= 0) {
          out += codePointToString(cp);
          i += el;
          continue;
        }
      }
      out += '&';
      i++;
      continue;
    }
    out += s[i];
    i++;
  }
  return out;
}

// Pair emphasis / strikethrough delimiters after the scan. A delimiter
// run renders as closeTags + unused literal delimiters + openTags.
// An emphasis pair may not cross an already-formed emphasis boundary:
// if a recorded span [sj, si] has sj < j < si < i, the opener at j is
// inside that span while the closer at i is outside it, so matching
// them would overlap — skip that opener.
function processEmphasis(delims) {
  const n = delims.length;
  const spans = [];
  for (let i = 0; i < n; i++) {
    const closer = delims[i];
    if (!closer.close || closer.n === 0) continue;
    let j = i - 1;
    while (j >= 0 && closer.n > 0) {
      const opener = delims[j];
      if (opener.n > 0 && opener.open && opener.ch === closer.ch) {
        // overlap check: skip an opener inside an already-formed span
        // whose close is before this closer
        let crosses = false;
        for (let s = 0; s < spans.length; s++) {
          const sj = spans[s][0];
          const si = spans[s][1];
          if (sj < j && j < si && si < i) { crosses = true; break; }
        }
        if (crosses) {
          j--;
          continue;
        }
        // A closer must not match across a delimiter between them that
        // can both open and close and already formed emphasis, when
        // that would strand a longer opener run (e.g. the inner *so*
        // in **a *so*other* d*: the * after "other" must stay literal
        // so the outer ** can close as <strong>). The same block
        // applies to a single-* opener when an inner ** pair sits
        // between whose opener is a pure opener (preceded by
        // whitespace) and whose closer can both open and close
        // (e.g. *a **b**c*: the outer *...* stays literal, while in
        // *foo**bar**baz* the inner ** opener follows a letter and
        // in *a **b** c* the inner ** closer can only close, so the
        // outer *...* forms in both).
        {
          let blocked = false;
          if (closer.n === 1 && opener.n >= 2) {
            for (let m = j + 1; m < i; m++) {
              const mid = delims[m];
              if (mid.open && mid.close && (mid.openTags.length > 0 || mid.closeTags.length > 0)) {
                blocked = true;
                break;
              }
            }
          } else if (opener.n === 1 && closer.ch === '*' && opener.ch === '*') {
            // a single-* opener taking one delimiter (even from a **
            // closer run) is blocked by an inner ** (strong) pair:
            // an inner * (em) pair or a '_' outer must still form
            // (e.g. _large **data**not_ and *state *types*updates*
            // both form their outer)
            for (let m = j + 1; m < i; m++) {
              const mid = delims[m];
              if (mid.ch === '*' && mid.open && !mid.close && mid.openTags.indexOf('<strong>') >= 0) {
                // inner ** opener that is a pure opener: check its
                // matching closer (the next * delimiter with a
                // </strong> close tag after it) can both open and close
                for (let q = m + 1; q < i; q++) {
                  const cl = delims[q];
                  if (cl.ch === '*' && cl.closeTags.indexOf('</strong>') >= 0 && cl.open && cl.close) {
                    blocked = true;
                    break;
                  }
                }
              }
              if (blocked) break;
            }
          }
          if (blocked) {
            j--;
            continue;
          }
        }
        // odd-match rule (rule of 3): only for * and _
        if (
          closer.ch !== '~' &&
          ((opener.open && opener.close) || (closer.open && closer.close)) &&
          (opener.n + closer.n) % 3 === 0 &&
          opener.n % 3 !== 0
        ) {
          j--;
          continue;
        }
        // a strikethrough pair must have equal lengths
        if (closer.ch === '~' && opener.n !== closer.n) {
          j--;
          continue;
        }
        const k = closer.ch === '~' ? opener.n : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
        if (closer.ch === '~') {
          opener.openTags.unshift('<del>');
          closer.closeTags.push('</del>');
        } else if (k === 2) {
          opener.openTags.unshift('<strong>');
          closer.closeTags.push('</strong>');
        } else {
          opener.openTags.unshift('<em>');
          closer.closeTags.push('</em>');
        }
        spans.push([j, i]);
        opener.n -= k;
        closer.n -= k;
        if (opener.n > 0 && closer.n > 0) continue;
      }
      j--;
    }
  }
}

// Parse inline content into HTML (or plain text when plain is true) and
// push the result onto `out`. `refs` maps normalized labels to
// {href, title}.
function parseInline(text, refs, out, plain, noLinks) {
  const parts = [];
  const delims = [];
  const openers = [];
  let cur = '';
  const n = text.length;
  let i = 0;
  function flush() {
    if (cur) {
      parts.push(cur);
      cur = '';
    }
  }
  function renderDelim(d) {
    if (plain) return d.ch.repeat(d.n);
    return d.closeTags.join('') + d.ch.repeat(d.n) + d.openTags.join('');
  }
  function pushLinkOrImage(op, labelText, href, title, end) {
    // truncate everything recorded after the opener was pushed; the
    // label is re-parsed fresh from the source
    parts.length = op.partsLen;
    delims.length = op.delimsLen;
    cur = '';
    const childOut = [];
    // a link's label cannot contain another link: re-parse it with
    // link formation disabled (images use plain alt text instead)
    parseInline(labelText, refs, childOut, op.isImage ? true : plain, op.isImage ? false : true);
    const children = childOut.join('');
    const clean = href === null ? null : cleanHref(href);
    if (op.isImage) {
      if (plain) {
        parts.push(children);
      } else {
        const titleAttr = title ? ' title="' + escText(title) + '"' : '';
        parts.push('<img src="' + (clean === null ? '' : clean) + '" alt="' + escText(children) + '"' + titleAttr + '>');
      }
      const at = openers.indexOf(op);
      if (at >= 0) openers.splice(at, 1);
    } else {
      if (plain || clean === null) {
        parts.push(children);
      } else {
        const titleAttr = title ? ' title="' + escText(title) + '"' : '';
        parts.push('<a href="' + clean + '"' + titleAttr + '>' + children + '</a>');
      }
      const at = openers.indexOf(op);
      if (at >= 0) openers.splice(at, 1);
      // a link deactivates all earlier '[' openers (no link in a link)
      for (let k = 0; k < openers.length; k++) {
        if (!openers[k].isImage) openers[k].active = false;
      }
    }
    return end;
  }

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH) {
      if (i + 1 < n) {
        const d = text.charCodeAt(i + 1);
        if (d === NL) {
          flush();
          if (!plain) parts.push('<br>');
          i += 2;
          // leading spaces/tabs on the next line are dropped after a
          // hard break
          while (i < n && (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB)) i++;
          continue;
        }
        if (d === CR) {
          flush();
          if (!plain) parts.push('<br>');
          i += i + 2 < n && text.charCodeAt(i + 2) === NL ? 3 : 2;
          while (i < n && (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB)) i++;
          continue;
        }
        if (isAsciiPunct(d)) {
          cur += plain ? text[i + 1] : escChar(text[i + 1]);
          i += 2;
          continue;
        }
      }
      cur += '\\';
      i++;
      continue;
    }
    if (c === BACKTICK) {
      const r = runLen(text, i, BACKTICK);
      const close = findCodeClose(text, i + r, r);
      if (close < 0) {
        cur += '`'.repeat(r);
        i += r;
        continue;
      }
      let content = text.slice(i + r, close);
      content = content.replace(/\r\n|\r|\n/g, ' ');
      if (
        content.length >= 2 &&
        content.charCodeAt(0) === SPACE &&
        content.charCodeAt(content.length - 1) === SPACE &&
        /[^ ]/.test(content)
      ) {
        content = content.slice(1, -1);
      }
      flush();
      if (plain) parts.push(content);
      else parts.push('<code>' + escCode(content) + '</code>');
      i = close + r;
      continue;
    }
    if (c === STAR || c === UNDER) {
      const run = runLen(text, i, c);
      const before = i > 0 ? text.charCodeAt(i - 1) : -1;
      const after = i + run < n ? text.charCodeAt(i + run) : -1;
      const beforeWs = before < 0 || isUniWs(before);
      const afterWs = after < 0 || isUniWs(after);
      const beforePunct = before >= 0 && isPunct(before);
      const afterPunct = after >= 0 && isPunct(after);
      const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let canOpen;
      let canClose;
      if (c === STAR) {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      } else {
        canOpen = leftFlanking && (!rightFlanking || beforePunct);
        canClose = rightFlanking && (!leftFlanking || afterPunct);
      }
      flush();
      const d = {
        ch: c === STAR ? '*' : '_',
        n: run,
        open: canOpen,
        close: canClose,
        openTags: [],
        closeTags: [],
      };
      parts.push(d);
      delims.push(d);
      i += run;
      continue;
    }
    if (c === TILDE) {
      const run = runLen(text, i, TILDE);
      if (run >= 3) {
        cur += '~'.repeat(run);
        i += run;
        continue;
      }
      const before = i > 0 ? text.charCodeAt(i - 1) : -1;
      const after = i + run < n ? text.charCodeAt(i + run) : -1;
      flush();
      const d = {
        ch: '~',
        n: run,
        open: after >= 0 && !isUniWs(after),
        close: before >= 0 && !isUniWs(before),
        openTags: [],
        closeTags: [],
      };
      parts.push(d);
      delims.push(d);
      i += run;
      continue;
    }
    if (c === LBR) {
      if (noLinks) {
        cur += '[';
        i++;
        continue;
      }
      flush();
      openers.push({
        isImage: false,
        active: true,
        labelStart: i + 1,
        partsLen: parts.length,
        delimsLen: delims.length,
      });
      parts.push('[');
      i++;
      continue;
    }
    if (c === BANG && i + 1 < n && text.charCodeAt(i + 1) === LBR) {
      flush();
      openers.push({
        isImage: true,
        active: true,
        labelStart: i + 2,
        partsLen: parts.length,
        delimsLen: delims.length,
      });
      parts.push('![');
      i += 2;
      continue;
    }
    if (c === RBR) {
      let op = null;
      for (let k = openers.length - 1; k >= 0; k--) {
        if (openers[k].active) {
          op = openers[k];
          break;
        }
      }
      if (!op) {
        cur += ']';
        i++;
        continue;
      }
      const labelText = text.slice(op.labelStart, i);
      // A link/image label must have balanced brackets: an unmatched '['
      // inside the label (e.g. from a link that already formed and
      // deactivated its opener) blocks this ']' from matching the opener.
      if (!labelBalanced(labelText)) {
        cur += ']';
        i++;
        continue;
      }
      const after = i + 1;
      let dest = null;
      let title = null;
      let end = -1;
      let isRef = false;
      let refLabel = null;
      if (after < n && text.charCodeAt(after) === LPAR) {
        const tail = parseLinkTail(text, after);
        if (tail) {
          dest = tail.href;
          title = tail.title;
          end = tail.end;
        } else {
          // invalid inline-link tail: fall back to a shortcut reference
          // on the first label (e.g. [foo](not a link) with [foo]: /url)
          refLabel = labelText;
          end = i + 1;
          isRef = true;
        }
      } else if (after < n && text.charCodeAt(after) === LBR) {
        if (after + 1 < n && text.charCodeAt(after + 1) === RBR) {
          refLabel = labelText;
          end = after + 2;
          isRef = true;
        } else {
          const secondEnd = scanLabel(text, after);
          if (secondEnd >= 0) {
            refLabel = text.slice(after + 1, secondEnd);
            end = secondEnd + 1;
            isRef = true;
          } else {
            // no closing bracket for the second label: fall back to
            // a shortcut reference on the first label
            refLabel = labelText;
            end = i + 1;
            isRef = true;
          }
        }
      } else {
        refLabel = labelText;
        end = i + 1;
        isRef = true;
      }
      let href = null;
      let ttl = null;
      if (dest !== null) {
        href = dest;
        ttl = title;
      } else if (isRef) {
        const refKey = normalizeLabel(refLabel);
        const ref = refKey === '' ? undefined : refs.get(refKey);
        if (ref) {
          href = ref.href;
          ttl = ref.title;
        }
      }
      if (href === null) {
        op.active = false;
        cur += ']';
        i++;
        continue;
      }
      i = pushLinkOrImage(op, labelText, href, ttl, end);
      continue;
    }
    if (c === LANGLE) {
      const a = scanAngle(text, i);
      if (a) {
        flush();
        if (a.kind === 'link') {
          if (a.href === null || plain) {
            parts.push(plain ? a.text : escText(a.text));
          } else {
            parts.push('<a href="' + a.href + '">' + escText(a.text) + '</a>');
          }
        } else {
          parts.push(a.text);
          // track raw <a> / </a> for GFM autolink suppression
          const t = a.text;
          const lower = t.slice(0, 4).toLowerCase();
          if (lower === '</a>' || lower.startsWith('</a ') || lower.startsWith('</a\t') || lower.startsWith('</a\n')) {
            inRawAnchor = false;
          } else if (t.length >= 2 && (t[1] === 'a' || t[1] === 'A')) {
            const c2 = t.length > 2 ? t[2] : '';
            if (c2 === '>' || c2 === ' ' || c2 === '\t' || c2 === '\n' || c2 === '\r' || c2 === '/') {
              if (!t.endsWith('/>')) inRawAnchor = true;
            }
          }
        }
        i = a.end;
        continue;
      }
      cur += '&lt;';
      i++;
      continue;
    }
    if (c === NL || c === CR) {
      const nlLen = c === CR && i + 1 < n && text.charCodeAt(i + 1) === NL ? 2 : 1;
      // hard break: two or more spaces before the newline
      let sp = 0;
      while (sp < cur.length && cur.charCodeAt(cur.length - 1 - sp) === SPACE) sp++;
      if (sp >= 2) {
        cur = cur.slice(0, cur.length - sp);
        flush();
        if (!plain) parts.push('<br>');
        i += nlLen;
        // leading spaces/tabs on the next line are dropped after a
        // hard break
        while (i < n && (text.charCodeAt(i) === SPACE || text.charCodeAt(i) === TAB)) i++;
        continue;
      } else {
        flush();
        parts.push('\n');
        i += nlLen;
        continue;
      }
    }
    // ordinary text run (stops at the next special character)
    let j = i;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (
        d === BACKSLASH ||
        d === BACKTICK ||
        d === STAR ||
        d === UNDER ||
        d === TILDE ||
        d === LBR ||
        d === RBR ||
        d === LANGLE ||
        d === NL ||
        d === CR
      ) {
        break;
      }
      if (d === BANG && j + 1 < n && text.charCodeAt(j + 1) === LBR) break;
      j++;
    }
    // a GFM autolink (URL or email) may contain _ * ~, so let its scan
    // run past those soft delimiters up to the next hard boundary
    let j2 = j;
    while (j2 < n) {
      const d = text.charCodeAt(j2);
      if (
        d === BACKSLASH ||
        d === BACKTICK ||
        d === LBR ||
        d === RBR ||
        d === LANGLE ||
        d === NL ||
        d === CR
      ) {
        break;
      }
      if (d === BANG && j2 + 1 < n && text.charCodeAt(j2 + 1) === LBR) break;
      j2++;
    }
    // A GFM autolink never forms inside a link/image label: the label
    // is re-parsed when the link forms, and an autolink here would
    // swallow the closing ] and its tail.
    let hasActiveOpener = false;
    for (let k = 0; k < openers.length; k++) {
      if (openers[k].active) { hasActiveOpener = true; break; }
    }
    const link0 = noLinks || inRawAnchor || hasActiveOpener ? null : scanGfmAutolink(text, i, j2);
    // only use an autolink that starts within this run: one starting
    // past a _ * ~ delimiter must wait until that delimiter is
    // processed (otherwise emphasis before it would be swallowed)
    const link = link0 && link0.start <= j ? link0 : null;
    if (link) {
      if (link.start > i) {
        cur += plain ? plainTextRun(text.slice(i, link.start)) : escTextRun(text.slice(i, link.start));
      }
      flush();
      if (link.href === null) {
        parts.push(plain ? link.text : escText(link.text));
      } else if (plain) {
        parts.push(link.text);
      } else {
        parts.push('<a href="' + link.href + '">' + escText(link.text) + '</a>');
      }
      i = link.end;
      continue;
    }
    cur += plain ? plainTextRun(text.slice(i, j)) : escTextRun(text.slice(i, j));
    i = j;
  }
  flush();
  processEmphasis(delims);
  let html = '';
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    html += typeof p === 'string' ? p : renderDelim(p);
  }
  out.push(html);
}

// ------------------------------------------------------------ block parser

const T_DOC = 0;
const T_PARA = 1;
const T_HEAD = 2;
const T_CODE_F = 3;
const T_CODE_I = 4;
const T_HTML = 5;
const T_QUOTE = 6;
const T_LIST = 7;
const T_ITEM = 8;
const T_HR = 9;
const T_TABLE = 10;

// A cursor tracks a position inside one source line: `i` is the string
// index (pointing at a tab when pt > 0), `col` the visual column, `pt`
// the virtual spaces left from a partially consumed tab.
function curContent(c) {
  if (c.pt > 0) return ' '.repeat(c.pt) + c.s.slice(c.i + 1);
  return c.s.slice(c.i);
}
function curCode(c) {
  if (c.pt > 0) return SPACE;
  return c.i < c.s.length ? c.s.charCodeAt(c.i) : -1;
}
function curAdvance(c, n) {
  while (n > 0) {
    if (c.pt > 0) {
      const take = Math.min(n, c.pt);
      c.pt -= take;
      c.col += take;
      n -= take;
      if (c.pt === 0) c.i++;
      continue;
    }
    if (c.i >= c.s.length) return;
    const ch = c.s.charCodeAt(c.i);
    if (ch === TAB) {
      const w = 4 - (c.col % 4);
      if (w > n) {
        c.pt = w - n;
        c.col += n;
        n = 0;
      } else {
        c.i++;
        c.col += w;
        n -= w;
      }
    } else {
      c.i++;
      c.col++;
      n--;
    }
  }
}
function saveCursor(c) {
  return { s: c.s, i: c.i, col: c.col, pt: c.pt };
}
function restoreCursor(c, saved) {
  c.i = saved.i;
  c.col = saved.col;
  c.pt = saved.pt;
}
// Skip up to 3 columns of indentation. Returns false (cursor restored)
// when the indent is more than 3 columns.
function skipIndentUpTo3(c) {
  const saved = saveCursor(c);
  let indent = 0;
  while (indent < 3) {
    const ch = curCode(c);
    if (ch === SPACE) {
      curAdvance(c, 1);
      indent++;
      continue;
    }
    if (ch === TAB) {
      const w = 4 - (c.col % 4);
      if (indent + w > 3) {
        restoreCursor(c, saved);
        return false;
      }
      curAdvance(c, w);
      indent += w;
      continue;
    }
    break;
  }
  const ch = curCode(c);
  if (ch === SPACE || ch === TAB) {
    restoreCursor(c, saved);
    return false;
  }
  return true;
}
function isBlankLine(s) {
  // for the HTML trailing-newline rule, only a truly empty line
  // strips the newline; a whitespace-only line (spaces or a tab)
  // does not
  return s.length === 0;
}
// The content of a line after container prefixes, with the cursor's
// remaining indentation removed. Used for blank-line tests.
function curIsBlank(c) {
  // mid-tab: the rest of the tab is whitespace; blank when the remainder
  // of the line (after the tab) is also whitespace
  const start = c.pt > 0 ? c.i + 1 : c.i;
  for (let i = start; i < c.s.length; i++) {
    const ch = c.s.charCodeAt(i);
    if (ch !== SPACE && ch !== TAB) return false;
  }
  return true;
}

// HTML block type (1-7) for a line starting at the cursor. The cursor
// may be up to 3 columns of indent before the '<'. Returns 0 when it is
// not an HTML block start.
function htmlBlockType(c) {
  if (c.pt > 0) return 0;
  const s = c.s;
  // skip up to 3 columns of indent (without moving the cursor)
  let p = c.i;
  let col = c.col;
  let indent = 0;
  while (indent < 3 && p < s.length) {
    const ch = s.charCodeAt(p);
    if (ch === SPACE) {
      p++;
      col++;
      indent++;
      continue;
    }
    if (ch === TAB) {
      const w = 4 - (col % 4);
      if (indent + w > 3) break;
      p++;
      col += w;
      indent += w;
      continue;
    }
    break;
  }
  if (p < s.length && (s.charCodeAt(p) === SPACE || s.charCodeAt(p) === TAB)) return 0;
  if (p >= s.length || s.charCodeAt(p) !== LANGLE) return 0;
  if (s.startsWith('!--', p + 1)) return 2;
  if (p + 1 < s.length && s.charCodeAt(p + 1) === 63) return 3;
  if (p + 1 < s.length && s.charCodeAt(p + 1) === BANG) {
    if (p + 2 < s.length && isAlpha(s.charCodeAt(p + 2))) return 4;
    if (s.startsWith('<![CDATA[', p)) return 5;
    return 0;
  }
  // tag name (after an optional '/')
  let q = p + 1;
  let closing = false;
  if (q < s.length && s.charCodeAt(q) === 47) {
    closing = true;
    q++;
  }
  const nameStart = q;
  if (q >= s.length || !isAlpha(s.charCodeAt(q))) return 0;
  while (q < s.length && (isAlnum(s.charCodeAt(q)) || s.charCodeAt(q) === 45)) q++;
  const name = s.slice(nameStart, q).toLowerCase();
  // type 1: script, pre, style, textarea
  if (!closing && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    if (q >= s.length) return 1;
    const nx = s.charCodeAt(q);
    if (nx === SPACE || nx === TAB || nx === RANGLE) return 1;
    return 0;
  }
  if (HTML_TAG_NAMES.has(name)) {
    if (q >= s.length) return 6;
    const nx = s.charCodeAt(q);
    if (nx === SPACE || nx === TAB || nx === RANGLE || nx === 47) return 6;
    return 0;
  }
  // type 7: a complete open or close tag alone on the line
  const tag = matchHtmlTag(s, p);
  if (tag) {
    let r = tag.end;
    while (r < s.length && (s.charCodeAt(r) === SPACE || s.charCodeAt(r) === TAB)) r++;
    if (r >= s.length) return 7;
  }
  return 0;
}

// Does this line contain the end marker for an HTML block of the given
// type? (Types 1-5 end at the line containing their end marker.)
function htmlBlockEnds(line, type) {
  const low = line.toLowerCase();
  if (type === 1) {
    return (
      low.indexOf('</script') >= 0 ||
      low.indexOf('</pre') >= 0 ||
      low.indexOf('</style') >= 0 ||
      low.indexOf('</textarea') >= 0
    );
  }
  if (type === 2) return line.indexOf('-->') >= 0;
  if (type === 3) return line.indexOf('?>') >= 0;
  if (type === 4) return line.indexOf('>') >= 0;
  if (type === 5) return line.indexOf(']]>') >= 0;
  return false;
}

// Parse one link reference definition at the start of `text` (the
// paragraph's joined lines). Returns {label, href, title, rest} or null.
function parseRefDef(text, start) {
  const n = text.length;
  let p = start || 0;
  // a definition label may be indented up to 3 columns
  let indent = 0;
  while (p < n && text.charCodeAt(p) === 32) { p++; indent++; }
  if (indent > 3) return null;
  if (p >= n || text.charCodeAt(p) !== 91) return null;
  p++;
  const labelStart = p;
  // scan the label (no nested brackets; code spans protect ']';
  // a label may span lines)
  let labelEnd = -1;
  let depth = 0;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 92 && p + 1 < n && isAsciiPunct(text.charCodeAt(p + 1))) { p += 2; continue; }
    if (c === 96) { const r = scanCodeSpan(text, p); if (r < 0) return null; p = r; continue; }
    if (c === 91) { depth++; if (depth > 0) return null; p++; continue; }
    if (c === 93) { if (depth > 0) { depth--; p++; continue; } labelEnd = p; break; }
    p++;
  }
  if (labelEnd < 0) return null;
  const label = text.slice(labelStart, labelEnd);
  if (label.length > 999) return null;
  p = labelEnd + 1;
  // expect ':'
  if (p >= n || text.charCodeAt(p) !== 58) return null;
  p++;
  // destination
  const destStart = skipInlineWs(text, p);
  if (destStart < 0) return null;
  p = destStart;
  let href = null;
  if (p < n && text.charCodeAt(p) === 60) {
    let q = p + 1;
    while (q < n) {
      const c = text.charCodeAt(q);
      if (c === 62) { href = unescapeText(text.slice(p + 1, q)); p = q + 1; break; }
      if (c === 10 || c === 13) return null;
      if (c === 60) return null;
      q++;
    }
    if (href === null) return null;
  } else {
    let q = p;
    let parens = 0;
    while (q < n) {
      const c = text.charCodeAt(q);
      if (c === 32 || c === 9 || c === 10 || c === 13 || c < 32 || c === 127) break;
      if (c === 40) parens++;
      else if (c === 41) { if (parens === 0) break; parens--; }
      q++;
    }
    if (q === p) return null;
    if (parens !== 0) return null;
    href = unescapeText(text.slice(p, q));
    p = q;
  }
  // optional title; a title must be separated from the destination by
  // whitespace, and if it is followed by junk on its line the definition
  // has no title (backtrack to just after the destination)
  let title = null;
  let endPos = p;
  {
    const save = p;
    let tp = skipInlineWs(text, p);
    if (tp >= 0 && tp < n && tp > save &&
        (text.charCodeAt(tp) === 34 || text.charCodeAt(tp) === 39 || text.charCodeAt(tp) === 40)) {
      const open = text.charCodeAt(tp);
      const close = open === 40 ? 41 : open;
      let q = tp + 1;
      let ok = false;
      let titleEnd = -1;
      while (q < n) {
        const c = text.charCodeAt(q);
        if (c === 92 && q + 1 < n && isAsciiPunct(text.charCodeAt(q + 1))) { q += 2; continue; }
        if (c === close) { ok = true; titleEnd = q; break; }
        if (c === 10 || c === 13) {
          // a title may span lines, but not across a blank line
          const nlEnd = c === 13 && q + 1 < n && text.charCodeAt(q + 1) === 10 ? q + 2 : q + 1;
          let r = nlEnd;
          while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9)) r++;
          if (r < n && (text.charCodeAt(r) === 10 || text.charCodeAt(r) === 13)) { ok = false; break; }
          q = nlEnd;
          continue;
        }
        q++;
      }
      if (ok) {
        let tq = titleEnd + 1;
        while (tq < n && (text.charCodeAt(tq) === 32 || text.charCodeAt(tq) === 9)) tq++;
        if (tq >= n || text.charCodeAt(tq) === 10 || text.charCodeAt(tq) === 13) {
          title = unescapeText(text.slice(tp + 1, titleEnd));
          endPos = tq;
        }
      }
    }
  }
  // after the destination (or the title) only spaces/tabs may follow on
  // its line; the definition ends at that line ending
  let q = endPos;
  while (q < n && (text.charCodeAt(q) === 32 || text.charCodeAt(q) === 9)) q++;
  if (q < n && text.charCodeAt(q) !== 10 && text.charCodeAt(q) !== 13) return null;
  let rest = '';
  if (q < n) {
    let r = q;
    if (text.charCodeAt(r) === 13 && r + 1 < n && text.charCodeAt(r + 1) === 10) r += 2;
    else r++;
    rest = text.slice(r);
  }
  return { label, href, title, rest };
}

// Strip leading reference definitions from a paragraph's text, adding
// them to `refs` (first definition wins). Returns the remaining text.
function extractRefDefs(text, refs) {
  let rest = text;
  for (;;) {
    const def = parseRefDef(rest);
    if (!def) break;
    const key = normalizeLabel(def.label);
    // an empty / whitespace-only label is not a valid definition
    if (key === '') break;
    if (!refs.has(key)) refs.set(key, { href: def.href, title: def.title });
    rest = def.rest;
    if (rest.length === 0) break;
  }
  return rest;
}

// Parse a list item marker at the cursor (already past up to 3 spaces).
// Returns {ordered, start, bullet, markerLen, contentCol, contentIndent}
// or null. `contentCol` is the absolute column where the item's content
// starts; `contentIndent` is the same distance measured in columns from
// the marker start, so it stays valid when a later line's container
// prefixes are narrower or wider than the marker line's.
function parseListMarker(c) {
  const s = c.s;
  const startCol = c.col;
  const ch = curCode(c);
  if (ch === 45 || ch === 43 || ch === 42) {
    // bullet
    const bullet = String.fromCharCode(ch);
    curAdvance(c, 1);
    const contentCol = listContentCol(c, startCol + 1);
    if (contentCol < 0) return null;
    return { ordered: false, start: 1, bullet, markerLen: 1, contentCol, contentIndent: contentCol - startCol };
  }
  if (isDigit(ch)) {
    let p = c.i;
    let digits = 0;
    let val = 0;
    while (p < s.length && isDigit(s.charCodeAt(p)) && digits < 9) {
      val = val * 10 + (s.charCodeAt(p) - 48);
      digits++;
      p++;
    }
    if (digits === 0) return null;
    if (p >= s.length) return null;
    const d = s.charCodeAt(p);
    if (d !== 46 && d !== 41) return null;
    const delim = String.fromCharCode(d);
    // advance past the digits and delimiter
    curAdvance(c, digits + 1);
    const contentCol = listContentCol(c, startCol + digits + 1);
    if (contentCol < 0) return null;
    return { ordered: true, start: val, bullet: delim, markerLen: digits + 1, contentCol, contentIndent: contentCol - startCol };
  }
  return null;
}

// After a list marker, find the content column: skip 1-4 columns of
// whitespace; if there are 5 or more, the content starts one column
// after the marker. Returns the content column, or -1 when there is no
// content on this line (empty item: content column = marker width + 1).
function listContentCol(c, markerEndCol) {
  const saved = saveCursor(c);
  let spaces = 0;
  for (;;) {
    const ch = curCode(c);
    if (ch === SPACE || ch === TAB) {
      // count columns until the next non-space
      const before = c.col;
      curAdvance(c, 1);
      spaces += c.col - before;
      if (spaces > 4) {
        // 5+ spaces: content indent is marker width + 1
        restoreCursor(c, saved);
        curAdvance(c, 1);
        return markerEndCol + 1;
      }
      continue;
    }
    break;
  }
  if (spaces === 0) {
    // no space after the marker: only valid at end of line (empty item)
    if (curCode(c) === -1) return markerEndCol + 1;
    return -1;
  }
  // an item with only spaces after the marker is empty: its content
  // indent is marker width + 1
  if (curCode(c) === -1) return markerEndCol + 1;
  return c.col;
}

// ------------------------------------------------------------ table helpers

// Split a table line on unescaped '|' (naively: code spans do not protect
// pipes). Returns the cell strings, dropping an empty leading/trailing
// cell that comes from a leading/trailing pipe.
function splitTableCells(line) {
  // Split a table line on unescaped '|' (naively: code spans do not
  // protect pipes). '\\|' becomes a literal '|' in the cell.
  // Returns the cell strings, dropping an empty leading/trailing cell
  // that comes from a leading/trailing pipe.
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n && line.charCodeAt(i + 1) === 124) {
      cur += '|';
      i += 2;
      continue;
    }
    if (c === 124) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  cells.push(cur);
  // a leading/trailing pipe produces an empty first/last cell: drop it
  // (the cell may hold only the whitespace around the pipe)
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''));
}

// Parse a table delimiter line. Returns the alignments ('left', 'center',
// 'right' or null) or null when the line is not a delimiter.
function parseTableDelimiter(line) {
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (let k = 0; k < cells.length; k++) {
    const cell = cells[k].trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    if (cell.charCodeAt(0) === 58 && cell.charCodeAt(cell.length - 1) === 58) aligns.push('center');
    else if (cell.charCodeAt(0) === 58) aligns.push('left');
    else if (cell.charCodeAt(cell.length - 1) === 58) aligns.push('right');
    else aligns.push(null);
  }
  return aligns;
}

// ------------------------------------------------------------ the block parser

function parseBlocks(src, refs) {
  const lines = src.split(/\r\n|\r|\n/);
  if (src.length > 0 && (src.charCodeAt(src.length - 1) === NL || src.charCodeAt(src.length - 1) === CR)) lines.pop();
  const root = { t: T_DOC, children: [] };
  const containers = [root];
  let leaf = null;
  const htmlNodes = [];

  function addBlock(node) {
    const tip = containers[containers.length - 1];
    if (tip.t === T_ITEM) {
      const list = tip.list;
      if (list.sawBlank) {
        list.tight = false;
        list.sawBlank = false;
      }
    } else if (tip.t === T_LIST) {
      if (tip.sawBlank) {
        tip.tight = false;
        tip.sawBlank = false;
      }
    }
    // a blank line is consumed by the first block added after it:
    // ancestor lists must not go loose from it later
    for (let k = 1; k < containers.length; k++) {
      const cc = containers[k];
      if (cc.t === T_ITEM && cc.list) cc.list.sawBlank = false;
      if (cc.t === T_LIST) cc.sawBlank = false;
    }
    tip.children.push(node);
    return node;
  }
  function closeLeaf() {
    if (!leaf) return;
    if (leaf.t === T_PARA) {
      const text = leaf.lines.join('\n');
      const rest = extractRefDefs(text, refs);
      if (rest === '') {
        const tip = containers[containers.length - 1];
        const idx = tip.children.indexOf(leaf);
        if (idx >= 0) tip.children.splice(idx, 1);
      } else {
        leaf.text = rest;
      }
      leaf.lines = null;
    } else if (leaf.t === T_CODE_I) {
      // strip trailing blank lines
      while (leaf.lines.length > 0 && leaf.lines[leaf.lines.length - 1] === '') leaf.lines.pop();
      leaf.text = leaf.lines.length === 0 ? '' : leaf.lines.join('\n') + '\n';
      leaf.lines = null;
    } else if (leaf.t === T_CODE_F) {
      leaf.text = leaf.lines.length === 0 ? '' : leaf.lines.join('\n') + '\n';
      leaf.lines = null;
    } else if (leaf.t === T_HTML) {
      leaf.text = leaf.lines.join('\n');
      leaf.lines = null;
      htmlNodes.push(leaf);
    } else if (leaf.t === T_TABLE) {
      leaf.lines = null;
    }
    leaf = null;
  }
  function closeTo(depth) {
    closeLeaf();
    while (containers.length > depth) containers.pop();
  }
  // Advance the cursor to a target column using only spaces/tabs.
  // Returns false (cursor restored) when the line ends or a non-space
  // character appears before the target.
  function advanceToCol(c, targetCol) {
    // already past the target column: cannot match
    if (c.col > targetCol) return false;
    const saved = saveCursor(c);
    while (c.col < targetCol) {
      const ch = curCode(c);
      if (ch === -1 || (ch !== SPACE && ch !== TAB)) {
        restoreCursor(c, saved);
        return false;
      }
      curAdvance(c, 1);
    }
    return true;
  }
  // Is this line a closing fence for the open fenced code block?
  function isClosingFence(c, fenceChar, fenceLen) {
    const saved = saveCursor(c);
    if (!skipIndentUpTo3(c)) {
      restoreCursor(c, saved);
      return false;
    }
    const run = runLen(c.s, c.i, fenceChar);
    if (run < fenceLen || c.pt > 0) {
      restoreCursor(c, saved);
      return false;
    }
    let p = c.i + run;
    while (p < c.s.length && (c.s.charCodeAt(p) === SPACE || c.s.charCodeAt(p) === TAB)) p++;
    if (p < c.s.length) {
      restoreCursor(c, saved);
      return false;
    }
    return true;
  }
  // Does the line (at the cursor) start a fenced code block? Returns
  // {fenceChar, fenceLen, lang, indent} or null.
  function parseFence(c) {
    const saved = saveCursor(c);
    const colBefore = c.col;
    if (!skipIndentUpTo3(c)) {
      restoreCursor(c, saved);
      return null;
    }
    const indent = c.col - colBefore;
    const ch = curCode(c);
    if (ch !== BACKTICK && ch !== TILDE) {
      restoreCursor(c, saved);
      return null;
    }
    const run = runLen(c.s, c.i, ch);
    if (run < 3) {
      restoreCursor(c, saved);
      return null;
    }
    // a backtick fence's info string may not contain backticks
    const info = c.s.slice(c.i + run);
    if (ch === BACKTICK && info.indexOf('`') >= 0) {
      restoreCursor(c, saved);
      return null;
    }
    const lang = unescapeBackslash(info.trim().split(/\s+/)[0] || '');
    return { fenceChar: ch, fenceLen: run, lang, indent };
  }
  // ATX heading at the cursor. Returns {level, text} or null.
  function parseAtx(c) {
    const saved = saveCursor(c);
    if (!skipIndentUpTo3(c)) {
      restoreCursor(c, saved);
      return null;
    }
    let level = 0;
    while (curCode(c) === 35 && level < 6) {
      curAdvance(c, 1);
      level++;
    }
    if (level === 0 || level > 6) {
      restoreCursor(c, saved);
      return null;
    }
    const after = curCode(c);
    if (after !== -1 && after !== SPACE && after !== TAB) {
      restoreCursor(c, saved);
      return null;
    }
    // the text after the hashes, including its leading spaces: a closing
    // sequence may be the whole content (e.g. '### ###' -> empty)
    let text = curContent(c);
    const m = text.match(/^(.*?)[ \t]+#+[ \t]*$/);
    if (m) text = m[1];
    text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    return { level, text };
  }
  // Thematic break at the cursor?
  function isThematicBreak(c) {
    const saved = saveCursor(c);
    if (!skipIndentUpTo3(c)) {
      restoreCursor(c, saved);
      return false;
    }
    const ch = curCode(c);
    if (ch !== 45 && ch !== 95 && ch !== 42) {
      restoreCursor(c, saved);
      return false;
    }
    let count = 0;
    let p = c.i;
    while (p < c.s.length) {
      const d = c.s.charCodeAt(p);
      if (d === ch) {
        count++;
        p++;
      } else if (d === SPACE || d === TAB) {
        p++;
      } else {
        restoreCursor(c, saved);
        return false;
      }
    }
    const ok = count >= 3;
    restoreCursor(c, saved);
    return ok;
  }
  // Setext underline at the cursor? Returns 1 (=), 2 (-) or 0.
  // The underline characters must be contiguous (no spaces between them).
  function parseSetext(c) {
    const saved = saveCursor(c);
    if (!skipIndentUpTo3(c)) {
      restoreCursor(c, saved);
      return 0;
    }
    const ch = curCode(c);
    if (ch !== 61 && ch !== 45) {
      restoreCursor(c, saved);
      return 0;
    }
    while (curCode(c) === ch) curAdvance(c, 1);
    while (curCode(c) === SPACE || curCode(c) === TAB) curAdvance(c, 1);
    if (curCode(c) !== -1) {
      restoreCursor(c, saved);
      return 0;
    }
    restoreCursor(c, saved);
    return ch === 61 ? 1 : 2;
  }

  // Does the line at the cursor start a block that can interrupt a
  // paragraph? (Decides whether a line is a lazy continuation.)
  function startsInterruptBlock(c) {
    const saved = saveCursor(c);
    if (parseFence(c)) {
      restoreCursor(c, saved);
      return true;
    }
    restoreCursor(c, saved);
    if (parseAtx(c)) {
      restoreCursor(c, saved);
      return true;
    }
    restoreCursor(c, saved);
    if (isThematicBreak(c)) return true;
    const hb = htmlBlockType(c);
    if (hb > 0 && hb <= 6) return true;
    const s2 = saveCursor(c);
    if (skipIndentUpTo3(c)) {
      const marker = parseListMarker(c);
      if (marker) {
        const empty = curIsBlank(c);
        const startsOne = !marker.ordered || marker.start === 1;
        restoreCursor(c, saved);
        if (!empty && startsOne) return true;
        return false;
      }
    }
    restoreCursor(c, saved);
    return false;
  }

  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const cur = { s: line, i: 0, col: 0, pt: 0 };

    // ---- phase 1: match open containers ----
    let matched = 1;
    let newItem = null;
    for (let ci = 1; ci < containers.length; ci++) {
      const cont = containers[ci];
      if (cont.t === T_QUOTE) {
        if (curIsBlank(cur)) {
          // a blank line keeps the quote open only when it carries
          // the '>' marker; a bare blank line closes the quote
          if (curCode(cur) === 62) {
            curAdvance(cur, 1);
            const cc = curCode(cur);
            if (cc === 32 || cc === 9) curAdvance(cur, 1);
            continue;
          }
          break;
        }
        const saved = saveCursor(cur);
        if (!skipIndentUpTo3(cur) || curCode(cur) !== RANGLE) {
          restoreCursor(cur, saved);
          break;
        }
        curAdvance(cur, 1);
        if (curCode(cur) === SPACE || curCode(cur) === TAB) curAdvance(cur, 1);
        matched = ci + 1;
      } else if (cont.t === T_ITEM) {
        if (curIsBlank(cur)) {
          // advance to the content column when the line reaches it, so
          // a code block's blank-line content is measured correctly
          advanceToCol(cur, cont.contentCol);
          matched = ci + 1;
          continue;
        }
        // The content column is absolute.
        if (advanceToCol(cur, cont.contentCol)) {
          matched = ci + 1;
          continue;
        }
        // Inside a fenced code block that already has content, a line
        // stays in the item (as code content) even when it is not
        // indented to the content column; but when the code block is
        // still empty, an unindented line closes the item instead
        // (it becomes a paragraph outside the list).
        if (leaf && leaf.t === T_CODE_F && leaf.lines && leaf.lines.length > 0) {
          matched = ci + 1;
          continue;
        }
        // try a new item of the same list (but a thematic break line
        // is not a list item, even when it looks like one)
        const saved = saveCursor(cur);
        const list = cont.list;
        let marker = null;
        if (!isThematicBreak(cur) && skipIndentUpTo3(cur)) marker = parseListMarker(cur);
        if (marker && marker.ordered === list.ordered && marker.bullet === list.bullet) {
          newItem = { list, marker, depth: ci };
          matched = ci;
          break;
        }
        restoreCursor(cur, saved);
        break;
      } else {
        break;
      }
    }

    // ---- a new item continues the list ----
    if (newItem) {
      if (leaf && leaf.t === T_HTML) leaf.endedByContainer = true;
      closeTo(newItem.depth);
      const item = { t: T_ITEM, children: [], contentCol: newItem.marker.contentCol, contentIndent: newItem.marker.contentIndent, list: newItem.list };
      newItem.list.children.push(item);
      containers.push(item);
      if (curIsBlank(cur)) continue;
      // fall through to the block-start checks inside the new item
    } else if (matched < containers.length) {
      // a list marker line is never a lazy continuation of a paragraph
      // inside a list item: once the item closes it starts a new list
      let isListMarkerLine = false;
      {
        const tipC = containers[containers.length - 1];
        if (tipC && tipC.t === T_ITEM) {
          const sv = saveCursor(cur);
          if (skipIndentUpTo3(cur) && parseListMarker(cur)) isListMarkerLine = true;
          restoreCursor(cur, sv);
        }
      }
      if (leaf && leaf.t === T_PARA && !curIsBlank(cur) && !startsInterruptBlock(cur) && !isListMarkerLine) {
        // a lazy continuation line loses 4 columns of leading
        // indentation when it has at least 4 columns of it
        const startCol = cur.col;
        const save = saveCursor(cur);
        while (cur.col - startCol < 4 && (curCode(cur) === 32 || curCode(cur) === 9)) {
          curAdvance(cur, 1);
        }
        const strippedCols = cur.col - startCol;
        if (strippedCols < 4) restoreCursor(cur, save);
        const content = curContent(cur);
        if (strippedCols === 0 && parseSetext(cur) > 0 && content.length > 0 && content.charCodeAt(0) !== 32 && content.charCodeAt(0) !== 9) {
          // a setext underline as a lazy line is indented by 4 spaces
          leaf.lines.push('    ' + content);
        } else {
          leaf.lines.push(content);
        }
        continue;
      }
      if (leaf && leaf.t === T_HTML) leaf.endedByContainer = true;
      closeTo(matched);
    }

    // ---- blank line ----
    if (curIsBlank(cur)) {
      // a line carrying a '>' marker whose remainder is non-empty
      // whitespace is paragraph content, not a blank line
      if (leaf && leaf.t === T_PARA) {
        const raw = lines[ln];
        let ri = 0;
        while (ri < raw.length && raw.charCodeAt(ri) === 32 && ri < 3) ri++;
        if (ri < raw.length && raw.charCodeAt(ri) === 62) {
          const rem = curContent(cur);
          if (rem.length > 0) {
            leaf.lines.push(rem);
            continue;
          }
        }
      }
      if (leaf && leaf.t === T_CODE_F) {
        // a blank line inside fenced code keeps its whitespace (after
        // the fence indent is stripped)
        const startCol = cur.col;
        while (cur.col - startCol < leaf.fenceIndent && (curCode(cur) === SPACE || curCode(cur) === TAB)) {
          curAdvance(cur, 1);
        }
        // a leading tab not on a 4-column boundary expands to spaces
        let fcontent = curContent(cur);
        if (curCode(cur) === TAB && cur.col % 4 !== 0) {
          const w = 4 - (cur.col % 4);
          fcontent = ' '.repeat(w) + fcontent.slice(1);
        }
        leaf.lines.push(fcontent);
        leaf.lastLine = ln;
        continue;
      }
      if (leaf && leaf.t === T_HTML && leaf.htmlType <= 5) {
        leaf.lines.push(curContent(cur));
        leaf.lastLine = ln;
        continue;
      }
      if (leaf && leaf.t === T_CODE_I) {
        // a blank line inside indented code keeps its whitespace
        // (after 4 columns of indent are stripped)
        const startCol = cur.col;
        while (cur.col - startCol < 4 && (curCode(cur) === SPACE || curCode(cur) === TAB)) {
          curAdvance(cur, 1);
        }
        leaf.lines.push(curContent(cur));
        continue;
      }
      if (leaf && leaf.t === T_TABLE) {
        // a blank line that carries a TAB is a table row (empty
        // cells), not the end of the table; a truly empty or
        // space-only line ends the table
        if (curContent(cur).indexOf('\t') >= 0) {
          leaf.rows.push(splitTableCells(curContent(cur)));
          continue;
        }
        closeLeaf();
      } else if (leaf && leaf.t === T_HTML) {
        // types 6-7 end at a blank line
        closeLeaf();
      } else if (leaf) {
        closeLeaf();
      }
      // a blank line inside a list marks every ancestor list, so that
      // a following block makes each of them loose -- but stop at a
      // non-list container (e.g. a blank line inside a blockquote
      // does not separate blocks of the outer list)
      for (let k = containers.length - 1; k >= 1; k--) {
        const cc = containers[k];
        if (cc.t === T_ITEM && cc.list) cc.list.sawBlank = true;
        else if (cc.t === T_LIST) cc.sawBlank = true;
        else break;
      }
      // an empty list item followed by a blank line is closed: it
      // takes no further content
      while (containers.length > 1) {
        const tipC = containers[containers.length - 1];
        if (tipC.t === T_ITEM && tipC.children.length === 0) {
          containers.pop();
        } else {
          break;
        }
      }
      continue;
    }

    // ---- the open leaf consumes the line ----
    if (leaf && leaf.t === T_CODE_F) {
      if (isClosingFence(cur, leaf.fenceChar, leaf.fenceLen)) {
        // one trailing blank line before the closing fence is dropped,
        // but only when it is exactly empty (a line holding spaces is
        // kept)
        if (leaf.lines.length > 0 && leaf.lines[leaf.lines.length - 1] === '') {
          leaf.lines.pop();
        }
        closeLeaf();
        continue;
      }
      // strip the opening fence's indent from the content line
      const startCol = cur.col;
      while (cur.col - startCol < leaf.fenceIndent && (curCode(cur) === SPACE || curCode(cur) === TAB)) {
        curAdvance(cur, 1);
      }
      // a leading tab expands to spaces to the next 4-column stop
      // when it sits past the fence indent; a tab at or before the
      // fence indent is kept as a tab. The column used for the tab
      // stop is the effective column: each blockquote level beyond
      // the first costs 2 fewer columns (a tab right after '> > '
      // expands as if it were at column 2, not 4).
      let fcontent = curContent(cur);
      if (curCode(cur) === TAB) {
        let quoteDepth = 0;
        for (let q = 0; q < containers.length; q++) if (containers[q].t === T_QUOTE) quoteDepth++;
        const effCol = cur.col - 2 * Math.max(0, quoteDepth - 1);
        if (effCol > leaf.fenceIndent) {
          const w = 4 - (effCol % 4);
          fcontent = ' '.repeat(w) + fcontent.slice(1);
        }
      }
      leaf.lines.push(fcontent);
      continue;
    }
    if (leaf && leaf.t === T_HTML) {
      if (leaf.htmlType <= 5) {
        const content = curContent(cur);
        leaf.lines.push(content);
        leaf.lastLine = ln;
        if (htmlBlockEnds(content, leaf.htmlType)) {
          closeLeaf();
        }
        continue;
      }
      leaf.lines.push(curContent(cur));
      leaf.lastLine = ln;
      continue;
    }
    if (leaf && leaf.t === T_CODE_I) {
      // indented code: 4+ columns of indent (relative to the container)
      // continue it; anything else closes the block
      const saved = saveCursor(cur);
      const startCol = cur.col;
      while (cur.col - startCol < 4 && (curCode(cur) === SPACE || curCode(cur) === TAB)) {
        curAdvance(cur, 1);
      }
      if (cur.col - startCol >= 4) {
        leaf.lines.push(curContent(cur));
        continue;
      }
      restoreCursor(cur, saved);
      closeLeaf();
      // fall through to the block-start checks
    }
    if (leaf && leaf.t === T_TABLE) {
      // a table row, unless the line starts a new block
      const saved = saveCursor(cur);
      const fence = parseFence(cur);
      restoreCursor(cur, saved);
      const atx = parseAtx(cur);
      const hb = htmlBlockType(cur);
      const tb = isThematicBreak(cur);
      let listStart = null;
      {
        const s2 = saveCursor(cur);
        if (skipIndentUpTo3(cur)) listStart = parseListMarker(cur);
        restoreCursor(cur, s2);
      }
      const isQuote = (() => {
        const s2 = saveCursor(cur);
        const ok = skipIndentUpTo3(cur) && curCode(cur) === RANGLE;
        restoreCursor(cur, s2);
        return ok;
      })();
      if (fence || atx || hb || tb || listStart || isQuote) {
        closeLeaf();
        // fall through to the block-start checks
      } else {
        leaf.rows.push(splitTableCells(curContent(cur)));
        continue;
      }
    }

    // ---- phase 2: new block starts ----
    // setext heading / table delimiter (only inside a paragraph)
    if (leaf && leaf.t === T_PARA) {
      const level = parseSetext(cur);
      if (level > 0) {
      const text = leaf.lines.join('\n');
      const rest = extractRefDefs(text, refs);
      if (rest === '') {
        // the paragraph is only reference definitions: this line is not
        // a setext underline, it is paragraph text
        leaf.lines.push(curContent(cur));
        continue;
      }
      const tip = containers[containers.length - 1];
      const idx = tip.children.indexOf(leaf);
      if (idx >= 0) tip.children.splice(idx, 1);
      leaf = null;
      const headingText = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      if (headingText !== '') addBlock({ t: T_HEAD, level, text: headingText });
      continue;
    }
      const aligns = (() => {
        const s2 = saveCursor(cur);
        let a = null;
        if (skipIndentUpTo3(cur)) a = parseTableDelimiter(curContent(cur));
        restoreCursor(cur, s2);
        return a;
      })();
      if (aligns) {
        const headCells = splitTableCells(leaf.lines[leaf.lines.length - 1]);
        if (headCells.length === aligns.length) {
          leaf.lines.pop();
          if (leaf.lines.length === 0) {
            const tip = containers[containers.length - 1];
            const idx = tip.children.indexOf(leaf);
            if (idx >= 0) tip.children.splice(idx, 1);
          } else {
            const text = leaf.lines.join('\n');
            const rest = extractRefDefs(text, refs);
            if (rest === '') {
              const tip = containers[containers.length - 1];
              const idx = tip.children.indexOf(leaf);
              if (idx >= 0) tip.children.splice(idx, 1);
            } else {
              leaf.text = rest;
            }
            leaf.lines = null;
          }
          leaf = null;
          const table = { t: T_TABLE, aligns, head: headCells, rows: [] };
          addBlock(table);
          leaf = table;
          continue;
        }
      }
    }
    // The checks below can open a container (list item / blockquote), in
    // which case the rest of the line is re-checked as a new block.
    let consumed = false;
    for (let guard = 0; guard < 8; guard++) {
      const fence = parseFence(cur);
      if (fence) {
        closeLeaf();
        const node = {
          t: T_CODE_F,
          lang: fence.lang,
          fenceChar: fence.fenceChar,
          fenceLen: fence.fenceLen,
          fenceIndent: fence.indent,
          lines: [],
        };
        addBlock(node);
        leaf = node;
        consumed = true;
        break;
      }
      const atx = parseAtx(cur);
      if (atx) {
        closeLeaf();
        addBlock({ t: T_HEAD, level: atx.level, text: atx.text });
        consumed = true;
        break;
      }
      const hbType = htmlBlockType(cur);
      if (hbType > 0 && (hbType <= 6 || !leaf || leaf.t !== T_PARA)) {
        closeLeaf();
        const node = { t: T_HTML, htmlType: hbType, lines: [curContent(cur)], lastLine: ln };
        addBlock(node);
        leaf = node;
        if (hbType <= 5 && htmlBlockEnds(curContent(cur), hbType)) {
          closeLeaf();
        }
        consumed = true;
        break;
      }
      if (isThematicBreak(cur)) {
        closeLeaf();
        addBlock({ t: T_HR });
        consumed = true;
        break;
      }
      // list item
      {
        const saved = saveCursor(cur);
        let marker = null;
        if (skipIndentUpTo3(cur)) marker = parseListMarker(cur);
        if (marker) {
          let canInterrupt = true;
          if (leaf && leaf.t === T_PARA) {
            if (curIsBlank(cur)) canInterrupt = false;
            // inside a list item, any ordered list may start a nested list
            const tipC = containers[containers.length - 1];
            const inItem = tipC && tipC.t === T_ITEM;
            if (marker.ordered && marker.start !== 1 && !inItem) canInterrupt = false;
          }
          if (canInterrupt) {
            closeLeaf();
            const tip = containers[containers.length - 1];
            let list = null;
            const last = tip.children[tip.children.length - 1];
            if (last && last.t === T_LIST && last.ordered === marker.ordered && last.bullet === marker.bullet && !last.closed) {
              list = last;
            }
            if (!list) {
              list = {
                t: T_LIST,
                ordered: marker.ordered,
                start: marker.start,
                bullet: marker.bullet,
                tight: true,
                sawBlank: false,
                closed: false,
                children: [],
              };
              addBlock(list);
            }
            const item = { t: T_ITEM, children: [], contentCol: marker.contentCol, contentIndent: marker.contentIndent, list };
            list.children.push(item);
            containers.push(item);
            if (curIsBlank(cur)) {
              consumed = true;
              break;
            }
            continue;
          }
        }
        restoreCursor(cur, saved);
      }
      // blockquote
      {
        const saved = saveCursor(cur);
        if (skipIndentUpTo3(cur) && curCode(cur) === RANGLE) {
          curAdvance(cur, 1);
          if (curCode(cur) === SPACE || curCode(cur) === TAB) curAdvance(cur, 1);
          closeLeaf();
          const node = { t: T_QUOTE, children: [] };
          addBlock(node);
          containers.push(node);
          if (curIsBlank(cur)) {
            consumed = true;
            break;
          }
          continue;
        }
        restoreCursor(cur, saved);
      }
      // indented code (only when not in a paragraph)
      if (!leaf || leaf.t !== T_PARA) {
        const saved = saveCursor(cur);
        const startCol = cur.col;
        while (cur.col - startCol < 4 && (curCode(cur) === SPACE || curCode(cur) === TAB)) {
          curAdvance(cur, 1);
        }
        if (cur.col - startCol >= 4) {
          const node = { t: T_CODE_I, lines: [curContent(cur)] };
          addBlock(node);
          leaf = node;
          consumed = true;
          break;
        }
        restoreCursor(cur, saved);
      }
      // no block start: paragraph text
      break;
    }
    if (consumed) continue;
    // paragraph (start or continue)
    if (leaf && leaf.t === T_PARA) {
      leaf.lines.push(curContent(cur));
    } else {
      closeLeaf();
      const node = { t: T_PARA, lines: [curContent(cur)] };
      addBlock(node);
      leaf = node;
    }
  }

  closeLeaf();
  // HTML block trailing-newline rule: strip the trailing newline when the
  // line right after the block is blank.
  const srcEndsNL = src.length > 0 && (src.charCodeAt(src.length - 1) === 10 || src.charCodeAt(src.length - 1) === 13);
  for (let k = 0; k < htmlNodes.length; k++) {
    const node = htmlNodes[k];
    const after = (node.lastLine === undefined ? -1 : node.lastLine) + 1;
    node.endedByBlank = after < lines.length && isBlankLine(lines[after]);
    // an HTML block ending at EOF without a trailing newline in the
    // source takes no trailing newline in the output
    if (!srcEndsNL && node.lastLine === lines.length - 1) node.endedByContainer = true;
  }
  return root;
}

// ------------------------------------------------------------ renderer

function renderItem(item, list, refs, out) {
  const tight = list.tight;
  const children = item.children;
  out.push('<li>');
  let firstIsTask = false;
  let taskChecked = false;
  let taskRest = null;
  if (children.length > 0 && children[0].t === T_PARA) {
    const text = children[0].text;
    const m = /^\[( |x|X)\] /.exec(text);
    if (m && /\S/.test(text.slice(m[0].length))) {
      firstIsTask = true;
      taskChecked = m[1] === 'x' || m[1] === 'X';
      taskRest = text.slice(m[0].length);
    }
  }
  for (let k = 0; k < children.length; k++) {
    const child = children[k];
    const isLast = k === children.length - 1;
    if (k === 0 && firstIsTask) {
      const html = [];
      parseInline(taskRest, refs, html, false);
      const checkbox = taskChecked
        ? '<input checked="" disabled="" type="checkbox">'
        : '<input disabled="" type="checkbox">';
      if (tight) {
        out.push(checkbox + ' ' + html.join(''));
      } else {
        out.push('<p>' + checkbox + ' ' + html.join('') + '</p>\n');
      }
      continue;
    }
    if (tight && child.t === T_PARA) {
      const html = [];
      parseInline(child.text, refs, html, false);
      out.push(html.join(''));
      continue;
    }
    renderBlocks(child, refs, out);
  }
  out.push('</li>\n');
}

function renderBlocks(node, refs, out) {
  switch (node.t) {
    case T_DOC:
      for (let k = 0; k < node.children.length; k++) renderBlocks(node.children[k], refs, out);
      break;
    case T_PARA: {
      const html = [];
      parseInline(node.text, refs, html, false);
      out.push('<p>' + html.join('') + '</p>\n');
      break;
    }
    case T_HEAD: {
      const html = [];
      parseInline(node.text, refs, html, false);
      out.push('<h' + node.level + '>' + html.join('') + '</h' + node.level + '>\n');
      break;
    }
    case T_CODE_F: {
      const langAttr = node.lang ? ' class="language-' + escText(node.lang) + '"' : '';
      const body = node.text;
      out.push('<pre><code' + langAttr + '>' + escCode(body) + '</code></pre>\n');
      break;
    }
    case T_CODE_I: {
      const body = node.text;
      out.push('<pre><code>' + escCode(body) + '</code></pre>\n');
      break;
    }
    case T_HTML: {
      // a trailing newline is kept unless the block is terminated by a
      // blank line or by the end of its container
      out.push(node.text + (!node.endedByBlank && !node.endedByContainer ? '\n' : ''));
      break;
    }
    case T_QUOTE: {
      out.push('<blockquote>\n');
      for (let k = 0; k < node.children.length; k++) renderBlocks(node.children[k], refs, out);
      out.push('</blockquote>\n');
      break;
    }
    case T_LIST: {
      const tag = node.ordered ? 'ol' : 'ul';
      const startAttr = node.ordered && node.start !== 1 ? ' start="' + node.start + '"' : '';
      out.push('<' + tag + startAttr + '>\n');
      for (let k = 0; k < node.children.length; k++) renderItem(node.children[k], node, refs, out);
      out.push('</' + tag + '>\n');
      break;
    }
    case T_HR:
      out.push('<hr>\n');
      break;
    case T_TABLE: {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < node.head.length; k++) {
        const align = node.aligns[k] ? ' align="' + node.aligns[k] + '"' : '';
        const html = [];
        parseInline(node.head[k].trim(), refs, html, false);
        out.push('<th' + align + '>' + html.join('') + '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (let r = 0; r < node.rows.length; r++) {
          const row = node.rows[r];
          out.push('<tr>\n');
          for (let k = 0; k < node.head.length; k++) {
            const cell = k < row.length ? row[k].trim() : '';
            const align = node.aligns[k] ? ' align="' + node.aligns[k] + '"' : '';
            const html = [];
            parseInline(cell, refs, html, false);
            out.push('<td' + align + '>' + html.join('') + '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
    default:
      bail();
  }
}

export function renderFast(src) {
  const refs = new Map();
  inRawAnchor = false;
  const root = parseBlocks(src, refs);
  const out = [];
  renderBlocks(root, refs, out);
  return out.join('');
}

// An unclosed raw <a> tag seen while parsing inline content suppresses
// GFM extended autolinks (www./http/email) until a </a> is seen. The
// flag is document-global and reset per render. Block-level <a> tags
// do not set it (they are output raw, not parsed inline).
let inRawAnchor = false;

// Scan a code span starting at the backtick run at text[p].
// Returns the index just past the closing run of the same length,
// or -1 when there is no closing run.
function scanCodeSpan(text, p) {
  const n = text.length;
  let run = 0;
  while (p + run < n && text.charCodeAt(p + run) === 96) run++;
  if (run === 0) return -1;
  let q = p + run;
  while (q < n) {
    if (text.charCodeAt(q) === 96) {
      let m = 0;
      while (q + m < n && text.charCodeAt(q + m) === 96) m++;
      if (m === run) return q + m;
      q += m;
    } else {
      q++;
    }
  }
  return -1;
}

// True when the label text has balanced brackets: scanning it, '['
// increments depth and ']' decrements it; the final depth must be 0.
// Escaped brackets and brackets inside code spans do not count.
function labelBalanced(s) {
  let depth = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash: skip the next char
      i += 2;
      continue;
    }
    if (c === 96) { // backtick: skip a code span if it closes
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const len = j - i;
      let k = j;
      let closed = -1;
      while (k < n) {
        if (s.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && s.charCodeAt(m) === 96) m++;
          if (m - k === len) { closed = k; break; }
          k = m;
        } else {
          k++;
        }
      }
      if (closed >= 0) { i = closed + len; continue; }
      i = j;
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) depth--;
    i++;
  }
  return depth === 0;
}

// True when the character at `pos` in `s` is escaped by a backslash
// (preceded by an odd number of consecutive backslashes).
function isEscaped(s, pos) {
  let n = 0;
  let p = pos - 1;
  while (p >= 0 && s.charCodeAt(p) === 92) {
    n++;
    p--;
  }
  return n % 2 === 1;
}
