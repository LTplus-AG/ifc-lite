#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A per-file ratchet for oxlint's jsx-a11y warnings (#5607).
 *
 * `.oxlintrc.json` enables the `jsx-a11y` plugin, which runs its correctness
 * rules at WARN: visible, never blocking, like every rule outside the curated
 * error tier. On its own that only reports the debt. Measured when this was
 * wired, the viewer carried hundreds of accessibility defects (unnamed icon
 * buttons, unlabelled controls, clickable divs without keyboard handling) and
 * nothing stopped the count growing. A big-bang fix is its own change; this
 * is the ratchet that holds the line until then.
 *
 * Same CLI and baseline shape as `scripts/check-i18n-literals.mjs`: a
 * committed per-file baseline (`scripts/jsx-a11y-baseline.json`) records
 * TODAY's jsx-a11y warning count for every file oxlint lints, and the gate
 * fails when a file's count RISES above its row.
 *
 * One-way on purpose, unlike the i18n gate (whose baseline is empty, so it
 * has no rows to fall below). A file that FALLS below its row is reported
 * with a note to lower it, and `--update` records that with no
 * `--allow-raise`, but it does not fail: this baseline has 100+ non-zero
 * rows over files other PRs edit concurrently, and a PR that fixes warnings
 * in one of them without touching this file (any PR branched before it
 * existed) would otherwise merge green and turn main's Lint red with no
 * regression anywhere. Review on #5638 measured exactly that: two rows
 * (Section2DPanel.tsx 7 -> 0, SpaceMousePanel.tsx 2 -> 1) went stale on
 * main within a day. The comparison lives in `scripts/lib/count-ratchet.mjs`,
 * shared with the axe scan in the viewer smoke e2e.
 *
 * It lints the same directories as `pnpm lint` (`TARGETS` in
 * `check-lint-ran.mjs`, which also owns their file-count floors) with the
 * root's own `.oxlintrc.json`, so the rules counted here are exactly the
 * rules the lint lane reports.
 *
 * Flags:
 *   --root <dir>       lint this tree (and its .oxlintrc.json) instead of the repo
 *   --baseline <path>  read/write this baseline instead of the committed one
 *   --update           re-record every file's count
 *   --allow-raise      with --update, permit a file's count to increase
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from './check-lint-ran.mjs';
import { compareToBaseline } from './lib/count-ratchet.mjs';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPTS_DIR, '..');
/** oxlint reports a plugin rule as `jsx-a11y(<rule>)`. */
const A11Y_CODE_PREFIX = 'jsx-a11y(';

function fail(message) {
  console.error(`check-jsx-a11y: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { root: REPO_ROOT, baseline: null, update: false, allowRaise: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--root' || flag === '--baseline') {
      if (value === undefined) fail(`${flag} needs a value. Pass a path after ${flag}.`);
      out[flag.slice(2)] = resolve(value);
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
  if (out.baseline === null) out.baseline = join(out.root, 'scripts', 'jsx-a11y-baseline.json');
  return out;
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Lint every target once and count jsx-a11y diagnostics per file. Fails
 * closed on anything that is not a complete oxlint JSON report: a gate that
 * reads a missing or truncated report as "no warnings" would pass having
 * looked at nothing.
 */
function measure(root) {
  const config = join(root, '.oxlintrc.json');
  if (!existsSync(config)) fail(`no .oxlintrc.json at ${root}. Pass --root <repo-root> to point at a real checkout.`);
  const dirs = TARGETS.map(({ dir }) => join(root, dir));
  const missing = dirs.filter((d) => !isDir(d));
  if (missing.length > 0) {
    fail(`lint target(s) missing: ${missing.join(', ')}. check-lint-ran.mjs TARGETS names them; a missing one would go unmeasured.`);
  }

  // Run from the repo so `pnpm exec` resolves the pinned workspace oxlint
  // (never npx, which downloads an unpinned one; see check-lint-ran.mjs).
  const result = spawnSync(
    'pnpm',
    ['exec', 'oxlint', '--config', config, '--format', 'json', ...dirs],
    { cwd: REPO_ROOT, encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.error) fail(`could not run oxlint: ${result.error.message}`);
  if (result.signal) fail(`oxlint was killed by ${result.signal}; its report is incomplete.`);

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (err) {
    fail(`oxlint's JSON report did not parse (${err.message}). stderr:\n${result.stderr}`);
  }
  if (!Array.isArray(report.diagnostics) || !(report.number_of_files > 0)) {
    fail(`oxlint reported ${report.number_of_files} file(s) linted; exiting 0 would certify a tree nobody looked at.`);
  }

  const counts = {};
  for (const d of report.diagnostics) {
    if (typeof d.code !== 'string' || !d.code.startsWith(A11Y_CODE_PREFIX)) continue;
    const rel = relative(root, resolve(REPO_ROOT, d.filename)).split('\\').join('/');
    counts[rel] = (counts[rel] ?? 0) + 1;
  }
  return { counts, files: report.number_of_files };
}

function readBaseline(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`cannot parse baseline ${path}: ${err.message}. Fix the JSON by hand or regenerate it with --update.`);
  }
}

function sortedObject(counts) {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

const args = parseArgs(process.argv.slice(2));
const { counts, files } = measure(args.root);

if (args.update) {
  const prior = existsSync(args.baseline) ? readBaseline(args.baseline) : {};
  const { regressions } = compareToBaseline(counts, prior);
  if (regressions.length > 0 && !args.allowRaise) {
    fail(
      `refusing to raise the ratchet.\n\n` +
        `File(s) with MORE jsx-a11y warnings than their baseline row:\n\n` +
        `${regressions.map(({ key, count, allowed }) => `${key}: ${allowed} -> ${count}`).join('\n')}\n\n` +
        `Fix the new warnings instead. If the increase is genuinely intentional,\n` +
        `re-run with --allow-raise.\n\nNothing was written.`,
    );
  }
  writeFileSync(args.baseline, `${JSON.stringify(sortedObject(counts), null, 2)}\n`);
  console.log(
    `check-jsx-a11y: wrote ${Object.keys(counts).length} row(s) to ${relative(REPO_ROOT, args.baseline)} ` +
      `(${total(counts)} warning(s) total).`,
  );
  process.exit(0);
}

if (!existsSync(args.baseline)) {
  fail(`no baseline at ${args.baseline}. Run: node scripts/check-jsx-a11y.mjs --update`);
}
const { regressions, improvements } = compareToBaseline(counts, readBaseline(args.baseline));

if (regressions.length > 0) {
  console.error('check-jsx-a11y: jsx-a11y warning count increased:\n');
  for (const { key, count, allowed } of regressions) {
    console.error(`  ${key}: ${count} (baseline ${allowed}, +${count - allowed})`);
  }
  console.error(
    '\nSee them with: pnpm exec oxlint --config .oxlintrc.json <file>\n' +
      'Give icon-only buttons an aria-label, associate labels with their controls, and use\n' +
      'a <button> rather than a clickable <div>.\n' +
      'If the increase is genuinely intentional: node scripts/check-jsx-a11y.mjs --update --allow-raise',
  );
  process.exit(1);
}

// Reported, never failed: see the header for why a decrease must not turn
// main red.
for (const { key, count, allowed } of improvements) {
  console.log(`note: ${key}: ${count} warning(s), baseline ${allowed}; lower the baseline with \`node scripts/check-jsx-a11y.mjs --update\``);
}

console.log(`check-jsx-a11y: OK (${files} file(s) linted, ${Object.keys(counts).length} with jsx-a11y warnings, ${total(counts)} total)`);
