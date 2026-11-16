// A drop-in replacement for marked 18.1.3 (default options: gfm on, breaks
// off, pedantic off, async off). parse(markdown) returns exactly the HTML
// marked renders for that string.
//
// How it works: a hand-written fast renderer (fast.js) handles the
// constructs that dominate real documents; anything outside its envelope
// falls back to the vendored marked 18.1.3
// (vendor/marked/marked.esm.js, MIT, with its LICENSE and NOTICE), so
// correctness never depends on the fast path alone. parse keeps no state
// between calls: it returns for each input what it returns for that input
// alone.

import { marked } from './vendor/marked/marked.esm.js';
import { fastRender } from './fast.js';

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  return fastRender(markdown, (input) => marked.parse(input));
}
