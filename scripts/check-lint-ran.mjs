#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Run the linter, and fail if it linted NOTHING.
 *
 * The gate this replaces reported pass for months while checking nothing:
 * `pnpm lint` was `pnpm -r lint`, no package in the workspace defined a `lint`
 * script, so it printed "None of the selected packages has a lint script" and
 * exited 0. The CI job named Lint spent ~30s on checkout and install and then
 * verified nothing, which is worse than having no job at all - a green tick
 * that means nothing is read as a green tick that means something.
 *
 * So the file count is asserted, not assumed. If a future refactor moves the
 * source, renames a directory or breaks the config's globs, this fails loudly
 * instead of quietly going back to linting zero files.
 *
 * NOTHING in this file may call `process.exit()`. On a pipe — which is every
 * CI log and every `pnpm lint | tee` — Node's stdout is asynchronous, and
 * `process.exit()` tears the process down with the queued write still queued.
 * oxlint's output is far larger than the pipe buffer, so the log stopped
 * mid-diagnostic with no summary and no error line: a real
 * `eslint(no-control-regex)` failure was read off such a log as "pre-existing
 * warnings, not ours". Set `process.exitCode` and let the process end on its
 * own instead; Node then drains stdout first, at any output size, on a pipe,
 * a file or a TTY alike. `fs.writeSync(1, …)` would also flush, but fd 1 is
 * non-blocking when it is a pipe, so a large enough write can throw EAGAIN —
 * i.e. it regresses precisely as output grows, which is the direction this
 * output only ever moves.
 */

import { spawnSync } from 'node:child_process';

/**
 * Where the source actually is, and how small each place is allowed to get.
 *
 * The floors are per target on purpose. A single floor over the combined run
 * cannot see one target disappear: the repo lints roughly 1,200 files under
 * `apps`, 1,650 under `packages` and 140 under `scripts`, so losing ANY ONE of
 * them still leaves well over a thousand — and `scripts` is smaller than a
 * combined floor would ever be. A rename or a widened ignore pattern that
 * silences a whole directory is exactly the failure this script exists to
 * catch, so each directory is counted against its own number.
 *
 * The floors sit well under today's counts: deleting a genuine chunk of code
 * must not fail the lint lane, but a target dropping out cannot hide.
 */
const TARGETS = [
  { dir: 'apps', min: 900 },
  { dir: 'packages', min: 1200 },
  { dir: 'scripts', min: 100 },
];

/** oxlint's summary: "Finished in Xms on N files with M rules using K threads."
 *  Anchored on "Finished in", and the LAST match wins: the pattern alone can
 *  appear earlier in the output, because a warning quotes the source line it
 *  fired on and a source line can contain anything. A literal
 *  `"ran on 1 files with 1 rules"` in a source file was enough to make an
 *  unanchored first-match read report one file and fail a healthy run. */
const SUMMARY_RE = /Finished in [^\n]*? on (\d[\d,]*) files with (\d+) rules/g;

/** Run oxlint over one directory and return what it says it did, or `null` if
 *  the run cannot be trusted — the caller then stops with exit code 1. */
function lint(dir) {
  // `pnpm exec` rather than `npx`: npx silently DOWNLOADS the latest oxlint when
  // the workspace copy is missing, so a broken install would lint with an
  // unpinned version instead of failing. `pnpm exec` fails loudly.
  const result = spawnSync(
    'pnpm',
    ['exec', 'oxlint', '--config', '.oxlintrc.json', '--format', 'default', dir],
    { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 },
  );

  if (result.error) {
    console.error(`lint: could not run oxlint on ${dir}: ${result.error.message}`);
    return null;
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  process.stdout.write(output);

  const finished = [...output.matchAll(SUMMARY_RE)].at(-1);
  if (!finished) {
    console.error(`lint: oxlint printed no summary for ${dir}, so it is not clear it ran at all`);
    return null;
  }
  return {
    files: Number(finished[1].replace(/,/g, '')),
    rules: Number(finished[2]),
    status: result.status ?? 1,
  };
}

/** Returns the exit code. Every path RETURNS it — see the header: an exit code
 *  assigned to `process.exitCode` lets Node drain stdout, `process.exit()`
 *  does not. */
function main() {
  let totalFiles = 0;
  let ruleCount = 0;
  let failed = 0;
  const short = [];

  for (const { dir, min } of TARGETS) {
    const run = lint(dir);
    if (run === null) return 1; // lint() has already said why
    const { files, rules, status } = run;
    totalFiles += files;
    ruleCount = Math.max(ruleCount, rules);
    if (status !== 0) failed = status;
    if (files < min) short.push({ dir, files, min });
    if (rules === 0) {
      console.error(`lint: oxlint ran with zero rules enabled on ${dir}, so it checked nothing`);
      return 1;
    }
  }

  if (short.length > 0) {
    console.error('lint: a lint target shrank past its floor, which is how this gate goes');
    console.error('      quiet — the config globs no longer match the source there:\n');
    for (const { dir, files, min } of short) {
      console.error(`      ${dir}: ${files} files (expected at least ${min})`);
    }
    return 1;
  }

  if (failed !== 0) return failed;
  console.log(`lint: ${totalFiles.toLocaleString()} files across ${TARGETS.length} targets, ${ruleCount} rules, no errors.`);
  return 0;
}

process.exitCode = main();
