#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Runs one `Node scripts tests` shard: test.yml's scripts-tests job hands it
 * the whole deduplicated catch-all list, it keeps this shard's part and runs
 * `node --test` on it with the reporter flags it was given.
 *
 *   node scripts/ci-scripts-test-shards.mjs --shard=<1|2> --of=<2> [--test-reporter...=...] <files...>
 *
 * Shard 1 is a PINNED list, bin-packed from measured per-file times. Shard 2 is
 * EVERYTHING ELSE, so a test file added tomorrow runs on shard 2 without anyone
 * editing this file, and every file in the list runs on exactly one shard.
 *
 * Measured on run 43115735242 (node's count-based --test-shard): shard 2 took
 * 380 s of test time against shard 1's 110 s, because the two largest files sat
 * in it. Simulating node's three concurrent files per shard on those per-file
 * times reproduces 113 / 374 s, and gives 303 / 243 s for the split below. The
 * 303 s is one file, check-unused-locals-baseline.test.mjs, which no number of
 * shards can split.
 *
 * Refuses rather than guesses: a pinned file missing from the list (renamed or
 * deleted: re-measure and re-pin), a shard count other than SHARD_COUNT (the
 * matrix changed without this file), or a shard that would run nothing.
 */

import { spawnSync } from 'node:child_process';
import { isMainEntry } from './lib/is-main-entry.mjs';

export const SHARD_COUNT = 2;
export const CATCH_ALL = 2;

export const PINNED = Object.freeze({
  1: Object.freeze([
    'scripts/check-unused-locals-baseline.test.mjs', // 303 s
    'scripts/docs/build-api-reference.test.mjs', // 231 s
    'scripts/check-codegen-sync.test.mjs', // 64 s
    'scripts/check-packed-workflows.test.mjs', // 43 s
  ]),
});

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
  if (new Set(files).size !== files.length) throw new ShardError('the file list contains duplicates');
  const listed = new Set(files);
  const pinned = new Set(Object.values(PINNED).flat());
  const stale = [...pinned].filter((f) => !listed.has(f));
  if (stale.length > 0) {
    throw new ShardError(`pinned file(s) not in the list: ${stale.join(', ')}. Re-measure and fix PINNED in scripts/ci-scripts-test-shards.mjs`);
  }
  const mine = shard === CATCH_ALL ? files.filter((f) => !pinned.has(f)) : files.filter((f) => (PINNED[shard] ?? []).includes(f));
  if (mine.length === 0) throw new ShardError(`shard ${shard} of ${total} would run no test file`);
  return mine;
}

/** `--shard=N --of=M`, then pass-through `--test-*` flags, then files. */
export function parseArgs(argv) {
  let shard;
  let total;
  const flags = [];
  const files = [];
  for (const arg of argv) {
    if (arg.startsWith('--shard=')) shard = Number(arg.slice('--shard='.length));
    else if (arg.startsWith('--of=')) total = Number(arg.slice('--of='.length));
    else if (arg.startsWith('--test-')) flags.push(arg);
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
    console.error(`❌ ci-scripts-test-shards: ${err.message}`);
    process.exit(2);
  }
  console.error(`ci-scripts-test-shards: shard ${plan.shard}/${plan.total} runs ${plan.files.length} of ${plan.of} test files`);
  const run = spawnSync(process.execPath, ['--test', ...plan.flags, ...plan.files], { stdio: 'inherit' });
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}

if (isMainEntry(import.meta.url)) main();
