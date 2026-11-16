import { escText, escCode, escAttr, encodeHref, isPunctCode } from './fast.js';

// A fast drop-in for marked 18.1.3 (default options: gfm on, breaks off).
// Hand-written CommonMark 0.31.2 + GFM 0.29 parser. parse(markdown) returns
// exactly the HTML marked renders for that string, alone.

// Block types
const DOC = 0, PARA = 1, HEAD = 2, FENCE = 3, INDCODE = 4, HTML = 5,
  BQ = 6, LIST = 7, ITEM = 8, TABLE = 9, HR = 10;

// ---- per-parse state (reset in parse()) ----
let refs;        // Map<normalized label, {dest, title}>
let inLink;      // GFM autolinks are suppressed while this is set (marked bug: an <a ...> tag sets it)
let srcEndsNL;   // whether the (normalised) source ends with a newline
let stack;       // open blocks, stack[0] is the document
let S;           // current working line (sliced after each container strip)
let off;         // index into S
let col;         // visual column within S

function mk(t) {
  return { t, ch: null, open: true, lines: null, info: '', fch: 0, flen: 0, findent: 0,
    level: 0, htype: 0, hdone: false, blankEnd: false, cind: 0, start: 1, ordered: false, delim: 46, tight: true,
    align: null, rows: null, blankAfter: false, lastBlank: false, hadBlank: false, endsBlank: false, lastLazy: false, lastLazyTab: false, parent: null };
}

function addChild(parent, b) {
  if (!parent.ch) parent.ch = [];
  // Loose list detection. A blank line directly inside an item, or at the
  // end of the previous child of an item, makes the item loose when a new
  // child is added to it. A blank line directly in a list, or directly in
  // the previous item, makes the list loose when a new item is added. A
  // blank line inside a nested block (e.g. a blockquote) does NOT count
  // for the outer list: only lastBlank (direct) is consulted there.
  if (parent.t === ITEM) {
    const prev = parent.ch.length ? parent.ch[parent.ch.length - 1] : null;
    if (parent.lastBlank || (prev && prev.endsBlank)) {
      if (parent.parent && parent.parent.t === LIST) parent.parent.tight = false;
    }
  } else if (parent.t === LIST) {
    const prev = parent.ch.length ? parent.ch[parent.ch.length - 1] : null;
    if (parent.lastBlank || (prev && prev.lastBlank)) parent.tight = false;
  }
  parent.lastBlank = false;
  // The blank line is consumed at this level: the next content landed
  // inside this parent, so the blank line does not separate anything at
  // any ancestor level either.
  let anc = parent.parent;
  while (anc && anc.t !== DOC) { anc.lastBlank = false; anc = anc.parent; }
  parent.ch.push(b);
  b.parent = parent;
  return b;
}

// ---- line cursor helpers ----
// Advance `n` columns of whitespace (spaces/tabs) from (off, col).
// A tab that straddles the target is replaced by spaces in S (partial tab).
// Returns true when the target column was reached.
function advance(n) {
  const target = col + n;
  while (col < target) {
    if (off >= S.length) return false;
    const c = S.charCodeAt(off);
    if (c === 32) { off++; col++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next > target) {
        const remain = next - target;
        S = S.slice(0, off) + ' '.repeat(remain) + S.slice(off + 1);
        col = target;
        return true;
      }
      off++; col = next;
    } else return false;
  }
  return true;
}

// Columns of leading whitespace from (off, col); does not move the cursor
// and does not mutate S. Also returns the index of the first non-space char.
function indentInfo() {
  let c = col, i = off;
  while (i < S.length) {
    const ch = S.charCodeAt(i);
    if (ch === 32) { i++; c++; }
    else if (ch === 9) { c += 4 - (c % 4); i++; }
    else break;
  }
  return { indent: c - col, idx: i };
}

