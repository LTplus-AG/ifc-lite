#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The #4918 localization sweep's charter names its own ending condition:
 * "a grep-based gate that reports no hardcoded JSX text or
 * `aria-label`/`title` literals under `apps/viewer/src/components`, with an
 * explicit allowlist for IFC EXPRESS names and technical identifiers, wired
 * into CI as a ratchet." This is that gate.
 *
 * Same ratchet SHAPE as `scripts/check-module-size.mjs` (a per-file budget,
 * frozen existing debt, no growth allowed) and `scripts/check-unused-locals.mjs`
 * (a committed JSON baseline, `--update` regenerates it): a per-file baseline
 * (`scripts/i18n-literals-baseline.json`) records TODAY's hardcoded-literal
 * count for every `.tsx` file under `apps/viewer/src/components`; the gate
 * fails when a file's count RISES above its row, and prints a reminder
 * (not a failure — converting a file is this sweep's whole point, and a
 * hard-fail-on-improvement rule would make every slice's PR fail on its own
 * progress) when a file's count FALLS, so the baseline does not silently
 * carry slack the next regression could spend.
 *
 * The detector itself (a regex scan, deliberately not a parser — see that
 * module's docblock for why) lives in `scripts/lib/i18n-literals-scan.mjs`;
 * `scripts/check-i18n-literals.test.mjs` covers it directly with a fixture.
 *
 * Flags:
 *   --root <dir>       scan this tree instead of the repo
 *   --baseline <path>  read/write this baseline instead of the committed one
 *   --update           re-record every file's count
 *   --allow-raise      with --update, permit a file's count to increase
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countLiterals } from './lib/i18n-literals-scan.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');
const SCAN_ROOT_REL = 'apps/viewer/src/components';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.turbo', '.next', '.git']);
/** Test files carry their own hardcoded strings (fixtures, assertions) that
 *  are not UI copy; the oracle tests this sweep adds are the mechanism that
 *  guards the PRODUCTION files this gate scans. */
const TEST_RE = /\.(test|spec)\.tsx$/;
const SOURCE_RE = /\.tsx$/;

function fail(message) {
  console.error(`check-i18n-literals: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { root: REPO_ROOT, baseline: null, update: false, allowRaise: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' || flag === '--baseline') {
      if (value === undefined) fail(`${flag} needs a value. Pass a path after ${flag}.`);
      out[flag.slice(2)] = value;
      i += 1;
    } else if (flag === '--update') {
      out.update = true;
    } else if (flag === '--allow-raise') {
      out.allowRaise = true;
    } else {
      fail(`unknown argument: ${flag}. Supported: --root, --baseline, --update, --allow-raise.`);
    }
  }
  if (out.allowRaise && !out.update) fail('--allow-raise only means something with --update');
  if (out.baseline === null) out.baseline = join(out.root, 'scripts', 'i18n-literals-baseline.json');
  return out;
}

function safeIsDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Fail closed on an unreadable directory, same reasoning as
 *  `check-module-size.mjs`'s `walk`: a gate that skips what it cannot read
 *  reports success having looked at less than it claims. */
function walk(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read directory ${dir}: ${err.message}. Fix the permission or path, then re-run.`);
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(full));
    if (isDir) walk(full, found);
    else if (SOURCE_RE.test(entry.name) && !TEST_RE.test(entry.name)) found.push(full);
  }
  return found;
}

const args = parseArgs(process.argv.slice(2));

const scanRoot = join(args.root, SCAN_ROOT_REL);
if (!safeIsDir(scanRoot)) fail(`scan root ${scanRoot} does not exist or is not a directory. Pass --root <repo-root> to point at a real checkout.`);

const paths = walk(scanRoot, []);
if (paths.length === 0) {
  fail(`no .tsx files found under ${scanRoot}. Exiting 0 here would certify a tree nobody looked at.`);
}

const counts = {};
for (const path of paths) {
  const rel = relative(args.root, path).split('\\').join('/');
  const n = countLiterals(readFileSync(path, 'utf8'));
  if (n > 0) counts[rel] = n;
}

if (args.update) {
  let baseline = {};
  if (existsSync(args.baseline)) {
    try {
      baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
    } catch (err) {
      fail(`cannot parse existing baseline ${args.baseline}: ${err.message}. Fix the JSON by hand or delete the file and re-run --update.`);
    }
  }

  const raised = [];
  for (const [rel, n] of Object.entries(counts)) {
    const prior = baseline[rel] ?? 0;
    if (n > prior) raised.push(`${rel}: ${prior} -> ${n}`);
  }
  if (raised.length > 0 && !args.allowRaise) {
    fail(
      `refusing to raise the ratchet.\n\n` +
        `File(s) with MORE hardcoded literals than their baseline row:\n\n${raised.join('\n')}\n\n` +
        `Move the new copy into an i18n catalogue instead. If the increase is genuinely\n` +
        `intentional, re-run with --allow-raise.\n\nNothing was written.`,
    );
  }

  writeFileSync(args.baseline, `${JSON.stringify(counts, null, 2)}\n`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(
    `check-i18n-literals: wrote ${Object.keys(counts).length} row(s) to ${relative(REPO_ROOT, args.baseline)} ` +
      `(${total} literal(s) total).`,
  );
  process.exit(0);
}

if (!existsSync(args.baseline)) {
  fail(`no baseline at ${args.baseline}. Run: node scripts/check-i18n-literals.mjs --update`);
}
let baseline;
try {
  baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
} catch (err) {
  fail(`cannot parse baseline ${args.baseline}: ${err.message}. Fix the JSON by hand or regenerate it with --update.`);
}

const regressions = [];
for (const [rel, n] of Object.entries(counts)) {
  const allowed = baseline[rel] ?? 0;
  if (n > allowed) regressions.push({ rel, n, allowed });
}
const improvements = Object.entries(baseline).filter(([rel, allowed]) => (counts[rel] ?? 0) < allowed);
const vanished = Object.keys(baseline).filter((rel) => !(rel in counts));

if (regressions.length > 0) {
  console.error('check-i18n-literals: hardcoded-literal count increased:\n');
  for (const { rel, n, allowed } of regressions) {
    console.error(`  ${rel}: ${n} (baseline ${allowed}, +${n - allowed})`);
  }
  console.error(
    '\nMove new UI copy into an i18n catalogue (apps/viewer/src/i18n/catalogues/<feature>.en.ts),\n' +
      'a labelKey on the data row, and t() at render — see apps/viewer/src/i18n/README.md.\n' +
      'If the increase is genuinely intentional: node scripts/check-i18n-literals.mjs --update --allow-raise',
  );
  process.exit(1);
}

for (const [rel, allowed] of improvements) {
  console.log(`note: ${rel}: ${counts[rel] ?? 0} literal(s), baseline ${allowed}; lower the baseline to the measured count`);
}
for (const rel of vanished) {
  console.log(`note: ${rel}: no longer has any hardcoded literals (baseline ${baseline[rel]}); delete its row`);
}
if (improvements.length > 0 || vanished.length > 0) {
  console.log('check-i18n-literals: run `node scripts/check-i18n-literals.mjs --update` and commit to tighten the ratchet.');
}

const totalNow = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(`check-i18n-literals: OK (${paths.length} file(s) scanned, ${Object.keys(counts).length} with hardcoded literals, ${totalNow} total)`);
