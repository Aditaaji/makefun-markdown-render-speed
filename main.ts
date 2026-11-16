import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR || '';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR || '';
const cases: { id: string; markdown: string }[] = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html: string[] = cases.map((c) => parse(c.markdown));
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