// True when the rest of the line (from off) is only spaces/tabs.
function restBlank() {
  for (let i = off; i < S.length; i++) {
    const c = S.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// After a container prefix was consumed, expand any leading tabs in the
// remaining content to spaces (in place, based on the current column).
// The spaces stay in S and become part of the content.
function expandLeadingTabs() {
  // Expand every tab in the leading whitespace run to spaces (in place),
  // leaving the cursor at the start of the content: the spaces are content.
  let i = off, c = col;
  while (i < S.length) {
    const ch = S.charCodeAt(i);
    if (ch === 32) { i++; c++; }
    else if (ch === 9) {
      const n = 4 - (c % 4);
      S = S.slice(0, i) + ' '.repeat(n) + S.slice(i + 1);
      i += n; c += n;
    } else break;
  }
}

// Slice S at the current offset and restart column counting (fresh string
// for the next container level).
function sliceRest() {
  S = S.slice(off);
  off = 0;
  col = 0;
}

// Unicode-aware-ish helpers for flanking checks.
function isSpaceCh(ch) {
  if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') return true;
  const c = ch.charCodeAt(0);
  return c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
}
function isPunctCh(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isPunctCode(c);
  // Unicode punctuation (P) or symbol (S) categories
  return UNICODE_PUNCT.test(ch);
}
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

// ---- container matching ----
function matchBQ() {
  const s0 = S, o0 = off, c0 = col;
  // skip at most 3 columns of whitespace, then expect '>'
  let n = 0;
  while (n < 3 && off < S.length) {
    const c = S.charCodeAt(off);
    if (c === 32) { off++; col++; n++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next - col > 3 - n) break;
      off++; col = next; n = col - c0;
    } else break;
  }
  if (off >= S.length || S.charCodeAt(off) !== 62) { S = s0; off = o0; col = c0; return false; }
  off++; col++;
  // one optional space (a tab is consumed partially: 1 column of it)
  if (off < S.length) {
    const c = S.charCodeAt(off);
    if (c === 32) { off++; col++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      S = S.slice(0, off) + ' '.repeat(next - col - 1) + S.slice(off + 1);
      col++;
    }
  }
  // Expand leading tabs using the column relative to where this
  // blockquote started (c0): a tab after the '>' of a blockquote inside a
  // list item counts from the item's content start, not the raw line.
  col = col - c0;
  expandLeadingTabs();
  sliceRest();
  return true;
}

function matchItem(b) {
  // a blank line closes an item that has no content yet
  if (restBlank()) return !!(b.ch && b.ch.length);
  const s0 = S, o0 = off, c0 = col;
  if (advance(b.cind - col)) return true;
  S = s0; off = o0; col = c0;
  return false;
}

// Deepest open paragraph that is the last descendant of b (for lazy lines).
function deepestOpenPara(b) {
  let cur = b;
  for (;;) {
    const ch = cur.ch;
    if (!ch || !ch.length) return null;
    const last = ch[ch.length - 1];
    if (!last.open) return null;
    if (last.t === PARA) return last;
    if (last.t === BQ || last.t === LIST || last.t === ITEM) { cur = last; continue; }
    return null;
  }
}

function addLineToPara(p, text) {
  if (!p.lines) p.lines = [];
  p.lines.push(text);
}

function deepestContainer() {
  for (let k = stack.length - 1; k >= 0; k--) {
    const b = stack[k];
    if (b.t === DOC || b.t === BQ || b.t === LIST || b.t === ITEM) return b;
  }
  return stack[0];
}

function closeOpenPara() {
  const top = stack[stack.length - 1];
  if (top && top.open && top.t === PARA) closeBlock(stack.pop());
}

// True when the line (from the cursor) looks like a setext underline.
function isSetextLazyLine(text) {
  const t = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (!t.length) return false;
  const c = t.charCodeAt(0);
  if (c !== 61 && c !== 45) return false;
  if (c === 45 && t.length >= 3) return false; // a thematic break, not lazy
  for (let i = 1; i < t.length; i++) if (t.charCodeAt(i) !== c) return false;
  return true;
}

// True when any block in the stack up to index upto is a blockquote.
function stackHasBQ(upto) {
  for (let k = 1; k <= upto && k < stack.length; k++) if (stack[k].t === BQ) return true;
  return false;
}

// ---- line processing ----
function processLine(raw) {
  S = raw; off = 0; col = 0;
  // Phase 1: match open containers.
  let i = 1, failedAt = -1;
  while (i < stack.length) {
    const b = stack[i];
    if (!b.open) { failedAt = i; break; }
    if (b.t === BQ) { if (!matchBQ()) { failedAt = i; break; } }
    else if (b.t === ITEM) { if (!matchItem(b)) { failedAt = i; break; } }
    else if (b.t === LIST) { /* a list always matches */ }
    else break; // leaf block: stop here
    i++;
  }
  if (failedAt >= 0) {
    // A line inside an open fenced code block is fence content even when
    // it does not match the enclosing list item's indent (e.g. an
    // unindented line inside a fence in a list item). This does NOT
    // apply to blockquotes: a line without the '>' prefix leaves the
    // blockquote (and the fence inside it).
    const top = stack[stack.length - 1];
    if (top && top.open && top.t === FENCE && stack[failedAt].t === ITEM) {
      addLineToFence(top);
      return;
    }
    const para = deepestOpenPara(stack[failedAt]);
    // A line is a lazy paragraph continuation only when it starts no new
    // block (a heading, fence, html block, thematic break, list item or
    // blockquote all close the containers instead). A blank line is never
    // lazy: it closes the containers.
    if (para && !restBlank() && !wouldStartBlock()) {
      let text = S.slice(off);
      // A lazy line indented by 4+ columns loses 4 columns (it would
      // otherwise be indented code).
      if (indentInfo().indent >= 4) text = stripUpTo(4);
      // A lazy line that looks like a setext underline, inside a blockquote
      // after another lazy line, is indented by 4 so it is not read as one.
      if (para.lastLazy && !para.lastLazyTab && isSetextLazyLine(text) && stackHasBQ(failedAt)) {
        text = '    ' + text.replace(/^[ \t]+/, '');
      }
      addLineToPara(para, text);
      para.lastLazy = true;
      para.lastLazyTab = text.charCodeAt(0) === 9;
      return;
    }
    while (stack.length > failedAt) closeBlock(stack.pop());
  }
  let tip = deepestContainer();
  // Phase 2: open leaf block (fenced / indented code / html) consumes the line.
  let last = tip.ch && tip.ch.length ? tip.ch[tip.ch.length - 1] : null;
  if (last && last.open) {
    if (last.t === FENCE) {
      if (isClosingFence(last)) { closeBlock(stack.pop()); return; }
      addLineToFence(last);
      return;
    }
    if (last.t === INDCODE) {
      if (addLineToIndCode(last)) return;
      closeBlock(stack.pop());
      tip = stack[stack.length - 1];
      last = tip.ch && tip.ch.length ? tip.ch[tip.ch.length - 1] : null;
    } else if (last.t === HTML) {
      if (addLineToHtml(last)) return;
      // a type 1-5 block that ended at its end condition keeps its
      // trailing newline unless the next line is a truly empty line:
      // a spaces-only or tab-only line does not strip it
      if (restBlank() && off >= S.length) last.blankEnd = true;
      closeBlock(stack.pop());
      tip = stack[stack.length - 1];
      last = tip.ch && tip.ch.length ? tip.ch[tip.ch.length - 1] : null;
    }
  }
  // Phase 3: blank line. A plain blank line (no '>' prefix) is a blank
  // line at every level it is inside, so it is recorded on all open
  // containers; a blank line inside a blockquote (it carries a '>')
  // is only recorded on the blockquote itself.
  if (restBlank()) {
    // A whitespace-only line that contains a tab is a table row (with
    // empty cells) when the open paragraph is a table, not a blank line.
    if (last && last.open && last.t === PARA && S.indexOf('\t') >= 0 &&
        last.lines && last.lines.length >= 2 && parseTableDelim(last.lines[1])) {
      addLineToPara(last, S.slice(off));
      return;
    }
    if (last && last.open && last.t === PARA) closeBlock(stack.pop());
    if (raw.indexOf('>') >= 0) tip.lastBlank = true;
    else for (let k = 1; k < stack.length; k++) stack[k].lastBlank = true;
    return;
  }
  // Phase 4: block starts.
  const newTip = tryBlockStart(tip);
  if (!newTip) return;
  tip = newTip;
  last = tip.ch && tip.ch.length ? tip.ch[tip.ch.length - 1] : null;
  // Phase 5: paragraph.
  if (last && last.open && last.t === PARA) { addLineToPara(last, S.slice(off)); last.lastLazy = false; return; }
  const p = addChild(tip, mk(PARA));
  stack.push(p);
  addLineToPara(p, S.slice(off));
}

// ---- leaf block line handling ----
function isClosingFence(b) {
  const { indent, idx } = indentInfo();
  if (indent > 3) return false;
  let i = idx, n = 0;
  while (i < S.length && S.charCodeAt(i) === b.fch) { i++; n++; }
  if (n < b.flen) return false;
  for (; i < S.length; i++) { const c = S.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}

// Strip up to n columns of leading whitespace from the current line
// (a tab that spans past n leaves its leftover spaces). Returns the
// remainder of the line.
function stripUpTo(n) {
  let k = 0;
  while (k < n && off < S.length) {
    const ch = S.charCodeAt(off);
    if (ch === 32) { off++; col++; k++; }
    else if (ch === 9) {
      const nx = col + 4 - (col % 4), w = nx - col;
      if (k + w <= n) { off++; col = nx; k += w; }
      else {
        S = S.slice(0, off) + ' '.repeat(k + w - n) + S.slice(off + 1);
        col = n; k = n;
      }
    }
    else break;
  }
  return S.slice(off);
}

function addLineToFence(b) {
  if (!b.lines) b.lines = [];
  // A backtick fence strips its own indent from content lines; a tilde
  // fence does not (marked quirk). A tab met while stripping is removed
  // entirely (it is not partially consumed, unlike container matching).
  if (b.fch === 96) {
    let k = 0;
    while (k < b.findent && off < S.length) {
      const ch = S.charCodeAt(off);
      if (ch === 32) { off++; col++; k++; }
      else if (ch === 9) { const nx = col + 4 - (col % 4); off++; col = nx; k = b.findent; }
      else break;
    }
  }
  let text = S.slice(off);
  // A leading tab in the content is expanded to spaces from the current
  // column, but only when the fence itself has no indent (the tab then
  // sits at a container column) and we are inside a container; at the
  // top level (column 0) the tab is kept literally.
  if (b.findent === 0 && col > 0 && text.charCodeAt(0) === 9) {
    text = ' '.repeat(4 - (col % 4)) + text.slice(1);
  }
  b.lines.push(text);
}

function addLineToIndCode(b) {
  if (restBlank()) {
    if (!b.lines) b.lines = [];
    if (indentInfo().indent >= 4) { advance(4); b.lines.push(S.slice(off)); }
    else b.lines.push('');
    return true;
  }
  if (indentInfo().indent < 4) return false;
  if (!b.lines) b.lines = [];
  advance(4);
  b.lines.push(S.slice(off));
  return true;
}

function htmlEnd1(text, tag) {
  // line contains </tag ...> (case-insensitive, optional spaces before >)
  const lower = text.toLowerCase();
  const needle = '</' + tag;
  let i = lower.indexOf(needle);
  while (i >= 0) {
    let j = i + needle.length;
    while (j < text.length && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
    if (j < text.length && text.charCodeAt(j) === 62) return true;
    i = lower.indexOf(needle, i + 1);
  }
  return false;
}

function addLineToHtml(b) {
  if (b.hdone) return false;
  if (b.htype >= 6 && restBlank()) { b.blankEnd = true; return false; }
  if (!b.lines) b.lines = [];
  const text = S.slice(off);
  b.lines.push(text);
  if (b.htype === 1) { if (htmlEnd1(text, b.info)) b.hdone = true; }
  else if (b.htype === 2) { if (text.indexOf('-->') >= 0 || text.indexOf('<!-->') >= 0 || text.indexOf('<!--->') >= 0) b.hdone = true; }
  else if (b.htype === 3) { if (text.indexOf('?>') >= 0) b.hdone = true; }
  else if (b.htype === 4) { if (text.indexOf('>') >= 0) b.hdone = true; }
  else if (b.htype === 5) { if (text.indexOf(']]>') >= 0) b.hdone = true; }
  return true;
}

// ---- closing / finalization ----
function removeBlock(b) {
  const ch = b.parent.ch;
  const i = ch.indexOf(b);
  if (i >= 0) ch.splice(i, 1);
}

function normalizeLabel(label) {
  let out = '', ws = false;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { ws = true; continue; }
    if (ws && out.length) out += ' ';
    ws = false;
    out += c;
  }
  // Unicode case folding (beyond toLowerCase): sharp s -> ss, final sigma -> sigma
  return out.toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ');
}

// Scan a link label starting at s[i] === '['; returns {label, end} (end = index
// just past the closing ']') or null. Backslash escapes are kept verbatim in
// the label (matching is done on the raw label, escapes are NOT resolved),
// and a nested '[' rejects the label (a reference-definition label may not
// contain balanced brackets).
function scanLabel(s, i) {
  let depth = 0, j = i, label = '';
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { label += s[j] + s[j + 1]; j += 2; continue; }
    if (c === '[') { if (depth > 0) return null; depth++; j++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0) return { label, end: j + 1 };
      label += c; j++; continue;
    }
    label += c; j++;
  }
  return null;
}

// Parse a link reference definition starting at lines[i]. Returns
// {label, dest, title, consumed} or null. The definition may span up to 3 lines.
// Parse a link reference definition starting at lines[i].
// Returns {label, dest, title, consumed} (consumed = lines used) or null.
// The label, destination and title may each span lines; the destination
// and title may sit on the following line(s) with any indentation.
function parseRefDef(lines, i) {
  let li = i, p = 0;
  // first-line indent: at most 3 columns
  let indent = 0;
  const first = lines[li];
  while (p < first.length && indent < 4) {
    const c = first.charCodeAt(p);
    if (c === 32) { p++; indent++; }
    else if (c === 9) { indent += 4 - (indent % 4); p++; }
    else break;
  }
  if (indent >= 4 || p >= first.length || first.charCodeAt(p) !== 91) return null;
  // ---- label (may span lines) ----
  let label = '', depth = 0, done = false;
  {
    let j = p, l = li;
    while (l < lines.length) {
      const s = lines[l];
      while (j < s.length) {
        const c = s[j];
        if (c === '\\' && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { label += s[j] + s[j + 1]; j += 2; continue; }
        if (c === '[') { if (depth > 0) return null; depth++; j++; continue; }
        if (c === ']') {
          depth--;
          if (depth === 0) { li = l; p = j + 1; done = true; break; }
          label += c; j++; continue;
        }
        label += c; j++;
      }
      if (done) break;
      label += '\n';
      l++; j = 0;
    }
    if (!done) return null;
  }
  const normLabel = normalizeLabel(label);
  if (!normLabel.length) return null;
  // the ':' must follow the ']' on the same line
  if (p >= lines[li].length || lines[li].charCodeAt(p) !== 58) return null;
  p++;
  // ---- destination: same line, or the next line ----
  let dli = li, dp = p;
  while (dp < lines[dli].length && (lines[dli].charCodeAt(dp) === 32 || lines[dli].charCodeAt(dp) === 9)) dp++;
  if (dp >= lines[dli].length) {
    if (dli + 1 >= lines.length) return null;
    dli++;
    dp = 0;
    while (dp < lines[dli].length && (lines[dli].charCodeAt(dp) === 32 || lines[dli].charCodeAt(dp) === 9)) dp++;
    if (dp >= lines[dli].length) return null; // the next line is blank
  }
  let dest = '';
  const dline = lines[dli];
  if (dline.charCodeAt(dp) === 60) { // '<...>'
    // Escape-aware scan: '\>' is an escaped '>' (part of the
    // destination), not the closing bracket.
    let close = -1;
    for (let k = dp + 1; k < dline.length; k++) {
      const c = dline.charCodeAt(k);
      if (c === 10 || c === 13 || c === 60) return null;
      if (c === 92 && k + 1 < dline.length && isPunctCode(dline.charCodeAt(k + 1))) { k++; continue; }
      if (c === 62) { close = k; break; }
    }
    if (close < 0) return null;
    dest = dline.slice(dp + 1, close);
    if (dest.indexOf('\\') >= 0) dest = resolveLabelEscapes(dest);
    dp = close + 1;
  } else {
    let depth2 = 0, k = dp;
    while (k < dline.length) {
      const c = dline.charCodeAt(k);
      if (c === 32 || c === 9 || c < 32) break;
      if (c === 92 && k + 1 < dline.length && isPunctCode(dline.charCodeAt(k + 1))) { dest += dline[k + 1]; k += 2; continue; }
      if (c === 40) depth2++;
      else if (c === 41) { if (depth2 === 0) break; depth2--; }
      dest += dline[k];
      k++;
    }
    if (k === dp || depth2 !== 0) return null;
    dp = k;
  }
  // ---- optional title ----
  // After the destination, a title on the SAME line needs whitespace
  // before it; a title on the NEXT line is optional and a bad one is
  // simply ignored (the definition still counts).
  let title = '';
  let tli = dli, tp = dp;
  let hadWs = false;
  while (tp < lines[tli].length && (lines[tli].charCodeAt(tp) === 32 || lines[tli].charCodeAt(tp) === 9)) { tp++; hadWs = true; }
  let titleOnNextLine = false;
  if (tp >= lines[tli].length) {
    if (tli + 1 < lines.length) {
      const nl = lines[tli + 1];
      let q = 0;
      while (q < nl.length && (nl.charCodeAt(q) === 32 || nl.charCodeAt(q) === 9)) q++;
      if (q < nl.length && (nl.charCodeAt(q) === 34 || nl.charCodeAt(q) === 39 || nl.charCodeAt(q) === 40)) {
        titleOnNextLine = true;
        tli = tli + 1; tp = q;
      }
    }
  } else {
    const q = lines[tli].charCodeAt(tp);
    if (q !== 34 && q !== 39 && q !== 40) return null; // trailing garbage on the same line
    if (!hadWs) return null; // a same-line title needs whitespace before it
  }
  if (tp < lines[tli].length && (lines[tli].charCodeAt(tp) === 34 || lines[tli].charCodeAt(tp) === 39 || lines[tli].charCodeAt(tp) === 40)) {
    const r = scanTitle(lines, tli, tp);
    if (!r) {
      if (titleOnNextLine) return { label: normLabel, dest, title: '', consumed: dli - i + 1 };
      return null;
    }
    let ep = r.ep, el = r.eli;
    while (ep < lines[el].length && (lines[el].charCodeAt(ep) === 32 || lines[el].charCodeAt(ep) === 9)) ep++;
    if (ep < lines[el].length) {
      if (titleOnNextLine) return { label: normLabel, dest, title: '', consumed: dli - i + 1 };
      return null;
    }
    title = r.title;
    return { label: normLabel, dest, title, consumed: el - i + 1 };
  }
  return { label: normLabel, dest, title: '', consumed: dli - i + 1 };
}

// Scan a link title starting at lines[li][p] (a quote or '(').
// The title may span lines. Returns {title, eli, ep} (ep = index just
// past the closing quote/paren on line eli) or null.
function scanTitle(lines, li, p) {
  const q = lines[li].charCodeAt(p);
  let title = '', l = li, j = p + 1;
  if (q === 40) { // '(' title: no unescaped '(' inside
    while (l < lines.length) {
      const s = lines[l];
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c === 92 && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { title += s[j + 1]; j += 2; continue; }
        if (c === 40) return null;
        if (c === 41) return { title, eli: l, ep: j + 1 };
        title += s[j];
        j++;
      }
      l++; j = 0;
      if (l < lines.length) title += '\n';
    }
    return null;
  }
  // quoted title
  while (l < lines.length) {
    const s = lines[l];
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { title += s[j + 1]; j += 2; continue; }
      if (c === q) return { title, eli: l, ep: j + 1 };
      title += s[j];
      j++;
    }
    l++; j = 0;
    if (l < lines.length) title += '\n';
  }
  return null;
}

