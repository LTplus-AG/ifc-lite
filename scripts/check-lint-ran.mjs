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
 */

import { spawnSync } from 'node:child_process';

/** Where the source actually is. A path that stops matching is the failure
 *  mode this script exists to catch, so they are checked below. */
const TARGETS = ['apps', 'packages', 'scripts'];

/** Below this, something has gone wrong with the globs rather than with the
 *  code. The repo lints several thousand files; 500 is a floor, not a target. */
const MIN_FILES = 500;

// `pnpm exec` rather than `npx`: npx silently DOWNLOADS the latest oxlint when
// the workspace copy is missing, so a broken install would lint with an
// unpinned version instead of failing. `pnpm exec` fails loudly.
const result = spawnSync(
  'pnpm',
  ['exec', 'oxlint', '--config', '.oxlintrc.json', '--format', 'default', ...TARGETS],
  { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 32 * 1024 * 1024 },
);

if (result.error) {
  console.error(`lint: could not run oxlint: ${result.error.message}`);
  process.exit(1);
}

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
process.stdout.write(output);

// oxlint's summary line: "Finished in Xms on N files with M rules using K
// threads." Anchored on "Finished in", and the LAST match wins: the pattern
// alone can appear earlier in the output, because a warning quotes the source
// line it fired on and a source line can contain anything. A literal
// `"ran on 1 files with 1 rules"` in a source file was enough to make an
// unanchored first-match read report one file and fail a healthy run.
const matches = [...output.matchAll(/Finished in [^\n]*? on (\d[\d,]*) files with (\d+) rules/g)];
const finished = matches.at(-1);
if (!finished) {
  console.error('lint: oxlint printed no summary, so it is not clear it ran at all');
  process.exit(1);
}

const files = Number(finished[1].replace(/,/g, ''));
const rules = Number(finished[2]);
if (files < MIN_FILES) {
  console.error(
    `lint: only ${files} files were linted (expected at least ${MIN_FILES}).\n`
    + 'That is the vacuous-gate failure this check exists for: the config globs\n'
    + `no longer match the source. Targets were: ${TARGETS.join(', ')}.`,
  );
  process.exit(1);
}
if (rules === 0) {
  console.error('lint: oxlint ran with zero rules enabled, so it checked nothing');
  process.exit(1);
}

if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`lint: ${files.toLocaleString()} files, ${rules} rules, no errors.`);
