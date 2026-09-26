#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lint: icon-only buttons in the viewer go through `IconButton` (#5811).
 *
 * `components/ui/icon-button.tsx` requires a `label`, which becomes the
 * button's accessible name and its tooltip. A `<Button size="icon…">` can be
 * written with no name at all, and 46 of them were. Each one left outside
 * `components/ui` is a place that defect can come back, so this is a two-way
 * per-file ratchet over the source: a file may not gain one (a new file is
 * allowed none), and a file that loses one must lower its row below so the
 * slack is not spent by the next regression.
 *
 * It is a lint and not a test for the reason `check-unbounded-frame-wait.mjs`
 * is: "nobody wrote another unnamed icon button" is an absence claim over the
 * whole components tree, with nothing to drive. `IconButton`'s behaviour is
 * pinned by `apps/viewer/src/components/ui/icon-button.test.tsx`.
 *
 * The rows below are surfaces other charters own (#5478: the drawing,
 * measure, section, placement and presentation panels and the viewport HUD;
 * #5610: the two desktop toolbars; #5817: the shortcuts dialog), text-glyph
 * buttons that already carry an `aria-label`, and one already-named button in
 * a file at its module-size budget. The follow-up under #5811 migrates them.
 *
 * Flags (for this script's own test, scripts/check-icon-button-adoption.test.mjs):
 *   --root <dir>        scan <dir>/apps/viewer/src/components instead of this repo's
 *   --baseline <json>   compare against this JSON baseline instead of BASELINE
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Allowed `<Button size="icon…">` count per file, relative to components/. */
const BASELINE = {
  'viewer/KeyboardShortcutsDialog.tsx': 1,
  'viewer/MainToolbar.tsx': 21,
  'viewer/MobileToolbar.tsx': 7,
  'viewer/ViewportOverlays.tsx': 3,
  'viewer/chat/ExecutableCodeBlock.tsx': 1,
  'viewer/drawing/DrawingExportMenu.tsx': 1,
  'viewer/drawing/DrawingPanel.tsx': 2,
  'viewer/drawing/DrawingToolbar.tsx': 1,
  'viewer/placement/PlacementPanel.tsx': 1,
  'viewer/presentation/PresentationPanel.tsx': 9,
  'viewer/presentation/PresentationViewCard.tsx': 3,
  'viewer/ribbon/RibbonToolbar.tsx': 2,
  'viewer/tools/MeasurePointReadout.tsx': 2,
  'viewer/tools/MeasureToolbar.tsx': 2,
  'viewer/tools/SectionToolbar.tsx': 1,
};

function fail(message) {
  console.error(`check-icon-button-adoption: ${message}`);
  process.exit(1);
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  if (argv[i + 1] === undefined) fail(`${name} needs a value`);
  return resolve(argv[i + 1]);
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) yield path;
  }
}

/**
 * The opening tag starting at `start` (`<Button`), up to its closing `>`.
 * Braces, quotes and comments inside attribute expressions are skipped, so
 * `onClick={() => …}` or a commented apostrophe does not end the tag early.
 */
function openingTag(source, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (depth > 0 && ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i < 0) break;
    } else if (depth > 0 && ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
      if (i <= 0) break;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function countIconSizedButtons(source) {
  let count = 0;
  for (const match of source.matchAll(/<Button(?=[\s>])/g)) {
    if (/\ssize="icon[\w-]*"/.test(openingTag(source, match.index))) count += 1;
  }
  return count;
}

const argv = process.argv.slice(2);
const root = flag(argv, '--root') ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = flag(argv, '--baseline');
let baseline = BASELINE;
if (baselinePath) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    fail(`cannot read baseline ${baselinePath}: ${err.message}`);
  }
}
const components = join(root, 'apps', 'viewer', 'src', 'components');
const measured = {};
let scanned = 0;
try {
  for (const file of sourceFiles(components)) {
    scanned += 1;
    const key = relative(components, file).split('\\').join('/');
    if (key.startsWith('ui/')) continue;
    const n = countIconSizedButtons(readFileSync(file, 'utf8'));
    if (n > 0) measured[key] = n;
  }
} catch (err) {
  // Fail closed: a moved tree must break this check, not pass having scanned nothing.
  fail(`cannot scan ${components}: ${err.message}`);
}
if (scanned === 0) fail(`no .tsx files under ${components}; an absence check that scans nothing passes forever.`);

const keys = [...new Set([...Object.keys(measured), ...Object.keys(baseline)])].sort();
const rises = keys.filter((k) => (measured[k] ?? 0) > (baseline[k] ?? 0));
const slack = keys.filter((k) => (measured[k] ?? 0) < (baseline[k] ?? 0));

if (rises.length > 0) {
  console.error('check-icon-button-adoption: <Button size="icon…"> count increased:\n');
  for (const k of rises) console.error(`  ${k}: ${measured[k]} (allowed ${baseline[k] ?? 0})`);
  console.error('\nUse IconButton from @/components/ui/icon-button: it requires a label, which becomes the accessible name and the tooltip.');
  process.exit(1);
}
if (slack.length > 0) {
  console.error('check-icon-button-adoption: baseline carries slack; lower these rows in BASELINE:\n');
  for (const k of slack) console.error(`  ${k}: ${measured[k] ?? 0} (baseline ${baseline[k]})`);
  process.exit(1);
}
console.log(`check-icon-button-adoption: OK (${scanned} files scanned, ${Object.values(measured).reduce((a, b) => a + b, 0)} icon-sized <Button>s, all within baseline)`);