// Parse a table delimiter row; returns the align array or null.
function parseTableDelim(line) {
  let ind = 0, p = 0;
  while (p < line.length) {
    const c = line.charCodeAt(p);
    if (c === 32) { p++; ind++; }
    else if (c === 9) { ind += 4 - (ind % 4); p++; }
    else break;
  }
  if (ind > 3) return null;
  const cells = splitTableRow(line);
  if (!cells) return null;
  const align = [];
  for (const cell of cells) {
    const c = cell.trim();
    if (!/^:?-+:?$/.test(c)) return null;
    align.push(c.charCodeAt(0) === 58 ? (c.charCodeAt(c.length - 1) === 58 ? 'center' : 'left') : (c.charCodeAt(c.length - 1) === 58 ? 'right' : ''));
  }
  return align;
}

// Split a table row line into cells (leading/trailing pipes are optional).
// Returns null when the line has no cell separator structure we can use.
function splitTableRow(line) {
  const n = line.length;
  // Mark the character ranges that lie inside a complete code span. A
  // backtick run opens a span only when a run of the same length follows
  // it; a run with no matching closer is literal and stops all further
  // code-span tracking for the rest of the row.
  const prot = new Array(n).fill(false);
  let i = 0;
  while (i < n) {
    if (line[i] !== '`') { i++; continue; }
    let j = i;
    while (j < n && line[j] === '`') j++;
    const run = j - i;
    let k = j, closer = -1;
    while (k < n) {
      if (line[k] === '`') {
        let m = k;
        while (m < n && line[m] === '`') m++;
        if (m - k === run) { closer = m; break; }
        k = m;
      } else k++;
    }
    if (closer < 0) break;
    for (let t = i; t < closer; t++) prot[t] = true;
    i = closer;
  }
  const cells = [];
  let cur = '', p = 0;
  while (p < n) {
    const c = line[p];
    if (c === '\\' && p + 1 < n && isPunctCode(line.charCodeAt(p + 1))) {
      // an escaped pipe is resolved here (it must not split the cell);
      // other escapes are left for the inline parser
      if (line.charCodeAt(p + 1) === 124) cur += '|';
      else cur += line.slice(p, p + 2);
      p += 2; continue;
    }
    if (c === '|' && !prot[p]) { cells.push(cur); cur = ''; p++; continue; }
    cur += c; p++;
  }
  cells.push(cur);
  // drop an empty first cell when the line starts with '|', same at the end
  let start = 0, end = cells.length;
  if (cells.length > 1 && /^\s*$/.test(cells[0]) && /^\s*\|/.test(line)) start = 1;
  if (end - start > 1 && /^\s*$/.test(cells[end - 1]) && /\|\s*$/.test(line)) end--;
  return cells.slice(start, end);
}

function finalizePara(p) {
  if (!p.lines || !p.lines.length) { removeBlock(p); return; }
  let lines = p.lines, i = 0;
  while (i < lines.length) {
    const d = parseRefDef(lines, i);
    if (!d) break;
    if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
    i += d.consumed;
  }
  lines = lines.slice(i);
  if (!lines.length) { removeBlock(p); return; }
  if (lines.length >= 2) {
    const align = parseTableDelim(lines[1]);
    if (align) {
      // the header must have the same number of cells as the delimiter
      const headCells = splitTableRow(lines[0]);
      if (headCells && headCells.length === align.length) {
        p.t = TABLE;
        p.align = align;
        p.rows = lines.slice(2);
        p.lines = [lines[0]];
        return;
      }
    }
  }
  p.lines = lines;
}

function closeBlock(b) {
  b.open = false;
  // a block ends with a blank line if a blank line was seen directly in it,
  // or its last child ends with a blank line
  b.endsBlank = b.lastBlank || (b.ch && b.ch.length > 0 && !!b.ch[b.ch.length - 1].endsBlank);
  if (b.t === PARA) finalizePara(b);
}

