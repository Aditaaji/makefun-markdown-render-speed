import { renderFast } from './fast.js';
import { marked } from './vendor/marked/marked.esm.js';

export const BAIL = 'fast-bail';

export function parse(src) {
  try {
    return renderFast(src);
  } catch (err) {
    if (err instanceof Error && err.message === BAIL) {
      return marked.parse(src);
    }
    throw err;
  }
}
