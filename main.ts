// Driver for the fast static site generator: the harness runs `node main.ts`
// (node22). It reads every case from /input/cases.json, answers each one with
// run() from solve.js, and writes /output/answers.json — one answer per case,
// in the cases' order. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off and the optimising compilers off, set before
// solve.js is imported so all of its work runs under them (the rules allow an
// entry to tune V8's flags this way). Every graded run is a fresh process, so
// the optimisers' compile cost exceeds what they would save on a single pass;
// the baseline compiler alone is faster here. (--single-threaded is NOT set:
// flipping it at runtime crashes this V8 build in the garbage collector.)
setFlagsFromString('--no-incremental-marking --no-opt');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