// True when the line (at the current cursor) would start a new block at
// this level. Used to decide whether a line is a lazy paragraph continuation.
// No side effects: it only inspects the line.
function wouldStartBlock() {
  const { indent, idx } = indentInfo();
  if (idx >= S.length || indent > 3) return false;
  const c0 = S.charCodeAt(idx);
  if (c0 === 35) { // ATX heading
    let i = idx, level = 0;
    while (i < S.length && S.charCodeAt(i) === 35 && level < 7) { i++; level++; }
    if (level <= 6 && (i >= S.length || S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) return true;
  }
  if (c0 === 96 || c0 === 126) { // fenced code
    let i = idx, n = 0;
    while (i < S.length && S.charCodeAt(i) === c0) { i++; n++; }
    if (n >= 3 && !(c0 === 96 && S.slice(i).indexOf('`') >= 0)) return true;
  }
  const ht = htmlBlockType(idx);
  if (ht > 0 && ht !== 7) return true;
  if (c0 === 45 || c0 === 95 || c0 === 42) { // thematic break
    let i = idx, n = 0, ok = true;
    while (i < S.length) {
      const ch = S.charCodeAt(i);
      if (ch === c0) { n++; i++; }
      else if (ch === 32 || ch === 9) i++;
      else { ok = false; break; }
    }
    if (ok && n >= 3) return true;
  }
  if (c0 === 62) return true; // blockquote
  if (listItemInfo(idx, indent)) return true; // any list item (content or not)
  return false;
}

// ---- block starts ----
// A list can only contain items; if the tip is a list, close it and
// return the parent so a non-list block becomes a sibling of the list.
function closeListTip(tip) {
  while (tip.t === LIST) {
    stack.pop(); closeBlock(tip);
    tip = stack[stack.length - 1];
  }
  return tip;
}

// Returns the tip to use for the paragraph phase, or null when the line was
// consumed by a block start.
function tryBlockStart(tip) {
  for (;;) {
    const { indent, idx } = indentInfo();
    const last = tip.ch && tip.ch.length ? tip.ch[tip.ch.length - 1] : null;
    const paraOpen = !!(last && last.open && last.t === PARA);
    if (idx >= S.length) return false;

    // A list can only continue with an item of the same kind; any other
    // block start closes the list first so the new block is a sibling.
    if (tip.t === LIST) {
      const li0 = indent <= 3 ? listItemInfo(idx, indent) : null;
      if (!li0 || li0.ordered !== tip.ordered || li0.delim !== tip.delim) {
        stack.pop(); closeBlock(tip);
        tip = stack[stack.length - 1];
        continue;
      }
    }

    // --- setext heading (needs an open paragraph) ---
    if (paraOpen && indent <= 3) {
      const c = S.charCodeAt(idx);
      if (c === 61 || c === 45) {
        // a run of the same char, then only trailing spaces/tabs
        let i = idx;
        while (i < S.length && S.charCodeAt(i) === c) i++;
        while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
        if (i >= S.length) {
          let lines = last.lines, n = 0;
          while (n < lines.length) {
            const d = parseRefDef(lines, n);
            if (!d) break;
            if (!refs.has(d.label)) refs.set(d.label, { dest: d.dest, title: d.title });
            n += d.consumed;
          }
          lines = lines.slice(n);
          // a table paragraph is not a setext heading: when lines[1] is
          // a valid delimiter row this paragraph will become a table, so
          // the underline-looking line is just another table row
          let isTable = false;
          if (lines.length >= 2) {
            const align = parseTableDelim(lines[1]);
            if (align) {
              const headCells = splitTableRow(lines[0]);
              if (headCells && headCells.length === align.length) isTable = true;
            }
          }
          if (!isTable) {
            stack.pop();
            if (!lines.length) { removeBlock(last); continue; }
            lines[0] = lines[0].replace(/^[ \t]+/, '');
            lines[lines.length - 1] = lines[lines.length - 1].replace(/[ \t]+$/, '');
            last.t = HEAD; last.level = c === 61 ? 1 : 2; last.lines = lines; last.open = false;
            return null;
          }
          // table: fall through so the line is added as a paragraph
          // continuation (a table row)
        }
      }
    }

    if (indent > 3) {
      // Only indented code can start at this indent (and only with no open paragraph).
      if (!paraOpen) {
        const ic = addChild(tip, mk(INDCODE));
        stack.push(ic);
        advance(4);
        if (!ic.lines) ic.lines = [];
        ic.lines.push(S.slice(off));
        return null;
      }
      return tip;
    }
    const c0 = S.charCodeAt(idx);

    // --- ATX heading ---
    if (c0 === 35) {
      let i = idx, level = 0;
      while (i < S.length && S.charCodeAt(i) === 35 && level < 7) { i++; level++; }
      if (level <= 6 && (i >= S.length || S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) {
        let j = i;
        while (j < S.length && (S.charCodeAt(j) === 32 || S.charCodeAt(j) === 9)) j++;
        let content = S.slice(j);
        let end = content.length;
        while (end > 0 && (content.charCodeAt(end - 1) === 32 || content.charCodeAt(end - 1) === 9)) end--;
        content = content.slice(0, end);
        let h = content.length;
        while (h > 0 && content.charCodeAt(h - 1) === 35) h--;
        if (h < content.length && (h === 0 || content.charCodeAt(h - 1) === 32 || content.charCodeAt(h - 1) === 9)) {
          content = content.slice(0, h);
          while (content.length > 0 && (content.charCodeAt(content.length - 1) === 32 || content.charCodeAt(content.length - 1) === 9)) content = content.slice(0, -1);
        }
        closeOpenPara();
        const hd = addChild(tip, mk(HEAD));
        hd.level = level; hd.lines = [content];
        return null;
      }
    }

    // --- fenced code ---
    if (c0 === 96 || c0 === 126) {
      let i = idx, n = 0;
      while (i < S.length && S.charCodeAt(i) === c0) { i++; n++; }
      if (n >= 3) {
        let info = S.slice(i);
        if (c0 === 96 && info.indexOf('`') >= 0) { /* not a fence */ }
        else {
          info = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
          // backslash escapes in the info string
          if (info.indexOf('\\') >= 0) {
            let out = '';
            for (let q = 0; q < info.length; q++) {
              if (info.charCodeAt(q) === 92 && q + 1 < info.length && isPunctCode(info.charCodeAt(q + 1))) { out += info[q + 1]; q++; }
              else out += info[q];
            }
            info = out;
          }
          closeOpenPara();
          const f = addChild(tip, mk(FENCE));
          f.fch = c0; f.flen = n; f.findent = indent; f.info = info;
          stack.push(f);
          return null;
        }
      }
    }

    // --- HTML block ---
    const htmlType = htmlBlockType(idx);
    if (htmlType > 0 && !(paraOpen && htmlType === 7)) {
      closeOpenPara();
      const h = addChild(tip, mk(HTML));
      h.htype = htmlType;
      if (htmlType === 1) h.info = htmlBlockTag(idx);
      stack.push(h);
      addLineToHtml(h);
      return null;
    }

    // --- thematic break ---
    if (c0 === 45 || c0 === 95 || c0 === 42) {
      let i = idx, n = 0, ok = true;
      while (i < S.length) {
        const ch = S.charCodeAt(i);
        if (ch === c0) { n++; i++; }
        else if (ch === 32 || ch === 9) i++;
        else { ok = false; break; }
      }
      if (ok && n >= 3) {
        closeOpenPara();
        tip = closeListTip(tip);
        addChild(tip, mk(HR));
        return null;
      }
    }

    // --- blockquote ---
    if (c0 === 62) {
      closeOpenPara();
      const bq = addChild(tip, mk(BQ));
      stack.push(bq);
      tip = bq;
      off = idx + 1; col = col + indent + 1;
      if (off < S.length) {
        const ch = S.charCodeAt(off);
        if (ch === 32) { off++; col++; }
        else if (ch === 9) {
          const next = col + 4 - (col % 4);
          S = S.slice(0, off) + ' '.repeat(next - col - 1) + S.slice(off + 1);
          col++;
        }
      }
      expandLeadingTabs();
      sliceRest();
      continue;
    }

    // --- list item ---
    const li = listItemInfo(idx, indent);
    if (li) {
      const itemHasContent = li.contentIdx < S.length;
      // An ordered list item whose number is not 1 cannot interrupt a
      // paragraph, except when the paragraph sits inside a list item
      // (then a nested list may start with any number).
      if (!paraOpen || (itemHasContent && (li.bullet || li.startNum === 1 || tip.t === ITEM))) {
        closeOpenPara();
        let list = null;
        if (tip.t === LIST && tip.ordered === li.ordered && tip.delim === li.delim) list = tip;
        else {
          const lch = tip.ch && tip.ch.length ? tip.ch[tip.ch.length - 1] : null;
          if (lch && lch.open && lch.t === LIST && lch.ordered === li.ordered && lch.delim === li.delim) list = lch;
        }
        if (!list) {
          list = addChild(tip, mk(LIST));
          list.ordered = li.ordered; list.delim = li.delim; list.start = li.startNum;
          stack.push(list);
        }
        const item = addChild(list, mk(ITEM));
        item.cind = li.cind;
        stack.push(item);
        tip = item;
        if (!itemHasContent) return null;
        off = li.contentIdx; col = li.cind;
        continue; // process the remainder of the line inside the item
      }
    }

    return tip;
  }
}

// Info about a list item marker at S[idx] (indent <= 3 already checked).
// Returns null when there is no marker, else {ordered, delim, bullet,
// startNum, cind, contentIdx}.
function listItemInfo(idx, indent) {
  const c = S.charCodeAt(idx);
  let markerWidth = 0, ordered = false, delim = 46, startNum = 1, bullet = false;
  if (c === 45 || c === 43 || c === 42) {
    markerWidth = 1; bullet = true; delim = c;
  } else if (c >= 48 && c <= 57) {
    let i = idx, digits = 0, num = 0;
    while (i < S.length && S.charCodeAt(i) >= 48 && S.charCodeAt(i) <= 57 && digits < 10) { num = num * 10 + (S.charCodeAt(i) - 48); i++; digits++; }
    if (digits === 0 || digits > 9) return null;
    if (i >= S.length) return null;
    const d = S.charCodeAt(i);
    if (d !== 46 && d !== 41) return null;
    markerWidth = digits + 1; ordered = true; delim = d; startNum = num;
  } else return null;
  // the marker must be followed by a space/tab or the end of the line
  const after = idx + markerWidth;
  if (after < S.length) {
    const ac = S.charCodeAt(after);
    if (ac !== 32 && ac !== 9) return null;
  }
  const markerCol = col + indent;
  let ccol = markerCol + markerWidth;
  let j = after, ws = 0;
  while (j < S.length) {
    const ch = S.charCodeAt(j);
    if (ch === 32) { j++; ccol++; ws++; }
    else if (ch === 9) { const nx = ccol + 4 - (ccol % 4); ws += nx - ccol; ccol = nx; j++; }
    else break;
  }
  const empty = j >= S.length;
  let cind, contentIdx;
  if (empty || ws >= 5) {
    cind = markerCol + markerWidth + 1;
    // content starts one column into the whitespace after the marker
    let k = after, ck = markerCol + markerWidth;
    if (k < S.length) {
      const ch = S.charCodeAt(k);
      if (ch === 32) { k++; ck++; }
      else if (ch === 9) {
        const nx = ck + 4 - (ck % 4);
        if (nx - ck === 1) { k++; ck = nx; }
        else { S = S.slice(0, k) + ' '.repeat(nx - ck - 1) + S.slice(k + 1); ck++; }
      }
    }
    contentIdx = k;
  } else {
    cind = ccol;
    contentIdx = j;
  }
  return { ordered, delim, bullet, startNum, cind, contentIdx };
}

// HTML block type at S[idx] (idx points at '<'), or 0 when not an HTML block.
// 1 script/pre/style/textarea, 2 comment, 3 ?, 4 <!letter, 5 CDATA, 6 block tag, 7 complete tag.
function htmlBlockType(idx) {
  if (S.charCodeAt(idx) !== 60) return 0;
  const rest = S.slice(idx + 1);
  if (!rest.length) return 0;
  const c = rest.charCodeAt(0);
  if (c === 33) { // '!'
    if (rest.startsWith('!--')) return 2;
    if (rest.startsWith('![CDATA[')) return 5;
    if (rest.length > 1 && ((rest.charCodeAt(1) >= 65 && rest.charCodeAt(1) <= 90) || (rest.charCodeAt(1) >= 97 && rest.charCodeAt(1) <= 122))) return 4;
    return 0;
  }
  if (c === 63) return 3; // '?'
  if (c === 47) { // '/'
    // closing tag: a block tag makes it type 6 (it interrupts a paragraph)
    let j = idx + 2;
    if (j < S.length) {
      const c2 = S.charCodeAt(j);
      if ((c2 >= 65 && c2 <= 90) || (c2 >= 97 && c2 <= 122)) {
        let k = j;
        while (k < S.length && ((S.charCodeAt(k) >= 65 && S.charCodeAt(k) <= 90) || (S.charCodeAt(k) >= 97 && S.charCodeAt(k) <= 122) || (S.charCodeAt(k) >= 48 && S.charCodeAt(k) <= 57) || S.charCodeAt(k) === 45)) k++;
        const name = S.slice(j, k).toLowerCase();
        const after = S.charCodeAt(k);
        if ((k >= S.length || after === 32 || after === 9 || after === 62 || after === 47) && BLOCK_TAGS.has(name)) return 6;
      }
    }
    if (htmlBlockType7(idx)) return 7;
    return 0;
  }
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return 0;
  // tag name
  let i = 0;
  while (i < rest.length && ((rest.charCodeAt(i) >= 65 && rest.charCodeAt(i) <= 90) || (rest.charCodeAt(i) >= 97 && rest.charCodeAt(i) <= 122) || (rest.charCodeAt(i) >= 48 && rest.charCodeAt(i) <= 57) || rest.charCodeAt(i) === 45)) i++;
  const name = rest.slice(0, i).toLowerCase();
  const after = rest.charCodeAt(i);
  const afterOk = i >= rest.length || after === 32 || after === 9 || after === 62 || after === 47;
  if (afterOk) {
    if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') return 1;
    if (BLOCK_TAGS.has(name)) return 6;
  }
  if (htmlBlockType7(idx)) return 7;
  return 0;
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// True when the line (from idx) is a single complete tag (type 7).
function htmlBlockType7(idx) {
  let i = idx + 1;
  const isClose = i < S.length && S.charCodeAt(i) === 47;
  if (isClose) i++; // '/'
  if (i >= S.length) return false;
  const c = S.charCodeAt(i);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  while (i < S.length && ((S.charCodeAt(i) >= 65 && S.charCodeAt(i) <= 90) || (S.charCodeAt(i) >= 97 && S.charCodeAt(i) <= 122) || (S.charCodeAt(i) >= 48 && S.charCodeAt(i) <= 57) || S.charCodeAt(i) === 45)) i++;
  if (isClose) {
    // closing tag: only whitespace and '>' may follow (no attributes)
    while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
    if (i >= S.length || S.charCodeAt(i) !== 62) return false;
    i++;
    while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
    return i >= S.length;
  }
  // attributes: (space+ name [= value])*
  for (;;) {
    const wsStart = i;
    while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
    if (i >= S.length) return false;
    const ch = S.charCodeAt(i);
    if (ch === 62) { // '>'
      i++;
      while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
      return i >= S.length;
    }
    if (ch === 47) { // '/'
      if (i + 1 < S.length && S.charCodeAt(i + 1) === 62) {
        i += 2;
        while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
        return i >= S.length;
      }
      return false;
    }
    // an attribute must be preceded by whitespace (so '<m:abc>' is not a tag)
    if (i === wsStart) return false;
    // attribute name
    if (!((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 58)) return false;
    while (i < S.length) {
      const a = S.charCodeAt(i);
      if ((a >= 65 && a <= 90) || (a >= 97 && a <= 122) || (a >= 48 && a <= 57) || a === 95 || a === 58 || a === 45 || a === 46) i++;
      else break;
    }
    const afterNameWs = i;
    while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
    if (i < S.length && S.charCodeAt(i) === 61) { // '='
      i++;
      while (i < S.length && (S.charCodeAt(i) === 32 || S.charCodeAt(i) === 9)) i++;
      if (i >= S.length) return false;
      const q = S.charCodeAt(i);
      if (q === 34 || q === 39) {
        i++;
        while (i < S.length && S.charCodeAt(i) !== q) i++;
        if (i >= S.length) return false;
        i++;
      } else {
        while (i < S.length) {
          const v = S.charCodeAt(i);
          if (v === 32 || v === 9 || v === 62 || v === 34 || v === 39 || v === 60 || v === 61 || v === 96) break;
          i++;
        }
        if (i >= S.length) return false;
      }
    } else {
      // valueless attribute: put back the whitespace skipped while looking
      // for '=' so the next iteration sees it as the separator
      i = afterNameWs;
    }
  }
}

// Tag name (lowercase) of a type-1 HTML block start at S[idx].
function htmlBlockTag(idx) {
  let i = idx + 1, name = '';
  while (i < S.length) {
    const c = S.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { name += S[i].toLowerCase(); i++; }
    else break;
  }
  return name;
}

// ================= inline parsing =================
// Node kinds: 0 text, 1 delimiter, 2 code, 3 link/image, 4 raw html, 5 <br>,
// 6 autolink, 7 open tag, 8 close tag, 9 raw text (entity, verbatim).
const EMAIL_LOCAL = /[A-Za-z0-9._+\-]/;
const EMAIL_LABEL = /[A-Za-z0-9_\-]/;

function isEmailLocalCh(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 || c === 95 || c === 43 || c === 45;
}
function isEmailLabelCh(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 45;
}

// Find the end of a code span starting at s[i] (a run of n backticks).
// Returns the index just past the closing run, or -1.
function codeSpanEnd(s, i, n) {
  let j = i + n;
  while (j < s.length) {
    if (s.charCodeAt(j) === 96) {
      let k = j;
      while (k < s.length && s.charCodeAt(k) === 96) k++;
      if (k - j === n) return k;
      j = k;
    } else j++;
  }
  return -1;
}

// Parse a numeric entity starting at s[i] === '&'. Returns {text, end} where
// text is the decoded string (already a JS string, to be escaped at render),
// or null when it is not a valid numeric entity.
function numericEntity(s, i) {
  // s[i] === '&', s[i+1] === '#'
  let j = i + 2, hex = false, num = 0, digits = 0, ok = false;
  if (j < s.length && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
  while (j < s.length) {
    const c = s.charCodeAt(j);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else break;
    if (d < 0 || (hex ? d > 15 : d > 9)) break;
    num = num * (hex ? 16 : 10) + d;
    digits++;
    j++;
    if (num > 0x10ffff) { /* keep scanning for the ';' but mark out of range */ }
  }
  if (digits === 0) return null;
  if (j >= s.length || s.charCodeAt(j) !== 59) return null; // ';'
  if (num > 0x10ffff) return null; // out of range: not an entity at all
  if (num === 0 || (num >= 0xd800 && num <= 0xdfff)) {
    return { text: '\ufffd', end: j + 1 };
  }
  return { text: String.fromCodePoint(num), end: j + 1 };
}

// Parse an inline HTML tag starting at s[i] === '<'.
// Returns {tag, end} or null. Sets/clears the module-level inLink flag for <a>.
function inlineHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j >= n) return null;
  const c = s.charCodeAt(j);
  if (c === 33) { // '!' comment / declaration / CDATA
    if (s.startsWith('!--', j)) {
      // abruptly-closed empty comments: '<!-->' and '<!--->'
      if (s.charCodeAt(j + 3) === 62) return { tag: s.slice(i, j + 4), end: j + 4 };
      if (s.charCodeAt(j + 3) === 45 && s.charCodeAt(j + 4) === 62) return { tag: s.slice(i, j + 5), end: j + 5 };
      const k = s.indexOf('-->', j + 4);
      if (k < 0) return null;
      return { tag: s.slice(i, k + 3), end: k + 3 };
    }
    if (s.startsWith('![CDATA[', j)) {
      const k = s.indexOf(']]>', j + 7);
      if (k < 0) return null;
      return { tag: s.slice(i, k + 3), end: k + 3 };
    }
    // declaration <!A ...> or <!D ...>
    if (j + 1 < n && ((s.charCodeAt(j + 1) >= 65 && s.charCodeAt(j + 1) <= 90) || (s.charCodeAt(j + 1) >= 97 && s.charCodeAt(j + 1) <= 122))) {
      const k = s.indexOf('>', j + 1);
      if (k < 0) return null;
      return { tag: s.slice(i, k + 1), end: k + 1 };
    }
    return null;
  }
  if (c === 63) { // '<?'
    const k = s.indexOf('?>', j + 1);
    if (k < 0) return null;
    return { tag: s.slice(i, k + 2), end: k + 2 };
  }
  if (c === 47) { // '</'
    j++;
    if (j >= n) return null;
    const t = s.charCodeAt(j);
    if (!((t >= 65 && t <= 90) || (t >= 97 && t <= 122))) return null;
    let k = j;
    while (k < n && (((s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) || (s.charCodeAt(k) >= 97 && s.charCodeAt(k) <= 122) || (s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) || s.charCodeAt(k) === 45))) k++;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k >= n || s.charCodeAt(k) !== 62) return null;
    const tag = s.slice(i, k + 1);
    if (tag.toLowerCase() === '</a>') inLink = false;
    return { tag, end: k + 1 };
  }
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return null;
  let k = j;
  while (k < n && (((s.charCodeAt(k) >= 65 && s.charCodeAt(k) <= 90) || (s.charCodeAt(k) >= 97 && s.charCodeAt(k) <= 122) || (s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) || s.charCodeAt(k) === 45))) k++;
  for (;;) {
    const wsStart = k;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k >= n) return null;
    const ch = s.charCodeAt(k);
    if (ch === 62) { // '>'
      const tag = s.slice(i, k + 1);
      if (tag.length >= 3 && tag[1].toLowerCase() === 'a' && tag[2] === ' ') inLink = true;
      return { tag, end: k + 1 };
    }
    if (ch === 47) { // '/'
      if (k + 1 < n && s.charCodeAt(k + 1) === 62) {
        const tag = s.slice(i, k + 2);
        if (tag.length >= 3 && tag[1].toLowerCase() === 'a' && tag[2] === ' ') inLink = true;
        return { tag, end: k + 2 };
      }
      return null;
    }
    // an attribute must be preceded by whitespace (so '<m:abc>' is not a tag)
    if (k === wsStart) return null;
    if (!((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 || ch === 58)) return null;
    while (k < n) {
      const a = s.charCodeAt(k);
      if ((a >= 65 && a <= 90) || (a >= 97 && a <= 122) || (a >= 48 && a <= 57) || a === 95 || a === 58 || a === 45 || a === 46) k++;
      else break;
    }
    const afterNameWs = k;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k < n && s.charCodeAt(k) === 61) { // '='
      k++;
      while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
      if (k >= n) return null;
      const q = s.charCodeAt(k);
      if (q === 34 || q === 39) {
        k++;
        while (k < n && s.charCodeAt(k) !== q) k++;
        if (k >= n) return null;
        k++;
      } else {
        while (k < n) {
          const v = s.charCodeAt(k);
          if (v === 32 || v === 9 || v === 10 || v === 62 || v === 34 || v === 39 || v === 60 || v === 61 || v === 96) break;
          k++;
        }
        if (k >= n) return null;
      }
    } else {
      // valueless attribute: put back the whitespace skipped while looking
      // for '=' so the next iteration sees it as the separator
      k = afterNameWs;
    }
  }
}

// Scan a GFM URL starting at s[i] (the first char after the scheme/www.).
// Returns {url, end} or null when nothing usable follows.
function scanGfmUrl(s, i) {
  let j = i;
  while (j < s.length && !isSpaceCh(s[j]) && s[j] !== '<') j++;
  if (j === i) return null;
  let url = s.slice(i, j), end = j;
  // strip trailing punctuation / entities / unbalanced parens, repeatedly
  for (;;) {
    let changed = false;
    // strip a trailing '&...;' entity-like suffix FIRST (before ';' is
    // stripped as punctuation, which would hide the entity)
    if (url.length && url.charCodeAt(url.length - 1) === 59) { // ';'
      const amp = url.lastIndexOf('&');
      if (amp >= 0) {
        const inner = url.slice(amp + 1, -1);
        if (/^[A-Za-z][A-Za-z0-9]*$/.test(inner) || /^#[0-9]+$/.test(inner) || /^#[xX][0-9A-Fa-f]+$/.test(inner)) {
          end -= url.length - amp;
          url = url.slice(0, amp); changed = true;
        }
      }
    }
    while (url.length) {
      const c = url.charCodeAt(url.length - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 || c === 42 || c === 95 || c === 126 || c === 39 || c === 34) {
        url = url.slice(0, -1); end--; changed = true;
      } else break;
    }
    if (url.length && url.charCodeAt(url.length - 1) === 41) { // ')'
      let open = 0, close = 0;
      for (let k = 0; k < url.length; k++) {
        if (url.charCodeAt(k) === 40) open++;
        else if (url.charCodeAt(k) === 41) close++;
      }
      if (close > open) { url = url.slice(0, -1); end--; changed = true; }
    }
    if (!changed) break;
  }
  // unmatched '(' : cut at the first one that never closes
  let depth = 0, cut = -1;
  for (let k = 0; k < url.length; k++) {
    const c = url.charCodeAt(k);
    if (c === 40) { if (depth === 0) cut = k; depth++; }
    else if (c === 41) { if (depth > 0) { depth--; if (depth === 0) cut = -1; } }
  }
  if (depth > 0 && cut >= 0) {
    url = url.slice(0, cut);
    end = i + cut;
  }
  if (!url.length) return null;
  return { url, end };
}

// Scan an email starting at s[i] (start of the local part). Returns {email, end} or null.
// True when an email starting at s[i] may autolink: it must not be
// preceded by an email-local character, but a run of '*' or '_' that is
// an emphasis delimiter (not literal text) does not count, so the check
// skips back over delimiter runs to the character before them.
function emailPrevOk(s, i) {
  // fast path: the previous character is not a delimiter run, so the
  // email is allowed unless it is an email-local character itself
  if (i === 0) return true;
  const pc = s.charCodeAt(i - 1);
  if (pc !== 42 && pc !== 95) return !isEmailLocalCh(pc);
  let j = i - 1;
  while (j >= 0) {
    const c = s.charCodeAt(j);
    if (c !== 42 && c !== 95) break; // not '*' or '_'
    let rs = j;
    while (rs - 1 >= 0 && s.charCodeAt(rs - 1) === c) rs--;
    // flanking of the run [rs..j]
    const prev = rs > 0 ? s[rs - 1] : '';
    const next = j + 1 < s.length ? s[j + 1] : '';
    const prevWs = prev === '' || isSpaceCh(prev);
    const nextWs = next === '' || isSpaceCh(next);
    const prevPunct = prev !== '' && isPunctCh(prev);
    const nextPunct = next !== '' && isPunctCh(next);
    const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
    const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
    let canOpen, canClose;
    if (c === 42) { canOpen = leftFlank; canClose = rightFlank; }
    else { canOpen = leftFlank && (!rightFlank || prevPunct); canClose = rightFlank && (!leftFlank || nextPunct); }
    if (!canOpen && !canClose) return false; // literal '_'/'*': blocks
    j = rs - 1; // skip the delimiter run
  }
  if (j < 0) return true;
  return !isEmailLocalCh(s.charCodeAt(j));
}

function scanEmail(s, i, trimSingleU) {
  let j = i;
  while (j < s.length && isEmailLocalCh(s.charCodeAt(j))) j++;
  if (j === i || j >= s.length || s.charCodeAt(j) !== 64) return null; // '@'
  let k = j + 1, labels = 0;
  for (;;) {
    const start = k;
    while (k < s.length && isEmailLabelCh(s.charCodeAt(k))) k++;
    if (k === start) return null;
    // a domain label must not end with '-' or '_', except that a run of
    // 2+ trailing '_' is a following emphasis closer ('__'), not part of
    // the domain: trim it so 'can@x.com__' links 'can@x.com'. A single
    // trailing '_' is trimmed only when the caller says an '_' opener is
    // pending (it is the emphasis closer, as in '_a@b.c_')
    let e2 = k;
    while (e2 > start && s.charCodeAt(e2 - 1) === 95) e2--;
    const trailU = k - e2;
    if (k > start && s.charCodeAt(k - 1) === 45) return null;
    if (trailU === 1 && !trimSingleU) return null;
    if (trailU >= 1) k = e2;
    if (k === start) return null;
    labels++;
    if (k < s.length && s.charCodeAt(k) === 46 && k + 1 < s.length && isEmailLabelCh(s.charCodeAt(k + 1))) { k++; continue; }
    break;
  }
  if (labels < 2) return null;
  return { email: s.slice(i, k), end: k };
}

// Angle autolink <...> starting at s[i] === '<'. Returns {href, text, end} or null.
function angleAutolink(s, i) {
  const close = s.indexOf('>', i + 1);
  if (close < 0) return null;
  const inner = s.slice(i + 1, close);
  if (!inner.length) return null;
  for (let k = 0; k < inner.length; k++) {
    const c = inner.charCodeAt(k);
    if (c === 32 || c === 10 || c === 60) return null;
  }
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  const m = /^[A-Za-z][A-Za-z0-9+.\-]{1,31}:/.exec(inner);
  if (m) {
    if (inner.length <= m[0].length) return null;
    return { href: inner, text: inner, end: close + 1 };
  }
  const em = scanEmail(inner, 0);
  if (em && em.end === inner.length) {
    return { href: 'mailto:' + em.email, text: em.email, end: close + 1 };
  }
  return null;
}

// Scan a link label starting at s[i] === '[' (marked's code-span-aware scan).
// Returns the index of the closing ']' or -1. A '[' inside the label (outside a
// code span) or an unclosed backtick run makes the scan fail.
// If s[j] === '<', return the index just past the closing '>' of the
// HTML tag / angle autolink starting there (quoted attribute values are
// honoured, so a ']' inside a quote or a tag is not a bracket), or -1
// if the tag is not properly closed.
function skipAngle(s, j) {
  if (s.startsWith('<!--', j)) {
    const e = s.indexOf('-->', j + 4);
    return e < 0 ? -1 : e + 3;
  }
  if (s.startsWith('<![CDATA[', j)) {
    const e = s.indexOf(']]>', j + 9);
    return e < 0 ? -1 : e + 3;
  }
  if (s.startsWith('<?', j)) {
    const e = s.indexOf('?>', j + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (s.startsWith('<!', j)) {
    const e = s.indexOf('>', j + 2);
    return e < 0 ? -1 : e + 1;
  }
  let k = j + 1;
  while (k < s.length) {
    const c = s.charCodeAt(k);
    if (c === 34 || c === 39) { // '"' or "'": quoted attribute value
      const q = c;
      k++;
      let closed = false;
      while (k < s.length) {
        if (s.charCodeAt(k) === q) { closed = true; k++; break; }
        k++;
      }
      if (!closed) return -1;
      continue;
    }
    if (c === 62) return k + 1; // '>'
    k++;
  }
  return -1;
}

// Find the matching ']' for the '[' at s[i] (nested brackets, code spans
// and backslash escapes handled). Returns the index or -1.
function scanBracketPair(s, i) {
  let depth = 0, j = i;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 96) {
      let k = j;
      while (k < s.length && s.charCodeAt(k) === 96) k++;
      const end = codeSpanEnd(s, j, k - j);
      j = end >= 0 ? end : k;
      continue;
    }
    if (c === 92 && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 60) { // '<': skip the tag/autolink so a ']' inside it is ignored
      const e = skipAngle(s, j);
      if (e < 0) return -1;
      j = e;
      continue;
    }
    if (c === 91) depth++;
    else if (c === 93) { depth--; if (depth === 0) return j; }
    j++;
  }
  return -1;
}

// If the '[' at s[j] starts a complete inline or reference link/image,
// return the index just past it; otherwise return -1.
function skipLink(s, j) {
  const innerEnd = scanBracketPair(s, j);
  if (innerEnd < 0) return -1;
  const after = innerEnd + 1;
  if (after < s.length && s.charCodeAt(after) === 40) { // '(' inline
    const p = parseInlineLink(s, after);
    return p ? p.end : -1;
  }
  if (after < s.length && s.charCodeAt(after) === 91) { // '[' reference
    const lab = scanLabel(s, after);
    return lab ? lab.end : -1;
  }
  return -1;
}

function scanLinkLabel(s, i, isImg) {
  // A LINK label may contain balanced nested brackets and images, but a
  // nested bracket pair that itself forms a link rejects the whole label.
  // An IMAGE label may also contain links: they are skipped as units.
  let depth = 0, j = i + 1;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === 96) { // backtick run: skip the code span (matching run length);
      // a run with no matching closer is literal text, not a failure
      let k = j;
      while (k < s.length && s.charCodeAt(k) === 96) k++;
      const end = codeSpanEnd(s, j, k - j);
      j = end >= 0 ? end : k;
      continue;
    }
    if (c === 92 && j + 1 < s.length && isPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 60) { // '<': skip the tag/autolink so a ']' inside it is ignored
      const e = skipAngle(s, j);
      if (e < 0) return -1;
      j = e;
      continue;
    }
    if (c === 91) {
      if (isImg) {
        // image label: skip an inner link as a unit
        const skipped = skipLink(s, j);
        if (skipped >= 0) { j = skipped; continue; }
      } else if (j > i + 1 && s.charCodeAt(j - 1) === 33) {
        // link label: an inner image is allowed, skip it as a unit
        const skipped = skipLink(s, j);
        if (skipped >= 0) { j = skipped; continue; }
      } else {
        const innerEnd = scanBracketPair(s, j);
        if (innerEnd >= 0) {
          const after = innerEnd + 1;
          if (after < s.length && (s.charCodeAt(after) === 40 || s.charCodeAt(after) === 91)) return -1;
          // a nested shortcut reference that resolves also rejects the label
          if (refs.has(normalizeLabel(s.slice(j + 1, innerEnd)))) return -1;
        }
      }
      depth++;
      j++;
      continue;
    }
    if (c === 93) {
      if (depth === 0) return j;
      depth--;
      j++;
      continue;
    }
    j++;
  }
  return -1;
}

