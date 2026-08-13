#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: no unbounded `await new Promise(r => requestAnimationFrame(r))` in the
 * viewer's load / clash / IDS pipelines (#2385).
 *
 * A hidden tab never delivers an animation frame, so an unbounded frame wait
 * parks the whole completion path — finalize, WASM handle release,
 * `setLoading(false)` — until the user comes back to the tab. The fix is
 * `nextFrameOrTimeout()`, whose behaviour is pinned by
 * `apps/viewer/src/utils/frameWait.test.ts`.
 *
 * THIS half is a lint, not a test, and it lived in that test file until #2434
 * moved it here. That mattered: "nobody re-introduced a bare rAF" is an
 * absence claim over five unrelated files, so a `readFileSync` + `includes`
 * was the only shape it could ever have — which meant one entry in a test file
 * could never be behavioural and blocked the whole file from being converted.
 * Naming it a check makes the shape honest and leaves the test file executable
 * from end to end.
 *
 * Run via `node scripts/check-unbounded-frame-wait.mjs` (CI node-test job).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The pipelines whose completion path is user-visible. Deliberately a list and
 * not a directory walk: a bounded frame wait is fine everywhere, and it is
 * these five where an unbounded one strands a load.
 */
const FILES = [
  'apps/viewer/src/hooks/useIfcLoader.ts',
  'apps/viewer/src/hooks/useClash.ts',
  'apps/viewer/src/hooks/useIDS.ts',
  'apps/viewer/src/components/viewer/ClashPanel.tsx',
  'apps/viewer/src/store/basketSave.ts',
];

/**
 * Scan a forward WINDOW, not a single line: an `await new Promise(...)` whose
 * `requestAnimationFrame` is wrapped onto the next line is the same defect, and
 * a single-line match would miss it.
 */
const WINDOW = 10;

/** Lines of context searched for a deliberate-unbounded-wait escape hatch. */
const PREAMBLE = 8;

const violations = [];
const scanned = [];

for (const rel of FILES) {
  // Fail closed: a renamed file must break this check rather than silently
  // stop being scanned. An absence guard that scans nothing passes forever.
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  scanned.push(rel);
  lines.forEach((line, i) => {
    if (!line.includes('await new Promise')) return;
    const window = lines.slice(i, i + WINDOW).join('\n');
    if (!window.includes('requestAnimationFrame')) return;
    // Bounded already: either a hand-rolled race against a timer, or the
    // shared helper. Both are fine; only an UNBOUNDED wait is the defect.
    if (window.includes('setTimeout(') || window.includes('nextFrameOrTimeout(')) return;
    // A deliberate unbounded wait declares itself in the preceding comment.
    const preamble = lines.slice(Math.max(0, i - PREAMBLE), i).join('\n');
    if (preamble.includes('FRAME-WAIT-ALLOW')) return;
    violations.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error('\nUnbounded animation-frame waits (#2385):\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error(`
A hidden tab never delivers a frame, so these park the completion path until
the user returns. Use nextFrameOrTimeout() from apps/viewer/src/utils/frameWait.ts.

If the wait genuinely must be unbounded, mark it with a FRAME-WAIT-ALLOW
comment in the eight lines above and say why.
`);
  process.exit(1);
}

console.log(`check-unbounded-frame-wait: OK (${scanned.length} files scanned, 0 violations)`);
