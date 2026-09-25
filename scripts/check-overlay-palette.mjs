#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A per-file ratchet for the #5478 charter's colour rule: viewport code gets
 * ONE accent, ONE ink, tokens instead of hex, and a z SCALE instead of raw
 * numbers (#5487).
 *
 * The audit behind #5478 found ~35 independently positioned viewport
 * overlays, each with its own colour and z-index: violet `#9C6BDE` for the
 * custom section plane, purple `#a855f7` for split/wall handles and edit
 * mode, a hard-coded selection blue in `main.wgsl.ts`, z-index from `z-10`
 * to `z-[9999]`. #5483 shipped the token module
 * (`apps/viewer/src/lib/viewport-ui/overlay-theme.ts`) and the z scale
 * (`z-(--z-hud)`) that replace all of that, but a big-bang rewrite of every
 * existing site is its own multi-issue sweep (#5488-#5512). This gate holds
 * the line in the meantime: today's offenders are frozen into a committed
 * baseline, and a file may never gain a NEW one.
 *
 * Same ratchet SHAPE as `scripts/check-jsx-a11y.mjs`: a per-key baseline
 * (`scripts/overlay-palette-baseline.json`) records TODAY's violation count
 * for every `category:file` key this gate measures; the gate fails when a
 * key's count RISES above its row. Deliberately ONE-WAY, like
 * check-jsx-a11y.mjs and unlike check-unused-locals.mjs: the files in scope
 * here (SectionPanel.tsx, MeasurementVisuals.tsx, SpaceSketchCanvas.tsx, ...)
 * are exactly the files the still-open colour-unification issues
 * (#5488-#5491) and HUD-migration issues (#5499-#5512) are about to touch
 * next, often several at once. A two-way ratchet would fail a PR that fixes
 * one tool's colours the moment ANOTHER open PR against a sibling tool
 * merges first and leaves this baseline's row for the first PR's target
 * file stale — the exact failure mode `check-jsx-a11y.mjs`'s header records
 * happening twice in a single day during a comparable sweep. Reported, not
 * blocked: an improvement should still lower its baseline (`--update`), but
 * forgetting to is not a red CI on an unrelated file.
 *
 * The three detectors (`findHexOrRgbLiterals`, `findPurpleFamilyUtilities`,
 * `findRawZIndex`) and the "what is viewport code" scope live in
 * `scripts/lib/overlay-palette.mjs`; `scripts/check-overlay-palette.test.mjs`
 * covers them directly with fixtures. The comparison itself is
 * `scripts/lib/count-ratchet.mjs`'s `compareToBaseline`, shared with
 * check-jsx-a11y.mjs and the viewer smoke e2e's axe baseline (#5607).
 *
 * Flags:
 *   --root <dir>       scan this tree instead of the repo
 *   --baseline <path>  read/write this baseline instead of the committed one
 *   --update           re-record every key's count
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import {
  isViewportFile,
  VIEWER_SCAN_DIR,
  stripJsComments,
  findHexOrRgbLiterals,
  findPurpleFamilyUtilities,
  findRawZIndex,
} from './lib/overlay-palette.mjs';
import { compareToBaseline } from './lib/count-ratchet.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');

function parseArgs(argv) {
  const out = { root: REPO_ROOT, baseline: null, update: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' || flag === '--baseline') {
      if (value === undefined) fail(`${flag} needs a value. Pass a path after ${flag}.`);
      out[flag.slice(2)] = resolve(value);
      i += 1;
    } else if (flag === '--update') {
      out.update = true;
    } else {
      fail(`unknown argument: ${flag}. Supported: --root, --baseline, --update.`);
    }
  }
  if (out.baseline === null) out.baseline = join(out.root, 'scripts', 'overlay-palette-baseline.json');
  return out;
}

function fail(message) {
  console.error(`check-overlay-palette: ${message}`);
  process.exit(1);
}

/** Tracked `.ts`/`.tsx` files under `apps/viewer/src`, test files excluded:
 * this gate gauges shipped viewport code, not fixtures that deliberately
 * exercise a hex literal or a `z-30` class as test input. `:(glob)` is
 * required for `**` to cross directory boundaries, same as check-css-vars.mjs. */
function listTrackedViewerFiles(root) {
  const raw = execFileSync(
    'git',
    ['ls-files', '-z', '--', `:(glob)${VIEWER_SCAN_DIR}**/*.ts`, `:(glob)${VIEWER_SCAN_DIR}**/*.tsx`],
    { cwd: root, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  return raw.split('\0').filter(Boolean).filter((p) => !/\.test\.tsx?$/.test(p));
}

function measure(root) {
  const files = listTrackedViewerFiles(root);
  if (files.length === 0) {
    fail(`no tracked .ts/.tsx files under ${VIEWER_SCAN_DIR} — this check's scan dir is stale.`);
  }
  const counts = {};
  for (const path of files) {
    const raw = readFileSync(join(root, path), 'utf-8');
    const content = stripJsComments(raw);

    // Whole-viewer: the purple-family colour decision (#5478) is not scoped
    // to viewport overlays — the colourful theme's primary IS purple, so any
    // purple-500-style utility anywhere in the viewer risks reintroducing it.
    const purple = findPurpleFamilyUtilities(content).length;
    if (purple > 0) counts[`purpleFamily:${path}`] = purple;

    if (!isViewportFile(path)) continue;

    const hexOrRgb = findHexOrRgbLiterals(content).length;
    if (hexOrRgb > 0) counts[`hexOrRgb:${path}`] = hexOrRgb;

    const zIndex = findRawZIndex(content).length;
    if (zIndex > 0) counts[`zIndex:${path}`] = zIndex;
  }
  return counts;
}

const args = parseArgs(process.argv.slice(2));
const counts = measure(args.root);

if (args.update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(args.baseline, `${JSON.stringify(sorted, null, 2)}\n`);
  const total = Object.values(sorted).reduce((a, b) => a + b, 0);
  console.log(`✅ Wrote ${relative(args.root, args.baseline)} (${Object.keys(sorted).length} key(s), ${total} known violation(s)).`);
  process.exit(0);
}

if (!existsSync(args.baseline)) {
  fail(`no baseline at ${relative(args.root, args.baseline)}. Run: node scripts/check-overlay-palette.mjs --update`);
}
const baseline = JSON.parse(readFileSync(args.baseline, 'utf-8'));
const { regressions, improvements } = compareToBaseline(counts, baseline);

if (improvements.length > 0) {
  console.log(`ℹ️  ${improvements.length} key(s) improved but the baseline still allows the old count.`);
  console.log('   Consider running `node scripts/check-overlay-palette.mjs --update` and committing it,');
  console.log('   so the ratchet actually tightens (not required — see the file header for why this');
  console.log('   gate does not fail on a stale improvement).');
  for (const { key, count, allowed } of improvements) console.log(`   ${key}: ${count} (baseline ${allowed})`);
}

if (regressions.length > 0) {
  console.error(`❌ ${regressions.length} overlay-palette violation(s) exceed their baseline:\n`);
  for (const { key, count, allowed } of regressions) {
    const [category, ...pathParts] = key.split(':');
    console.error(`   ${category} ${pathParts.join(':')}: ${count} (baseline ${allowed}, +${count - allowed})`);
  }
  console.error(`
This is a NEW hard-coded colour or z-index literal in viewport code
(components/viewport-ui/**, components/viewer/tools/**, or one of the
overlay files named by the #5478 charter), or a new purple-family Tailwind
utility anywhere in the viewer.

Fix it by using the token module instead
(apps/viewer/src/lib/viewport-ui/overlay-theme.ts, and the z scale
z-(--z-hud) from #5483), not by raising the baseline. If the count is
already accounted for and this is a false positive, that is a bug in
scripts/lib/overlay-palette.mjs to fix, not a baseline row to inflate.`);
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`✅ No new overlay-palette violations (${Object.keys(counts).length} known key(s), ${total} known violation(s), none increased).`);
