#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PROPOSAL — not wired into CI. See issue #2802.
 *
 * Lint: flag a `clear*` / `reset*` / `close*` / `exit*` zustand action whose
 * implementation assigns a whole default-state object (`set(getDefaultState())`
 * or `set({ ...getDefaultState(), ... })` / `set({ ...initialState, ... })`)
 * rather than an explicit field list.
 *
 * Three confirmed instances of this class landed in one day:
 *   - sheetSlice.ts:180 clearSheet — `set(getDefaultState())` destroyed
 *     `savedSheetTemplates` along with the active sheet.
 *   - drawing2DSlice.ts:441 clearDrawing2D — `set(getDefaultState())`
 *     destroyed custom override rules, `overridesEnabled`, text annotations
 *     and DXF underlays; its only caller wanted regeneration, not a wipe.
 *   - idsSlice.ts:218/232 — the inverse (under-reset), not this shape.
 *
 * LIMITATION: this script only catches the "resets too much" (whole-state)
 * shape above. It does NOT catch the idsSlice-style inverse — an action
 * that resets too LITTLE and leaves a field (e.g. `idsIsolateMode`) pointing
 * at data the action just invalidated. That shape has no reliable textual
 * signature and is not attempted here.
 *
 * A whole-default-state assignment inside an action named `clear*`/`reset*`/
 * `close*`/`exit*` is the reliable textual signature of the first two: the
 * action's own name promises to clear/reset ONE thing, but the RHS resets
 * EVERYTHING the slice owns, including fields that outlive the thing named.
 *
 * This is a heuristic, not a proof of a bug: a slice whose entire state
 * legitimately belongs to one feature (e.g. a scoped `reset*` that is
 * genuinely meant to zero the whole slice, or a single-tenant store like
 * `lib/tours/tour-store.ts`) will also match and is a CORRECT whole-reset.
 * Every hit needs a human read of "does this slice hold anything that
 * outlives the action's name" — this script only makes the candidates cheap
 * to find, the way the three real bugs above were found by grep first and
 * confirmed by reading second.
 *
 * Run via `node scripts/check-whole-state-reset.mjs`.
 *
 * @unwired-by-design an unadopted heuristic proposal (issue #2802).
 * Its hits each need a human read — every CORRECT whole-reset in the repo
 * matches it too — so as a CI gate it would be red on correct code.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Directories to walk for zustand-style stores/slices. */
const DIRS = [
  'apps/viewer/src/store/slices',
  'apps/viewer/src/store',
  'apps/viewer/src/lib/tours',
];

/** Action-name prefixes that promise a SCOPED clear, not a whole reset. */
const ACTION_NAME = /^\s*(clear|reset|close|exit)[A-Za-z0-9_]*\s*:\s*\(/;

/** Whole-default-state shapes seen in all three confirmed instances. */
const WHOLE_STATE_PATTERNS = [
  /set\(\s*getDefaultState\(\)\s*\)/,
  /set\(\s*\{\s*\.\.\.getDefaultState\(\)/,
  /set\(\s*\{\s*\.\.\.initialState\b/,
  /setState\(\s*\{\s*\.\.\.INITIAL\b/,
  /setState\(\s*getDefaultState\(\)\s*\)/,
];

/** How many lines after the action-name line to scan for the RHS shape.
 *  Generous: a `set()` call can be a few lines below the signature line. */
const WINDOW = 6;

/**
 * Lower bound on how many slice files must actually be read. Measured on a
 * healthy tree: 70 non-test `.ts` files across the three DIRS (106 + 34 + 13
 * entries, minus their `.test.ts` siblings). Set to 45 — about a third of
 * headroom, so the steady churn of slices being added, split and retired never
 * forces an edit here, while the failure mode this exists for still trips.
 * That failure mode is not a gradual decline: every way this script can go
 * blind (a renamed `store/` directory, a wrong ROOT, a `readdirSync` that
 * returns nothing) takes the count to zero or to one directory's worth, not
 * to 44.
 */
const SCANNED_FLOOR = 45;

/**
 * Fails loudly on both halves of what the old `catch { return []; }` collapsed
 * into "no files here": a directory that DOES NOT EXIST (a moved or renamed
 * path, which this script must not silently outlive) and one that exists but
 * CANNOT BE READ (a permissions error, a filesystem fault). Neither is a
 * clean scan, and reporting one as a clean scan is the defect in #3194.
 */
function listTsFiles(relDir) {
  const abs = join(ROOT, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    const why =
      err?.code === 'ENOENT'
        ? 'does not exist — it was moved or renamed, and DIRS in this script was not updated'
        : `could not be read (${err?.code ?? err?.message})`;
    console.error(
      `\ncheck-whole-state-reset: scan directory ${relDir} ${why}.\n` +
        `Refusing a vacuous pass: this script expects to read zustand slice files there, and a\n` +
        `directory it cannot open is a broken scan, not a clean one.\n`,
    );
    process.exit(1);
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(relDir, e.name));
}

const files = DIRS.flatMap(listTsFiles);

if (files.length < SCANNED_FLOOR) {
  console.error(
    `\ncheck-whole-state-reset: only ${files.length} slice file(s) found, floor is ${SCANNED_FLOOR}.\n` +
      `Refusing a vacuous pass: expected the zustand slices under\n` +
      DIRS.map((d) => `  ${d}\n`).join('') +
      `A count this low means the scan broke, not that the store shrank. If the slices were\n` +
      `genuinely consolidated, lower SCANNED_FLOOR in the same commit.\n`,
  );
  process.exit(1);
}

const violations = [];
const scanned = [];

for (const rel of files) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const lines = text.split('\n');
  scanned.push(rel);
  lines.forEach((line, i) => {
    if (!ACTION_NAME.test(line)) return;
    const actionMatch = line.match(/^\s*([A-Za-z0-9_]+)\s*:/);
    const actionName = actionMatch ? actionMatch[1] : '(unknown)';
    const window = lines.slice(i, i + WINDOW).join('\n');
    for (const pattern of WHOLE_STATE_PATTERNS) {
      if (pattern.test(window)) {
        violations.push(`${rel}:${i + 1}: ${actionName} — matches ${pattern}`);
        break;
      }
    }
  });
}

if (violations.length > 0) {
  console.error('\nCandidate whole-state resets inside a scoped clear/reset/close/exit action:\n');
  for (const v of violations) console.error(`  ${v}`);
  console.error(`
Each hit needs a human read: does this action's name promise to clear ONE
thing while the implementation resets the ENTIRE slice, including fields
that should outlive it (saved templates, user preferences, another
feature's state)? A slice whose whole state legitimately belongs to one
feature is a correct whole-reset — not every hit here is a bug.
`);
  process.exit(1);
}

console.log(`check-whole-state-reset: OK (${scanned.length} files scanned, 0 candidates)`);
