#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runs one `Node scripts tests` shard: test.yml's scripts-tests job hands it
 * the whole deduplicated catch-all list, it keeps this shard's part and runs
 * `node --test` on it with the reporter flags it was given.
 *
 *   node scripts/ci-scripts-test-shards.mjs --shard=<1|2> --of=<2> [--test-reporter[-destination]=...] <files...>
 *
 * Shard 1 is a PINNED list of the heaviest files by measured time (run
 * 43115735242); shard 2 is EVERYTHING ELSE, so a test file added tomorrow runs
 * on shard 2 without anyone editing this file, and every file in the list runs
 * on exactly one shard. A pinned list rather than a duration manifest such as
 * viewer-test-shards.mjs's: at two shards the pins are the whole plan, and a
 * renamed pin fails loudly instead of being re-placed by hash.
 *
 * Refuses rather than guesses: a pinned file missing from the list (renamed or
 * deleted: re-measure and re-pin), a shard count other than SHARD_COUNT (the
 * matrix changed without this file), or a shard that would run nothing.
 */

import { spawnSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';

export const SHARD_COUNT = 2;

/** Shard 1's files. Re-measure and re-pin when shard 1 stops being the heavier half. */
export const PINNED = Object.freeze([
  'scripts/check-unused-locals-baseline.test.mjs',
  'scripts/docs/build-api-reference.test.mjs',
  'scripts/check-codegen-sync.test.mjs',
  'scripts/check-packed-workflows.test.mjs',
]);

export class ShardError extends Error {}

/**
 * This shard's files, in the order given.
 * @param {string[]} files the full list, every shard sees the same one
 * @param {number} shard 1-based
 * @param {number} total the number of shards the matrix expanded
 * @returns {string[]}
 */
export function filesForShard(files, shard, total) {
  if (total !== SHARD_COUNT) {
    throw new ShardError(`the matrix runs ${total} shard(s) but this file splits for ${SHARD_COUNT}; change both together`);
  }
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) {
    throw new ShardError(`shard ${shard} is not between 1 and ${SHARD_COUNT}`);
  }
  const listed = new Set(files);
  if (listed.size !== files.length) throw new ShardError('the file list contains duplicates');
  const pinned = new Set(PINNED);
  const stale = PINNED.filter((f) => !listed.has(f));
  if (stale.length > 0) {
    throw new ShardError(`pinned file(s) not in the list: ${stale.join(', ')}. Re-measure and fix PINNED in scripts/ci-scripts-test-shards.mjs`);
  }
  const mine = files.filter((f) => pinned.has(f) === (shard === 1));
  if (mine.length === 0) throw new ShardError(`shard ${shard} of ${total} would run no test file`);
  return mine;
}

/** `--shard=N --of=M`, pass-through `--test-reporter*` flags, then files. */
export function parseArgs(argv) {
  let shard;
  let total;
  const flags = [];
  const files = [];
  for (const arg of argv) {
    if (arg.startsWith('--shard=')) shard = Number(arg.slice('--shard='.length));
    else if (arg.startsWith('--of=')) total = Number(arg.slice('--of='.length));
    // Reporter flags only: --test-shard, --test-name-pattern, --test-only and
    // the like would let node run less than this shard's files.
    else if (/^--test-reporter(?:-destination)?=/.test(arg)) flags.push(arg);
    else if (arg.startsWith('-')) throw new ShardError(`unknown option ${arg}`);
    else files.push(arg);
  }
  if (shard === undefined || total === undefined) throw new ShardError('--shard=N and --of=M are both required');
  return { shard, total, flags, files };
}

function main() {
  let plan;
  try {
    const { shard, total, flags, files } = parseArgs(process.argv.slice(2));
    plan = { flags, files: filesForShard(files, shard, total), shard, total, of: files.length };
  } catch (err) {
    console.error(`::error title=scripts-tests shard::ci-scripts-test-shards: ${err.message}`);
    process.exit(2);
  }
  console.error(`ci-scripts-test-shards: shard ${plan.shard}/${plan.total} runs ${plan.files.length} of ${plan.of} test files`);
  const run = spawnSync(process.execPath, ['--test', ...plan.flags, ...plan.files], { stdio: 'inherit' });
  if (run.error) throw run.error;
  if (run.signal) console.error(`::error title=scripts-tests shard::node --test was killed by ${run.signal}`);
  process.exit(run.status ?? 1);
}

if (isMainEntry(import.meta.url)) main();