// Parse a link destination + optional title starting at s[i] === '('.
// Returns {dest, title, end} (end = index just past ')') or null.
function parseInlineLink(s, i) {
  let j = i + 1;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  let dest = '';
  if (j < s.length && s.charCodeAt(j) === 60) { // '<...>'
    // Backslash escapes apply inside the angle destination: '\>' is an
    // escaped '>' (part of the destination), not the closing bracket.
    let k = j + 1, ok = false;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 62) { ok = true; break; }
      if (c === 60 || c === 10 || c === 9) return null;
      if (c === 92 && k + 1 < s.length && isPunctCode(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
      dest += s[k];
      k++;
    }
    if (!ok) return null;
    j = k + 1;
  } else {
    let depth = 0, k = j;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      if (c === 92 && k + 1 < s.length && isPunctCode(s.charCodeAt(k + 1))) { dest += s[k + 1]; k += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      dest += s[k];
      k++;
    }
    if (depth !== 0) return null;
    j = k;
  }
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  let title = '';
  if (j < s.length && s.charCodeAt(j) === 41) return { dest, title, end: j + 1 };
  if (j >= s.length) return null;
  const q = s.charCodeAt(j);
  if (q === 34 || q === 39) {
    let k = j + 1, ok = false;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 92 && k + 1 < s.length && isPunctCode(s.charCodeAt(k + 1))) { title += s[k + 1]; k += 2; continue; }
      if (c === q) { ok = true; break; }
      title += s[k];
      k++;
    }
    if (!ok) return null;
    j = k + 1;
  } else if (q === 40) {
    // parenthesised title: the opening '(' is not part of the title
    let depth = 1, k = j + 1, ok = false;
    while (k < s.length) {
      const c = s.charCodeAt(k);
      if (c === 92 && k + 1 < s.length && isPunctCode(s.charCodeAt(k + 1))) { title += s[k + 1]; k += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) { depth--; if (depth === 0) { ok = true; k++; break; } }
      title += s[k];
      k++;
    }
    if (!ok) return null;
    j = k;
  } else return null;
  while (j < s.length && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
  if (j >= s.length || s.charCodeAt(j) !== 41) return null;
  return { dest, title, end: j + 1 };
}

