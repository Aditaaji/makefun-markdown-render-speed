// Helpers shared by parse.js: character classes, escaping and URL encoding.
// Written from scratch for the make.fun markdown-render-speed-02 entry.

// ASCII punctuation per CommonMark (33 chars).
export function isPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
export function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}
export function isDigitCode(c) { return c >= 48 && c <= 57; }
export function isAlphaCode(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
export function isAlnumCode(c) { return isAlphaCode(c) || isDigitCode(c); }

// Decode a numeric character reference body (without the leading "&#" and
// trailing ";"). Returns the code point, 0xFFFD for zero/surrogate, or -1
// when the value is not a valid code point.
export function numericEntityValue(body) {
  let cp = 0;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) { // x or X
    if (body.length < 2 || body.length > 8) return -1;
    for (let i = 1; i < body.length; i++) {
      const c = body.charCodeAt(i);
      let d;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (c >= 97 && c <= 102) d = c - 87;
      else if (c >= 65 && c <= 70) d = c - 55;
      else return -1;
      cp = cp * 16 + d;
      if (cp > 0x10ffff) return -1;
    }
  } else {
    if (body.length < 1 || body.length > 8) return -1;
    for (let i = 0; i < body.length; i++) {
      const c = body.charCodeAt(i);
      if (c < 48 || c > 57) return -1;
      cp = cp * 10 + (c - 48);
      if (cp > 0x10ffff) return -1;
    }
  }
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return 0xfffd;
  return cp;
}

// Plain escaping for code spans / code blocks / fence info strings:
// every & < > " ' is escaped, no entity recognition.
export function escCode(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape attribute values (href / title / alt): & is escaped unless it
// starts something that looks like an entity reference (&name; or
// &#...;), which is passed through verbatim.
export function escAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const semi = s.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 10 && isEntityBody(s, i + 1, semi)) continue;
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// True when s[a..b) looks like an entity body: #digits, #x hex, or a
// letter followed by alphanumerics. (No regex: this runs per '&'.)
function isEntityBody(s, a, b) {
  if (a >= b) return false;
  const c0 = s.charCodeAt(a);
  if (c0 === 35) {
    if (a + 1 >= b) return false;
    const c1 = s.charCodeAt(a + 1);
    if (c1 === 120 || c1 === 88) {
      if (a + 2 >= b) return false;
      for (let k = a + 2; k < b; k++) {
        const c = s.charCodeAt(k);
        if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102))) return false;
      }
      return true;
    }
    for (let k = a + 1; k < b; k++) {
      const c = s.charCodeAt(k);
      if (c < 48 || c > 57) return false;
    }
    return true;
  }
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let k = a + 1; k < b; k++) {
    const c = s.charCodeAt(k);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  }
  return true;
}

// Escape running text: like escAttr, but a numeric character reference is
// decoded to its character (and then that character is escaped if needed).
export function escText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const semi = s.indexOf(';', i + 1);
      if (semi !== -1 && semi - i <= 10) {
        const c1 = s.charCodeAt(i + 1);
        if (c1 === 35) {
          const v = numericEntityValue(s.slice(i + 2, semi));
          if (v >= 0) {
            const ch = String.fromCodePoint(v);
            let rep = ch;
            if (ch === '&') rep = '&amp;';
            else if (ch === '<') rep = '&lt;';
            else if (ch === '>') rep = '&gt;';
            else if (ch === '"') rep = '&quot;';
            else if (ch === "'") rep = '&#39;';
            out += s.slice(start, i) + rep;
            start = semi + 1;
            i = semi;
            continue;
          }
          // invalid numeric reference: escape the & only
          out += s.slice(start, i) + '&amp;';
          start = i + 1;
          continue;
        }
        if (isEntityBody(s, i + 1, semi)) continue; // named: verbatim
      }
      out += s.slice(start, i) + '&amp;';
      start = i + 1;
    } else if (c === 60) { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === 62) { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === 34) { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === 39) { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Percent-encode a link destination the way marked does: like encodeURI,
// but '%' itself is never encoded (even a lone '%' or '%zz' stays literal).
// Lone surrogates (which make encodeURI throw) become U+FFFD.
function encodePart(p) {
  try {
    return encodeURI(p);
  } catch {
    let out = '';
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdfff) {
        out += '%EF%BF%BD';
      } else {
        try { out += encodeURI(p[i]); } catch { out += '%EF%BF%BD'; }
      }
    }
    return out;
  }
}

export function encodeHref(s) {
  if (!s.includes('%')) return encodePart(s);
  const parts = s.split('%');
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i) out += '%';
    out += encodePart(parts[i]);
  }
  return out;
}
