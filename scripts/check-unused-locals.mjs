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
 * catches the 356th — and a package that IMPROVES must lower its baseline in the
 * same change, or the slack it just earned silently absorbs the next 50.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { writeTestProgram, GENERATED_CONFIG } from './typecheck-tests.mjs';

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

/**
 * The project to measure a package through.
 *
 * A package's own tsconfig cannot see its tests: the root config excludes
 * `**\/*.test.ts` and `exclude` filters `include`, so `src/**\/*` cannot bring
 * them back. Measuring that program reports a package with dead imports in its
 * tests as clean — `packages/merge`, `plugin-api` and `provenance` all sat at a
 * baseline of 0 while their tests carried unused imports.
 *
 * `typecheck-tests.mjs` already solves this for the typecheck lane, with a
 * generated program that lists the test files under `files` (which `exclude`
 * does not filter). It extends the package's own tsconfig, so it is a superset:
 * one run covers src and tests both, and the check costs no more than before.
 */
function projectFor(dir) {
  const pkgDir = join(repoRoot, dir);
  const generated = writeTestProgram(pkgDir);
  return generated ? GENERATED_CONFIG : 'tsconfig.json';
}

/** Count "declared but never read" diagnostics in one package. */
function countViolations(dir) {
  const project = projectFor(dir);
  try {
    execFileSync('pnpm', ['exec', 'tsc', '--noEmit', '--noUnusedLocals', '-p', project], {
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

if (unmeasurable.length > 0 && update) {
  // Refuse to bake a baseline that silently omits packages. Writing one here is
  // how an unmeasurable package became an unrecorded one, and unrecorded
  // packages used to pass.
  console.error('❌ Not writing a baseline: these packages do not compile standalone, so');
  console.error('   they would be omitted from it and left unguarded:\n');
  for (const dir of unmeasurable) console.error(`   ${dir}`);
  console.error('\nFix the compile error first (see the typecheck lane).');
  process.exit(1);
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
// ANY package that cannot be measured has no guard, whether or not it is in the
// baseline. Filtering this to baseline members left two ways to escape the
// ratchet with a green tick (both found in review): a package that never
// compiled standalone was omitted from `counts`, and `unrecorded` below only
// iterates `counts`, so it was never in the baseline and never missed; and
// `--update` writes a baseline that omits the unmeasurable, which turns the
// first case into the second. One rule instead: unmeasurable is a failure.
if (unmeasurable.length > 0) {
  console.error('❌ These packages do not compile standalone, so nothing measures their');
  console.error('   unused locals. Fix the compile error (see the typecheck lane) rather');
  console.error('   than leaving them unguarded:\n');
  for (const dir of unmeasurable) console.error(`   ${dir}${dir in baseline ? ` (baseline ${baseline[dir]})` : ' (never measured)'}`);
  process.exit(1);
}
const improvements = Object.entries(counts).filter(([dir, n]) => n < (baseline[dir] ?? 0));
// A package NEW to the baseline has never been measured, so it has no guard at
// all — record it rather than letting it pass silently forever.
const unrecorded = Object.keys(counts).filter((dir) => !(dir in baseline));
// The mirror image: a baseline entry with no package behind it any more. Either
// the package was deleted — fine, but say so by re-baselining — or its tsconfig
// went missing, which takes it out of `dirs` and quietly ends its guard.
const vanished = Object.keys(baseline).filter((dir) => !(dir in counts));

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

if (improvements.length > 0) {
  console.error('❌ These packages improved but the baseline still allows the old count,');
  console.error('   which is slack the next regression would ride in on:\n');
  for (const [dir, n] of improvements) console.error(`   ${dir}: ${n} (baseline ${baseline[dir]}, -${baseline[dir] - n})`);
  console.error('\nRun `pnpm lint:baseline` and commit — the ratchet only holds if it tightens.');
  process.exit(1);
}

if (unrecorded.length > 0) {
  console.error('❌ These packages are not in the baseline, so nothing guards them:\n');
  for (const dir of unrecorded) console.error(`   ${dir}: ${counts[dir]}`);
  console.error('\nRun `pnpm lint:baseline` and commit.');
  process.exit(1);
}

if (vanished.length > 0) {
  console.error('❌ These packages are in the baseline but were not found. If they were');
  console.error('   deleted, re-baseline to say so; if their tsconfig went missing, that');
  console.error('   silently ended their guard:\n');
  for (const dir of vanished) console.error(`   ${dir} (baseline ${baseline[dir]})`);
  console.error('\nRun `pnpm lint:baseline` and commit.');
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
// No "not measured" footnote here any more: reaching this line means every
// package was measured, because anything else exited above.
console.log(`✅ No new unused locals (${Object.keys(counts).length} packages, ${total} known, none increased).`);
