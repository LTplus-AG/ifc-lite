#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: everything that crosses a collab room's boundary must address the ROOM
 * model by id — never "whatever model is active" (#2705, and the edit paths).
 *
 * `setIfcDataStore` / `setGeometryResult` and the top-level `ifcDataStore`
 * track `activeModelId` (dataSlice.ts), and `upsertModel` keeps the existing
 * `activeModelId` rather than switching to the model it creates
 * (modelSlice.ts). So a user who joins a room and then loads and selects their
 * own file — two clicks — has a different model active, and every path that
 * said "active" meant the wrong model:
 *
 *   1. the recipient's `reconstruct` replaced the user's own store and meshes
 *      with the room's on the next peer edit (#2705; repaired by a reload);
 *   2. inbound peer edits were replayed into the user's own model's view under
 *      a room-id-space expressId, landing in `undoStacks`, `dirtyModels` and
 *      the export path (survives a reload);
 *   3. outbound, the user's edits on their PRIVATE model were mirrored into the
 *      shared room and applied to whatever entity the id resolved to there.
 *
 * The fixes are `applyRoomModelData` (room-model-apply.ts) and the resolvers in
 * room-model-target.ts, both unit-tested. THIS file pins the wiring, which is
 * the half that was wrong and the half no test holds: reverting the call sites
 * leaves `tsc --noEmit` clean and the whole viewer suite green, because the
 * collab session path needs jsdom, module mocking, `import.meta.env`,
 * IndexedDB and a websocket and so cannot be driven under `tsx --test`.
 *
 * An absence claim over a few regions of two files is a lint, not a unit test,
 * so it lives here — `scripts/check-source-text-assertions.mjs` forbids exactly
 * this shape inside a test file, and `check-unbounded-frame-wait.mjs` /
 * `check-wasm-disposal.mjs` are the same shape for the same reason.
 *
 * Every check below fails closed: a region that cannot be located, or that no
 * longer routes through the by-id helper, is an error rather than a silent
 * pass. An absence guard that scans nothing passes forever.
 *
 * Run via `node scripts/check-collab-room-model-target.mjs` (CI node-test job).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const COLLAB_SLICE = 'apps/viewer/src/store/slices/collabSlice.ts';
const MUTATION_SLICE = 'apps/viewer/src/store/slices/mutationSlice.ts';

/**
 * Blank out comments so a `//`-quoted symbol (these regions document exactly
 * the shapes being banned) doesn't read as code, and single/double-quoted
 * strings so a stray brace in a literal can't desync the region scan. Template
 * literals are left alone: their `${...}` braces are balanced.
 */
function blankNoise(source) {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (two === '/*') {
      while (i < source.length && source.slice(i, i + 2) !== '*/') {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i];
      out += quote;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += '  ';
          i += 2;
          continue;
        }
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      out += quote;
      i += 1;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

const failures = [];

/** Record a failure; the run reports all of them before exiting once. */
function fail(lines) {
  failures.push(lines);
}

/** Load a file once, comment/string-blanked, with a raw copy for line numbers. */
function load(rel) {
  const raw = readFileSync(join(ROOT, rel), 'utf8');
  return {
    rel,
    raw,
    clean: blankNoise(raw),
    lineOf(offset) {
      return raw.slice(0, offset).split('\n').length;
    },
  };
}

/**
 * Delimit a brace-balanced region starting at `marker`. Returns `null` after
 * recording the failure, so a renamed region breaks the build rather than
 * quietly shrinking the scan to nothing.
 */
function region(file, marker, label) {
  const start = file.clean.indexOf(marker);
  if (start === -1) {
    fail([
      `${label}: could not find \`${marker.split('\n')[0]}\` in ${file.rel}.`,
      '',
      'The region this guard pins was renamed or removed, so nothing was checked.',
      'Re-point the guard at whatever replaced it.',
    ]);
    return null;
  }
  const bodyStart = file.clean.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < file.clean.length; i += 1) {
    if (file.clean[i] === '{') depth += 1;
    else if (file.clean[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        return {
          label,
          text: file.clean.slice(start, i + 1),
          offset: start,
          first: file.lineOf(start),
          last: file.lineOf(i),
          file,
        };
      }
    }
  }
  fail([
    `${label}: unbalanced braces after \`${marker.split('\n')[0]}\` in ${file.rel}.`,
    '',
    'Could not delimit the region, so nothing was checked.',
  ]);
  return null;
}

/**
 * The two halves of every check: the banned shapes must be absent, and at least
 * one by-id call must be present. The second half is what stops the first from
 * being satisfied by deleting the code.
 */
function assertRegion(reg, { banned, required, consequence }) {
  if (!reg) return;
  const hits = [];
  for (const needle of banned) {
    let at = reg.text.indexOf(needle);
    while (at !== -1) {
      hits.push(`${reg.file.rel}:${reg.file.lineOf(reg.offset + at)}: ${needle}…`);
      at = reg.text.indexOf(needle, at + 1);
    }
  }
  if (hits.length > 0) {
    fail([`${reg.label} resolves the room's model as the ACTIVE model:`, '', ...hits.map((h) => `  ${h}`), '', consequence]);
    return;
  }
  for (const needle of required) {
    if (!reg.text.includes(needle)) {
      fail([
        `${reg.label}: no \`${needle}\` in ${reg.file.rel}:${reg.first}-${reg.last}.`,
        '',
        'The region no longer routes through the by-id resolver, so "does not use',
        'the active model" is satisfied vacuously. Restore the call, or re-point',
        'this guard at whatever replaced it.',
      ]);
    }
  }
}

const collab = load(COLLAB_SLICE);
const mutation = load(MUTATION_SLICE);

// ── 1. The recipient's re-derivation (#2705) ────────────────────────────────
assertRegion(region(collab, 'const reconstruct = async () => {', 'collab recipient reconstruct'), {
  banned: ['get().setIfcDataStore(', 'get().setGeometryResult('],
  required: ['applyRoomModelData('],
  consequence: `Those setters target \`activeModelId\`, but the reconstruct's target is the room
model: a recipient with their own file active loses that file's store and
meshes on the next peer edit. Route the write through
\`applyRoomModelData(get(), roomModelId, { … })\`
(apps/viewer/src/lib/collab/room-model-apply.ts).`,
});

// ── 2. Inbound: a peer's edit replayed into a local view ────────────────────
assertRegion(region(collab, 'remoteApplyTeardown = attachRemoteApply(', 'collab inbound apply'), {
  banned: ['get().activeModelId', 'get().ifcDataStore', 'get().mutationViews'],
  required: ['roomStore(get())', 'roomMutationView(get())', 'roomModelIdOf(get())'],
  consequence: `A peer's edit carries an expressId in the ROOM's id space. Replaying it into
the ACTIVE model writes it into the user's own file — into undoStacks,
dirtyModels and the export path, where it survives a reload and ships in their
exported IFC. Resolve through \`roomStore\` / \`roomMutationView\` /
\`roomModelIdOf\` (apps/viewer/src/lib/collab/room-model-target.ts).`,
});

// ── 3. Outbound: local edits mirrored into the room ─────────────────────────
// Whole-file, not a region: `activeModelId` has no legitimate reader in this
// slice, and the gate it used to guard is repeated at three call sites.
{
  const hits = [];
  let at = mutation.clean.indexOf('get().activeModelId');
  while (at !== -1) {
    hits.push(`${MUTATION_SLICE}:${mutation.lineOf(at)}: get().activeModelId`);
    at = mutation.clean.indexOf('get().activeModelId', at + 1);
  }
  if (hits.length > 0) {
    fail([
      'collab outbound mirror gate reads the ACTIVE model:',
      '',
      ...hits.map((h) => `  ${h}`),
      '',
      `A user who joins a room and then loads and selects their own file would
broadcast that PRIVATE model's edits into the shared room, where the id lands on
whatever entity it resolves to in the owner's model. Gate on
\`isRoomModel(get(), modelId)\` (apps/viewer/src/lib/collab/room-model-target.ts).`,
    ]);
  } else if (!mutation.clean.includes('isRoomModel(get(), modelId)')) {
    fail([
      `collab outbound mirror gate: no \`isRoomModel(get(), modelId)\` in ${MUTATION_SLICE}.`,
      '',
      'The mirror gate no longer names the room model, so "does not read',
      'activeModelId" is satisfied vacuously.',
    ]);
  }
}

// ── 4. Outbound: the modelId-taking mirrors gate themselves ────────────────
// These are called unconditionally from mutationSlice, so the gate has to live
// inside each one — a new call site cannot forget what it never had to write.
for (const mirror of [
  'mirrorPlacementEdit: (modelId, entityId, deltaIfc, deltaYaw = 0) => {',
  'mirrorEntityRemove: (modelId, entityId) => {',
  'mirrorEntityCreate: (modelId, entityId, ifcType, guid, mesh) => {',
  'mirrorEntityGeometry: (modelId, entityId, mesh) => {',
]) {
  const name = mirror.slice(0, mirror.indexOf(':'));
  assertRegion(region(collab, mirror, `collab ${name}`), {
    banned: [],
    required: ['isRoomModel(get(), modelId)'],
    consequence: '',
  });
}

if (failures.length > 0) {
  for (const lines of failures) {
    console.error(`\n${lines.join('\n')}`);
  }
  console.error('');
  process.exit(1);
}

console.log('check-collab-room-model-target: OK (4 regions, 0 active-model targeting)');