// Parse the inline content of a string into an items array (emphasis processed).
function parseInlineItems(s) {
  const items = [];
  let buf = '';
  const flush = () => { if (buf.length) { items.push({ k: 0, s: buf }); buf = ''; } };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 10) { // newline
      let sp = 0;
      while (sp < buf.length && buf.charCodeAt(buf.length - 1 - sp) === 32) sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp); flush(); items.push({ k: 5 });
        i++;
        // after a hard break, strip leading spaces/tabs of the next line
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
      } else {
        buf += '\n';
        i++;
      }
      continue;
    }
    if (c === 92) { // backslash
      if (i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (d === 10) {
          flush(); items.push({ k: 5 }); i += 2;
          // after a hard break, strip leading spaces/tabs of the next line
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          continue;
        }
        if (isPunctCode(d)) { // ASCII punctuation only (CommonMark 2.4)
          flush();
          items.push({ k: 10, s: s[i + 1] });
          i += 2;
          continue;
        }
      }
      buf += '\\'; i++;
      continue;
    }
    if (c === 96) { // code span
      let j = i;
      while (j < n && s.charCodeAt(j) === 96) j++;
      const run = j - i;
      const end = codeSpanEnd(s, i, run);
      if (end >= 0) {
        let content = s.slice(j, end - run).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.indexOf(' ') !== content.lastIndexOf(' ')) {
          // only strip when the content is not all spaces
          let allSpace = true;
          for (let q = 0; q < content.length; q++) if (content.charCodeAt(q) !== 32) { allSpace = false; break; }
          if (!allSpace) content = content.slice(1, -1);
        }
        flush();
        items.push({ k: 2, s: content });
        i = end;
        continue;
      }
      buf += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      const run = j - i;
      // strikethrough only uses runs of 1-2 '~'; a longer run is literal text
      if (c === 126 && run >= 3) { buf += s.slice(i, j); i = j; continue; }
      const prev = i > 0 ? s[i - 1] : '';
      const next = j < n ? s[j] : '';
      const prevWs = prev === '' || isSpaceCh(prev);
      const nextWs = next === '' || isSpaceCh(next);
      const prevPunct = prev !== '' && isPunctCh(prev);
      const nextPunct = next !== '' && isPunctCh(next);
      const leftFlank = !nextWs && (!nextPunct || prevWs || prevPunct);
      const rightFlank = !prevWs && (!prevPunct || nextWs || nextPunct);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlank && (!rightFlank || prevPunct);
        canClose = rightFlank && (!leftFlank || nextPunct);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flush();
      items.push({ k: 1, c: String.fromCharCode(c), n: run, o: canOpen, cl: canClose });
      i = j;
      continue;
    }
    if (c === 91 || (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91)) { // [ or ![
      const isImg = c === 33;
      const link = tryLink(s, isImg ? i + 1 : i, isImg);
      if (link) { flush(); items.push(link.node); i = link.end; continue; }
      buf += s[i];
      i++;
      continue;
    }
    if (c === 60) { // <
      const auto = angleAutolink(s, i);
      if (auto) { flush(); items.push({ k: 6, href: auto.href, text: auto.text }); i = auto.end; continue; }
      const tag = inlineHtmlTag(s, i);
      if (tag) { flush(); items.push({ k: 4, s: tag.tag }); i = tag.end; continue; }
      buf += '<';
      i++;
      continue;
    }
    if (c === 38) { // &
      if (i + 1 < n && s.charCodeAt(i + 1) === 35) {
        const ne = numericEntity(s, i);
        if (ne) { flush(); items.push({ k: 10, s: ne.text }); i = ne.end; continue; }
      } else {
        let m2 = i + 1;
        while (m2 < n && ((s.charCodeAt(m2) >= 65 && s.charCodeAt(m2) <= 90) || (s.charCodeAt(m2) >= 97 && s.charCodeAt(m2) <= 122) || (s.charCodeAt(m2) >= 48 && s.charCodeAt(m2) <= 57))) m2++;
        if (m2 > i + 1 && m2 < n && s.charCodeAt(m2) === 59) {
          flush();
          items.push({ k: 9, s: s.slice(i, m2 + 1) });
          i = m2 + 1;
          continue;
        }
      }
      buf += '&';
      i++;
      continue;
    }
    if (!inLink) {
      if (c === 104 || c === 72 || c === 102 || c === 70) { // h H f F
        const rest = s.slice(i, i + 8).toLowerCase();
        let schemeLen = 0;
        if (rest.startsWith('https://')) schemeLen = 8;
        else if (rest.startsWith('http://')) schemeLen = 7;
        else if (rest.startsWith('ftp://')) schemeLen = 6;
        if (schemeLen > 0) {
          const u = scanGfmUrl(s, i + schemeLen);
          if (u) {
            const url = s.slice(i, u.end);
            flush();
            items.push({ k: 6, href: url, text: url });
            i = u.end;
            continue;
          }
        }
      }
      if (c === 119 && s.startsWith('www.', i)) { // www.
        const prev = i > 0 ? s[i - 1] : '';
        const prevOk = prev === '' || isSpaceCh(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~';
        if (prevOk) {
          const u = scanGfmUrl(s, i + 4);
          if (u && u.url.length > 0) {
            const after = u.url;
            const slash = after.indexOf('/');
            const domain = slash < 0 ? after : after.slice(0, slash);
            if (domain.indexOf('.') >= 0) {
              const url = 'www.' + u.url;
              flush();
              items.push({ k: 6, href: 'http://' + url, text: url });
              i = u.end;
              continue;
            }
          }
        }
      }
      if (isEmailLocalCh(c)) {
        if (emailPrevOk(s, i)) {
          // a pending '_' opener means a single trailing '_' after the
          // domain is the emphasis closer, not part of the email
          let trimSingleU = false;
          for (let q = items.length - 1; q >= 0; q--) {
            const it = items[q];
            if (it.k === 1 && it.c === '_' && it.o) { trimSingleU = true; break; }
            if (it.k === 7 || it.k === 8) break;
          }
          const em = scanEmail(s, i, trimSingleU);
          if (em) {
            // a scheme prefix ('mailto:' / 'xmpp:' / any scheme) right
            // before the email is part of the autolink
            let href = 'mailto:' + em.email, text = em.email;
            let end = em.end;
            if (i >= 2 && s.charCodeAt(i - 1) === 58) { // ':'
              let jj = i - 2;
              while (jj >= 0 && ((s.charCodeAt(jj) >= 65 && s.charCodeAt(jj) <= 90) || (s.charCodeAt(jj) >= 97 && s.charCodeAt(jj) <= 122) || (s.charCodeAt(jj) >= 48 && s.charCodeAt(jj) <= 57) || s.charCodeAt(jj) === 43 || s.charCodeAt(jj) === 45 || s.charCodeAt(jj) === 46)) jj--;
              const schemeStart = jj + 1;
              const schemeLen = (i - 1) - schemeStart;
              const sc0 = schemeStart < s.length ? s.charCodeAt(schemeStart) : 0;
              if (schemeLen >= 2 && schemeLen <= 32 && ((sc0 >= 65 && sc0 <= 90) || (sc0 >= 97 && sc0 <= 122))) {
                // a scheme+email autolink may carry ONE path segment
                end = em.end;
                if (end < s.length && s.charCodeAt(end) === 47) { // '/'
                  let k = end + 1;
                  while (k < s.length) {
                    const cc = s.charCodeAt(k);
                    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 46 || cc === 95 || cc === 45 || cc === 43 || cc === 64 || cc === 126 || cc === 37 || cc === 61) k++;
                    else break;
                  }
                  // strip trailing punctuation from the segment
                  while (k > end + 1) {
                    const cc = s.charCodeAt(k - 1);
                    if (cc === 46 || cc === 44 || cc === 63 || cc === 33 || cc === 59 || cc === 58 || cc === 42 || cc === 95 || cc === 126 || cc === 39 || cc === 34) k--;
                    else break;
                  }
                  if (k > end + 1) end = k;
                }
                href = s.slice(schemeStart, end);
                text = s.slice(schemeStart, end);
                // the scheme text is already in buf: take it back out
                buf = buf.slice(0, buf.length - (i - schemeStart));
              }
            }
            flush();
            items.push({ k: 6, href, text });
            i = end;
            continue;
          }
        }
      }
    }
    buf += s[i];
    i++;
  }
  flush();
  processEmphasis(items);
  return items;
}

