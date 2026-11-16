// Driver for markdown-render-speed-02: reads every case from
// MAKEFUN_INPUT_DIR (or /input), renders each one alone with parse()
// from parse.js, and writes the HTML strings in order to
// MAKEFUN_OUTPUT_DIR (or /output) as html.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i]!.markdown);
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
