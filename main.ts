// Titik masuk untuk markdown-render-speed-02. Grader menjalankan
// `node /bot/main.ts` di Node 22, yang menghapus tipe TypeScript
// secara native (hanya sintaks erasable). File ini membaca tiap kasus
// dari /input/cases.json — array JSON berisi {id, markdown} —
// merender satu per satu dengan parse() dari parse.js, lalu menulis
// /output/html.json: array JSON berisi string HTML, satu per kasus,
// dalam urutan yang sama dengan kasusnya. Di luar container, variabel
// lingkungan MAKEFUN_INPUT_DIR dan MAKEFUN_OUTPUT_DIR menggantikan
// /input dan /output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type InputCase = { id: string; markdown: string };

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const rawCases = readFileSync(join(inDir, 'cases.json'), 'utf8');
const inputCases = JSON.parse(rawCases) as InputCase[];
const htmlOut = inputCases.map((entry) => parse(entry.markdown));
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'html.json'), JSON.stringify(htmlOut));