function inline(s) {
  return renderInline(parseInlineItems(s));
}

// Resolve backslash escapes (ASCII punctuation) in a label string.
function resolveLabelEscapes(t) {
  if (t.indexOf('\\') < 0) return t;
  let out = '';
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) === 92 && i + 1 < t.length && isPunctCode(t.charCodeAt(i + 1))) { out += t[i + 1]; i++; }
    else out += t[i];
  }
  return out;
}

function tryLink(s, i, isImg) {
  const labelEnd = scanLinkLabel(s, i, isImg);
  if (labelEnd < 0) return null;
  const labelText = s.slice(i + 1, labelEnd);
  const after = labelEnd + 1;
  let dest = null, title = '', end = -1;
  if (after < s.length && s.charCodeAt(after) === 40) { // '('
    const p = parseInlineLink(s, after);
    if (p) { dest = p.dest; title = p.title; end = p.end; }
  } else if (after < s.length && s.charCodeAt(after) === 91) { // '['
    const lab2 = scanLabel(s, after);
    if (lab2) {
      const refLabel = lab2.label.length ? lab2.label : labelText;
      const ref = refs.get(normalizeLabel(refLabel));
      if (ref) { dest = ref.dest; title = ref.title; end = lab2.end; }
      else {
        // syntactically valid reference label but undefined: no shortcut
        // fallback (the label stays literal, e.g. '[foo][bar][baz]')
        return null;
      }
    }
  }
  if (dest === null) {
    // shortcut reference fallback (also when an inline/full reference
    // fails to parse or resolve: '[foo](not a link)' still links '[foo]')
    const ref = refs.get(normalizeLabel(labelText));
    if (!ref) return null;
    dest = ref.dest; title = ref.title; end = after;
  }
  const prevLink = inLink;
  inLink = true;
  const labelItems = parseInlineItems(labelText);
  inLink = prevLink;
  if (isImg) {
    return { node: { k: 3, img: true, href: dest, title, alt: plainText(labelItems) }, end };
  }
  return { node: { k: 3, img: false, href: dest, title, ch: labelItems }, end };
}

