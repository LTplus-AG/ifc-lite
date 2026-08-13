#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A ratchet for unused locals and imports.
 *
 * The repo cannot simply turn on `noUnusedLocals`: there are hundreds of
 * existing violations, and a sweep that large is its own change. But the check
 * was worth having — 12 imports left pointing at code that had moved sailed
 * through a green CI in #2601, because the Lint lane ran no linters at all and
 * `noUnusedLocals` is off (#2603).
 *
 * So this counts violations per package and compares against a committed
 * baseline. A package may never EXCEED its baseline; packages at zero must stay
 * at zero. Fixing violations and lowering the baseline is always welcome, and
 * `--update` rewrites it.
 *
 * The point is that the number can only go down. A package sitting at 355 still
 * catches the 356th.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(repoRoot, 'scripts', 'unused-locals-baseline.json');
const update = process.argv.includes('--update');

/** Workspace packages with a tsconfig, discovered rather than hardcoded. */
function packageDirs() {
  const out = execFileSync('pnpm', ['-r', 'exec', 'node', '-e', 'console.log(process.cwd())'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))]
    .filter((dir) => dir.startsWith(repoRoot) && dir !== repoRoot)
    .filter((dir) => existsSync(join(dir, 'tsconfig.json')))
    .map((dir) => relative(repoRoot, dir))
    .sort();
}

/**
 * The TypeScript diagnostics that mean "declared and never used". More than one
 * code matters: TS6192 is "all imports in this declaration are unused", which is
 * precisely the dead-import case this check exists for, and treating it as an
 * unrelated error made `apps/viewer` — where those imports were — unmeasurable.
 */
const UNUSED_CODES = [6133, 6138, 6192, 6196, 6198, 6199];
const UNUSED_RE = new RegExp(`error TS(${UNUSED_CODES.join('|')}):`, 'g');
const OTHER_ERROR_RE = new RegExp(`error TS(?!(?:${UNUSED_CODES.join('|')})\\b)\\d+:`);

/** Count "declared but never read" diagnostics in one package. */
function countViolations(dir) {
  try {
    execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '--noUnusedLocals'], {
      cwd: join(repoRoot, dir), encoding: 'utf8', stdio: 'pipe', maxBuffer: 32 * 1024 * 1024,
    });
    return { count: 0, unmeasurable: false };
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const matches = output.match(UNUSED_RE);
    const otherErrors = OTHER_ERROR_RE.test(output);
    if (otherErrors) {
      // The package does not compile. That belongs to the typecheck lane, not
      // here — but it must not silently drop out of the ratchet either, or
      // breaking a build becomes a way to lose the guard. Reported, not skipped.
      return { count: matches?.length ?? 0, unmeasurable: true };
    }
    return { count: matches?.length ?? 0, unmeasurable: false };
  }
}

const dirs = packageDirs();
const counts = {};
const unmeasurable = [];
for (const dir of dirs) {
  const { count, unmeasurable: broken } = countViolations(dir);
  if (broken) unmeasurable.push(dir);
  else counts[dir] = count;
}

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(counts, null, 2)}\n`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`✅ Wrote ${relative(repoRoot, baselinePath)} (${Object.keys(counts).length} measured, ${total} known violations)`);
  if (unmeasurable.length > 0) {
    console.log(`   Not measured (do not compile standalone): ${unmeasurable.join(', ')}`);
  }
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error('No baseline. Run: node scripts/check-unused-locals.mjs --update');
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const regressions = [];
for (const [dir, n] of Object.entries(counts)) {
  const allowed = baseline[dir] ?? 0;
  if (n > allowed) regressions.push({ dir, n, allowed });
}
// A package in the baseline that can no longer be measured has lost its guard.
const lost = unmeasurable.filter((dir) => dir in baseline);
if (lost.length > 0) {
  console.error('❌ These packages are in the baseline but no longer compile, so their');
  console.error('   unused-locals guard is gone. Fix the compile error (see the typecheck');
  console.error('   lane) rather than leaving them unmeasured:\n');
  for (const dir of lost) console.error(`   ${dir}`);
  process.exit(1);
}
const improvements = Object.entries(counts).filter(([dir, n]) => n < (baseline[dir] ?? 0));

if (regressions.length > 0) {
  console.error('❌ Unused locals/imports increased:\n');
  for (const { dir, n, allowed } of regressions) {
    console.error(`   ${dir}: ${n} (baseline ${allowed}, +${n - allowed})`);
  }
  console.error('\nRun `pnpm exec tsc --noEmit --noUnusedLocals` in that package to see them.');
  console.error('These are almost always imports left behind by a move or a rename.');
  console.error('If the increase is genuinely intentional, run:');
  console.error('   node scripts/check-unused-locals.mjs --update   (and commit the baseline)');
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`✅ No new unused locals (${Object.keys(counts).length} packages, ${total} known, none increased).`);
if (improvements.length > 0) {
  console.log('\n   Baseline can be lowered — these improved:');
  for (const [dir, n] of improvements) console.log(`   ${dir}: ${n} (baseline ${baseline[dir]})`);
  console.log('   Run with --update and commit the baseline.');
}
