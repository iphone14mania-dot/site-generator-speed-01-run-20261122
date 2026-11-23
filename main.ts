// Driver for the fast static site generator: the harness runs `node main.ts`
// (node22). v2: fused single-pass markdown, compiled templates, V8 flags
// tuned for a single cold run (see solve.js header for the speed notes).
// run() from solve.js, and writes /output/answers.json — one answer per case,
// in the cases' order. Outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off and the optimising compiler off, set before
// solve.js is imported so all of its work runs under them (the rules allow an
// entry to tune V8's flags this way). Every graded run is a fresh process,
// and the hot paths run only a few thousand times each — measured cold,
// TurboFan's compile cost exceeds what it would save on a single pass, so
// the baseline compiler alone is faster here. Concurrent marking is off too:
// with one CPU and a short batch run, background marking threads cost more
// CPU than they save. The old space is pre-sized at 256 MiB so the heap
// never grows mid-run (the input is ~3 MiB of JSON and the output ~7.4 MiB;
// the sandbox allows 1 GiB, so 256 MiB is safe headroom). (--single-threaded
// is NOT set: flipping it at runtime crashes this V8 build in the garbage
// collector.)
setFlagsFromString('--no-incremental-marking --no-opt --no-concurrent-marking --initial-old-space-size=256');

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
for (let i = 0; i < cases.length; i++) answers.push(run(cases[i].input));
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