// Plain-text rendering of label items (for image alt text).
function plainText(items) {
  let out = '';
  for (const it of items) {
    switch (it.k) {
      case 0: out += escText(it.s); break;
      case 1: out += it.c.repeat(it.n); break;
      case 2: out += escCode(it.s); break;
      case 3: out += it.img ? it.alt : plainText(it.ch); break;
      case 4: out += escText(it.s); break;
      case 5: out += '\n'; break;
      case 6: out += escText(it.text); break;
      case 7: case 8: break;
      case 9: out += it.s; break;
      case 10: out += escCode(it.s); break;
    }
  }
  return out;
}

function oddMatch(opener, closer) {
  if ((opener.o && opener.cl) || (closer.o && closer.cl)) {
    const sum = opener.n + closer.n;
    if (sum % 3 === 0 && !(opener.n % 3 === 0 && closer.n % 3 === 0)) return true;
  }
  return false;
}

function processEmphasis(items) {
  const delims = [];
  for (let i = 0; i < items.length; i++) if (items[i].k === 1) delims.push(items[i]);
  const bottom = { '*': null, '_': null, '~': null };
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.cl || closer.sealed) { ci++; continue; }
    let oi = -1;
    for (let j = ci - 1; j >= 0; j--) {
      const op = delims[j];
      if (op === bottom[closer.c]) break;
      if (op.c !== closer.c || !op.o || op.sealed) continue;
      if (oddMatch(op, closer)) continue;
      oi = j; break;
    }
    if (oi === -1) {
      // a closer that can also open stays available as an opener;
      // only a closer that cannot open becomes the bottom
      if (!closer.o) bottom[closer.c] = closer;
      ci++;
      continue;
    }
    const opener = delims[oi];
    const use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const tag = closer.c === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
    // a delimiter inside the emphasis just formed can never match a
    // delimiter outside it: seal every delimiter between opener and closer
    for (let j = oi + 1; j < ci; j++) delims[j].sealed = true;
    // a strong emphasis whose closer can also open seals the single-*
    // delimiters before its opener when the opener itself cannot close:
    // a later closer cannot reach past it to form an outer <em>
    if (use === 2 && closer.o && !opener.cl) {
      for (let j = 0; j < oi; j++) if (delims[j].c === closer.c && delims[j].n === 1) delims[j].sealed = true;
    }
    opener.n -= use; closer.n -= use;
    const oiPos = items.indexOf(opener);
    if (opener.n > 0) items.splice(oiPos + 1, 0, { k: 7, tag: '<' + tag + '>' });
    else {
      items.splice(oiPos, 1, { k: 7, tag: '<' + tag + '>' });
      delims.splice(oi, 1);
      if (bottom[opener.c] === opener) bottom[opener.c] = null;
      if (oi < ci) ci--;
    }
    const cPos = items.indexOf(closer);
    if (closer.n > 0) {
      // the closer still has delimiters left: re-examine it so it can
      // close an outer emphasis as well (do not advance ci)
      items.splice(cPos, 0, { k: 8, tag: '</' + tag + '>' });
    } else {
      items.splice(cPos, 1, { k: 8, tag: '</' + tag + '>' });
      delims.splice(ci, 1);
      if (bottom[closer.c] === closer) bottom[closer.c] = null;
    }
  }
}

function renderInline(items) {
  let out = '';
  for (const it of items) {
    switch (it.k) {
      case 0: out += escText(it.s); break;
      case 1: out += it.c.repeat(it.n); break;
      case 2: out += '<code>' + escCode(it.s) + '</code>'; break;
      case 3: {
        if (it.img) {
          out += '<img src="' + escAttr(encodeHref(it.href)) + '" alt="' + it.alt + '"';
          if (it.title) out += ' title="' + escAttr(it.title) + '"';
          out += '>';
        } else {
          out += '<a href="' + escAttr(encodeHref(it.href)) + '"';
          if (it.title) out += ' title="' + escAttr(it.title) + '"';
          out += '>' + renderInline(it.ch) + '</a>';
        }
        break;
      }
      case 4: out += it.s; break;
      case 5: out += '<br>'; break;
      case 6: out += '<a href="' + escAttr(encodeHref(it.href)) + '">' + escText(it.text) + '</a>'; break;
      case 7: case 8: out += it.tag; break;
      case 9: out += it.s; break;
      case 10: out += escCode(it.s); break;
    }
  }
  return out;
}

// ================= block rendering =================
function renderBlock(b, isLast) {
  switch (b.t) {
    case PARA: return '<p>' + inline(b.lines.join('\n')) + '</p>\n';
    case HEAD: return '<h' + b.level + '>' + inline(b.lines.join('\n')) + '</h' + b.level + '>\n';
    case HR: return '<hr>\n';
    case FENCE: {
      const info = b.info || '';
      let lang = '';
      const sp = info.search(/[ \t]/);
      lang = sp < 0 ? info : info.slice(0, sp);
      const lines = (b.lines || []).slice();
      // the blank line immediately before the closing fence is dropped
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const content = lines.length ? lines.join('\n') + '\n' : '';
      return '<pre><code' + (lang ? ' class="language-' + escAttr(lang) + '"' : '') + '>' + escCode(content) + '</code></pre>\n';
    }
    case INDCODE: {
      const lines = (b.lines || []).slice();
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      const text = lines.join('\n');
      const content = text.length ? text + '\n' : '';
      return '<pre><code>' + escCode(content) + '</code></pre>\n';
    }
    case HTML: {
      const text = (b.lines || []).join('\n');
      // type 6/7 blocks nested in a container never keep a trailing
      // newline; type 1-5 blocks keep it unless they end at a blank line,
      // or they are the last block and the source does not end with one
      const nestedStrip = b.parent.t !== DOC && b.htype >= 6;
      return text + ((b.blankEnd || nestedStrip || (isLast && !srcEndsNL)) ? '' : '\n');
    }
    case BQ: {
      let out = '<blockquote>\n';
      for (const c of b.ch || []) out += renderBlock(c);
      return out + '</blockquote>\n';
    }
    case LIST: {
      let out;
      if (b.ordered) out = '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
      else out = '<ul>\n';
      for (const c of b.ch || []) out += renderItem(c, b.tight);
      return out + (b.ordered ? '</ol>\n' : '</ul>\n');
    }
    case TABLE: return renderTable(b);
    default: return '';
  }
}

function renderItem(item, tight) {
  let out = '<li>';
  let first = true;
  for (const c of item.ch || []) {
    if (c.t === PARA) {
      let text = c.lines.join('\n');
      let task = '';
      if (first) {
        // task list: '[ ] ' / '[x] ' / '[X] ' at the start of the first line
        const m = /^\[( |x|X)\] /.exec(text);
        if (m) {
          task = m[1] === ' ' ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ';
          text = text.slice(4);
        }
      }
      first = false;
      if (tight) out += task + inline(text);
      else out += '<p>' + task + inline(text) + '</p>\n';
    } else if (c.t === TABLE) {
      first = false;
      out += renderTable(c);
    } else if (c.t === ITEM) {
      first = false;
      out += renderItem(c, tight);
    } else {
      first = false;
      out += renderBlock(c);
    }
  }
  return out + '</li>\n';
}

function renderTable(b) {
  const cols = b.align.length;
  const headCells = splitTableRow(b.lines[0]);
  let out = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < cols; i++) {
    const cell = i < headCells.length ? headCells[i].trim() : '';
    const al = b.align[i];
    out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + inline(cell) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  const rows = b.rows || [];
  if (rows.length) {
    out += '<tbody>';
    for (const row of rows) {
      const cells = splitTableRow(row);
      out += '<tr>\n';
      for (let i = 0; i < cols; i++) {
        const cell = i < cells.length ? cells[i].trim() : '';
        const al = b.align[i];
        out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + inline(cell) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody>';
  }
  return out + '</table>\n';
}

// ================= entry point =================
export function parse(src) {
  refs = new Map();
  inLink = false;
  src = src.replace(/\r\n?/g, '\n');
  srcEndsNL = src.endsWith('\n');
  const all = src.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const doc = mk(DOC);
  stack = [doc];
  for (let li = 0; li < all.length; li++) processLine(all[li]);
  while (stack.length > 1) closeBlock(stack.pop());
  let out = '';
  const ch = doc.ch || [];
  for (let i = 0; i < ch.length; i++) out += renderBlock(ch[i], i === ch.length - 1);
  return out;
}
