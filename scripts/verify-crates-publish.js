#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Verifies that every crate in `scripts/lib/crates-io.mjs`'s `CRATES` list is
 * published on crates.io at the workspace version. Run this after a release
 * to catch a partial crates.io publish that `verify-npm-publish.js` cannot
 * see — npm and crates.io are two independent registries (`release-all.mjs`),
 * and npm completing tells you nothing about crates.io (#3181: the v6.0.0
 * release published all 34 npm packages while only 3 of 7 crates reached
 * crates.io, and the npm-only verifier reported nothing wrong).
 *
 * Usage:
 *   node scripts/verify-crates-publish.js
 *   node scripts/verify-crates-publish.js --retries 5 --delay 10000
 *
 * Options:
 *   --retries <n>   Number of retry attempts per crate (default: 3).
 *                    Useful right after a fresh publish while the index is
 *                    still propagating.
 *   --delay <ms>    Milliseconds to wait between retries (default: 5000).
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { CRATES, readWorkspaceVersion, isPublished, sleep } from './lib/crates-io.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  let retries = 3;
  let delay = 5000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--retries' && argv[i + 1]) retries = parseInt(argv[++i], 10);
    if (argv[i] === '--delay' && argv[i + 1]) delay = parseInt(argv[++i], 10);
  }
  return { retries, delay };
}

/**
 * Checks every `{ name, version }` in `toCheck` against `checkFn`, retrying
 * up to `retries` times with `delay` between attempts. Returns the list that
 * never came back published. Pure of `process.exit`/console noise so tests
 * can drive it with a stub registry and a fake clock.
 */
export async function verifyAll(toCheck, { retries = 3, delay = 5000, checkFn = isPublished, sleepFn = sleep, log = () => {} } = {}) {
  const failed = [];
  for (const { name, version } of toCheck) {
    let published = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
      published = await checkFn(name, version);
      if (published) break;
      if (attempt < retries) {
        log(`  ⏳  ${name}@${version} not yet visible — waiting ${delay / 1000}s (attempt ${attempt}/${retries})…`);
        await sleepFn(delay);
      }
    }
    if (published) {
      log(`  ✅  ${name}@${version}`);
    } else {
      log(`  ❌  ${name}@${version} — NOT found on crates.io`);
      failed.push({ name, version });
    }
  }
  return failed;
}

async function main() {
  const { retries, delay } = parseArgs(process.argv.slice(2));
  const version = readWorkspaceVersion(rootDir);
  const toCheck = CRATES.map((name) => ({ name, version }));

  console.log(`\nVerifying ${toCheck.length} crate(s) on crates.io (up to ${retries} retries each)…\n`);

  const failed = await verifyAll(toCheck, { retries, delay, log: (line) => console.log(line) });

  console.log();

  if (failed.length > 0) {
    console.error(`${failed.length} crate(s) missing from crates.io after publish:\n`);
    for (const { name, version } of failed) {
      console.error(`  • ${name}@${version}`);
    }
    console.error(
      '\nThis means `release:crates` failed partway through (see the release job\n' +
      'logs) or the index has not propagated yet. Re-running `pnpm release:crates`\n' +
      'is safe — it skips crates already published and only publishes what is\n' +
      'missing.\n'
    );
    process.exit(1);
  }

  console.log('All crates are published. 🎉');
}

if (isMainEntry(import.meta.url)) {
  main().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
