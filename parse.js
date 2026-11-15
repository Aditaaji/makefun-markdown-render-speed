// Drop-in replacement for marked 18.1.3 (default options: gfm on, breaks off,
// pedantic off, async off). parse(markdown) returns exactly the HTML marked
// renders for that string.
//
// Strategy: a hand-written fast path (fast.js) renders the constructs that
// dominate real documents; anything outside its envelope falls back to the
// vendored marked 18.1.3 (vendor/marked/marked.esm.js, MIT, kept byte for
// byte with its LICENSE and NOTICE), so correctness never depends on the
// fast path alone. No state is kept between calls: parse returns for each
// input what it returns for that input alone.

import { marked } from './vendor/marked/marked.esm.js';
import { fastParse } from './fast.js';

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const fast = fastParse(markdown);
  if (fast !== null) return fast;
  return marked.parse(markdown);
}
