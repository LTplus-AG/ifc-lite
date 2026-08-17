#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: the collab recipient's `reconstruct` block must address the ROOM model
 * by id, never the bare active-model setters (#2705).
 *
 * `setIfcDataStore` / `setGeometryResult` write to `activeModelId`
 * (dataSlice.ts). The recipient re-derives the shared model from the CRDT on
 * every peer edit, and pushing that through those setters assumed the
 * reconstructed `room:<roomId>` model was the active one. It need not be:
 * `upsertModel` keeps the existing `activeModelId` (modelSlice.ts), so a
 * recipient who also has their own file open had their store and meshes
 * replaced by the room's on the next peer edit. `applyRoomModelData`
 * (apps/viewer/src/lib/collab/room-model-apply.ts) addresses the room model by
 * id instead; its behaviour is pinned by room-model-apply.test.ts.
 *
 * THIS half is the wiring, and the wiring is what was wrong. The helper can be
 * fully correct and fully tested while the call sites go back to
 * `get().setIfcDataStore(...)` — verified: reverting all three call sites keeps
 * `tsc --noEmit` clean and the whole viewer suite green, because the path needs
 * jsdom, IndexedDB, `import.meta.env` and a websocket and so cannot be driven
 * under `tsx --test`. An absence claim over one block of one file is a lint,
 * not a unit test, so it lives here rather than as a source-text assertion in a
 * test file (which `scripts/check-source-text-assertions.mjs` forbids).
 *
 * Run via `node scripts/check-collab-room-model-target.mjs` (CI node-test job).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILE = 'apps/viewer/src/store/slices/collabSlice.ts';

/** Opening line of the recipient's re-derivation closure. */
const BLOCK_START = 'const reconstruct = async () => {';

/**
 * Active-model setters. Correct at a top-level file load; wrong inside the
 * recipient reconstruct, where the target is the room model.
 */
const BARE_SETTERS = ['get().setIfcDataStore(', 'get().setGeometryResult('];

/** The by-id helper the block must route through, so it can't pass vacuously. */
const REQUIRED_CALL = 'applyRoomModelData(';

/**
 * Blank out comments so a `//`-quoted setter name (the block documents exactly
 * these two) doesn't read as a call site, and single/double-quoted strings so a
 * stray brace in a literal can't desync the block scan. Template literals are
 * left alone: their `${...}` braces are balanced.
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

/** Fail closed: every abort below is an exit(1), never a silent skip. */
function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const raw = readFileSync(join(ROOT, FILE), 'utf8');
const clean = blankNoise(raw);

const startIdx = clean.indexOf(BLOCK_START);
if (startIdx === -1) {
  fail(
    `check-collab-room-model-target: could not find \`${BLOCK_START}\` in ${FILE}.\n` +
      'The block this guard pins was renamed or removed. Re-point the guard at the\n' +
      'recipient re-derivation closure — an absence guard that scans nothing passes\n' +
      'forever.',
  );
}

// Brace-match the closure body so the scan covers exactly it, not the rest of
// the 1,200-line slice (where the active-model setters are legitimate).
const bodyStart = clean.indexOf('{', startIdx);
let depth = 0;
let endIdx = -1;
for (let i = bodyStart; i < clean.length; i += 1) {
  if (clean[i] === '{') depth += 1;
  else if (clean[i] === '}') {
    depth -= 1;
    if (depth === 0) {
      endIdx = i;
      break;
    }
  }
}
if (endIdx === -1) {
  fail(
    `check-collab-room-model-target: unbalanced braces after \`${BLOCK_START}\` in ${FILE}.\n` +
      'Could not delimit the block, so nothing was checked.',
  );
}

const block = clean.slice(startIdx, endIdx + 1);
const lineOf = (offset) => raw.slice(0, offset).split('\n').length;
const blockFirstLine = lineOf(startIdx);
const blockLastLine = lineOf(endIdx);

const violations = [];
for (const setter of BARE_SETTERS) {
  let at = block.indexOf(setter);
  while (at !== -1) {
    violations.push(`${FILE}:${lineOf(startIdx + at)}: ${setter}…`);
    at = block.indexOf(setter, at + 1);
  }
}

if (violations.length > 0) {
  console.error('\nCollab recipient reconstruct writes through the active-model setters (#2705):\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error(`
These setters target \`activeModelId\`, but the reconstruct's target is the room
model. A recipient with their own file active loses that file's store and meshes
on the next peer edit.

Route the write through \`applyRoomModelData(get(), roomModelId, { … })\` from
apps/viewer/src/lib/collab/room-model-apply.ts, which addresses the room model
by id and falls back to the active-model setters only when the room model IS the
active one.
`);
  process.exit(1);
}

if (!block.includes(REQUIRED_CALL)) {
  fail(
    `check-collab-room-model-target: no \`${REQUIRED_CALL}\` call in the reconstruct block\n` +
      `(${FILE}:${blockFirstLine}-${blockLastLine}).\n\n` +
      'The block no longer writes the reconstructed room data through the by-id\n' +
      'helper, so "no bare setters" is satisfied vacuously. Either restore the\n' +
      'helper call or re-point this guard at whatever replaced it.',
  );
}

console.log(
  `check-collab-room-model-target: OK (${FILE}:${blockFirstLine}-${blockLastLine}, 0 bare active-model setters)`,
);
