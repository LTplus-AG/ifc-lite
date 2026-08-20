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

function listTsFiles(relDir) {
  const abs = join(ROOT, relDir);
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => join(relDir, e.name));
}

const files = DIRS.flatMap(listTsFiles);
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
