#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * Guard: the collab recipient's `reconstruct` must re-derive placement from the
 * doc, and must forget its applied-placement bookkeeping when it re-hydrates.
 *
 * Geometry reaches a recipient as blobs baked at `meta.placementBaseline`;
 * `hydrateGeometryFromRoom` reads `blobHash` only, so a hydrated mesh always
 * lands at the bake. Only a live `usd::xformop` *event* ever moved it, which
 * loses a late joiner's placement outright, and — because a peer create/delete
 * re-hydrates every mesh — silently reverts applied moves during ordinary
 * two-person work.
 *
 * `placement-sweep.ts` implements the re-derivation and is unit-tested
 * (`placement-sweep.test.ts`, which pins all three failure modes). This file
 * pins the WIRING, because that is the half a unit test cannot reach:
 * `startCollab`'s recipient branch needs jsdom, IndexedDB, `import.meta.env`
 * and a websocket, so it is not drivable under `tsx --test`. Deleting both
 * calls below leaves `tsc --noEmit` clean and the viewer suite green — an
 * extracted unit, fully tested, with a deletable call site.
 *
 * Three things are required, and ORDER is one of them:
 *
 *   1. the geometry branch calls `clearAppliedPlacements(...)` BEFORE
 *      `hydrateGeometryFromRoom(...)`. The fresh meshes are back at the bake,
 *      so a surviving applied entry makes the sweep a no-op and *pins* the
 *      revert. Clearing after the sweep would be worse than not clearing.
 *   2. `sweepPlacements(...)` runs AFTER the hydrate, so it reconciles the
 *      meshes that were just rebuilt rather than the ones they replaced.
 *   3. the sweep is inside the reconstruct, not merely imported.
 *
 * WHAT THIS DOES NOT PROVE: it matches source text in one region of one file,
 * with no scope or control-flow analysis. A call guarded by `if (false)`, or
 * moved into a helper called from the region, satisfies it. That direction is
 * deliberate — the gate can miss a bad wiring, it cannot invent one, and a gate
 * that rejects a correct refactor gets disabled.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLICE = 'apps/viewer/src/store/slices/collabSlice.ts';
const source = readFileSync(join(repoRoot, SLICE), 'utf8');

const failures = [];

/** Line number (1-based) of `needle`'s first occurrence at/after `from`. */
function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * The recipient's re-derivation block. Delimited by text, so renaming or
 * extracting it fails the gate rather than silently scanning nothing.
 */
const START = 'const reconstruct = async () => {';
const END = '// Initial build (only when we don';
const startIdx = source.indexOf(START);
const endIdx = source.indexOf(END);

if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(
    `check-collab-placement-sweep: cannot find the recipient reconstruct block in ${SLICE}.\n\n` +
      `Looked for ${JSON.stringify(START)} … ${JSON.stringify(END)}. If the block was renamed or\n` +
      `moved, update the markers here — do NOT drop the check: the placement sweep it pins is\n` +
      `the only thing that re-derives a hydrated mesh's position from the doc.`,
  );
  process.exit(1);
}

const region = source.slice(startIdx, endIdx);
const at = (needle) => {
  const i = region.indexOf(needle);
  return i === -1 ? -1 : i;
};

const clearIdx = at('clearAppliedPlacements(');
const hydrateIdx = at('hydrateGeometryFromRoom(');
const sweepIdx = at('sweepPlacements(');

if (hydrateIdx === -1) {
  failures.push(
    `${SLICE}: the reconstruct block no longer calls \`hydrateGeometryFromRoom(\` — this gate's\n` +
      `  ordering checks are anchored on it. Re-anchor them rather than removing the gate.`,
  );
}

if (sweepIdx === -1) {
  failures.push(
    `${SLICE}: the reconstruct block never calls \`sweepPlacements(\`.\n` +
      `  A hydrated mesh sits at the placement its blob was BAKED at. Without the sweep, a late\n` +
      `  joiner renders every moved element in the wrong place and never finds out, because no\n` +
      `  placement event is coming — the move predates its session.`,
  );
} else if (hydrateIdx !== -1 && sweepIdx < hydrateIdx) {
  failures.push(
    `${SLICE}:${lineOf(source, startIdx + sweepIdx)}: \`sweepPlacements(\` runs BEFORE\n` +
      `  \`hydrateGeometryFromRoom(\`. It would then reconcile the meshes that are about to be\n` +
      `  replaced, and the fresh ones would render at their bake.`,
  );
}

if (clearIdx === -1) {
  failures.push(
    `${SLICE}: the reconstruct block never calls \`clearAppliedPlacements(\`.\n` +
      `  Re-hydration rebuilds every mesh from its baked blob, so \`placementAppliedLoc\` /\n` +
      `  \`placementAppliedYaw\` now describe meshes that no longer exist. Left in place, that\n` +
      `  stale bookkeeping makes the sweep a no-op — so a peer's ordinary create or delete\n` +
      `  reverts every applied move, permanently and silently.`,
  );
} else if (hydrateIdx !== -1 && clearIdx > hydrateIdx) {
  failures.push(
    `${SLICE}:${lineOf(source, startIdx + clearIdx)}: \`clearAppliedPlacements(\` runs AFTER\n` +
      `  \`hydrateGeometryFromRoom(\`. It has to precede the re-hydrate, so the sweep that follows\n` +
      `  sees the drift instead of reading "already applied" off bookkeeping for meshes that\n` +
      `  were just thrown away.`,
  );
}

if (failures.length > 0) {
  console.error('check-collab-placement-sweep FAILED:\n');
  for (const f of failures) console.error(`- ${f}\n`);
  console.error(
    'See apps/viewer/src/lib/collab/placement-sweep.ts for what each call is for, and\n' +
      'apps/viewer/src/lib/collab/placement-sweep.test.ts for the three failure modes.',
  );
  process.exit(1);
}

console.log(
  'check-collab-placement-sweep: OK (reconstruct clears applied placements before re-hydrating, ' +
    'and sweeps the doc after)',
);
