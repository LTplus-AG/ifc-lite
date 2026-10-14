#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which viewer test files one `Viewer tests (shard n)` job runs.
 *
 *   find src ... | sort | node ../../scripts/viewer-test-shards.mjs
 *
 * reads candidate paths (relative to apps/viewer) on stdin and prints the
 * ones that belong to shard `TEST_SHARD` of `TEST_SHARDS`, one per line.
 * With `TEST_SHARDS` unset every path is printed, so a local `pnpm test`
 * runs the whole suite.
 *
 * Membership has two tiers:
 *
 *  1. When `TEST_SHARDS` equals the manifest's `shards` (CI's 16), a path
 *     listed in the committed manifest `apps/viewer/test-durations.json`
 *     (`seconds`: path -> measured seconds) is bin-packed by greedy LPT: longest first,
 *     ties broken by path, each onto the currently least-loaded shard, ties
 *     broken by lowest shard index. The packing is a function of the MANIFEST
 *     ALONE, never of the file list, so adding or deleting a test file moves
 *     no other file. A manifest entry whose file is gone keeps its slot in the
 *     packing (that is what keeps the others still) and is simply never
 *     printed, because only stdin paths are ever printed.
 *  2. A path NOT in the manifest falls back to the original hash of the path
 *     (the awk one-liner this replaces), so a new file always lands in exactly
 *     one shard without anyone editing the manifest. Any other shard count
 *     uses the hash for EVERY path, which keeps the documented local idiom
 *     `TEST_SHARDS=1000003 TEST_SHARD=<path hash>` (run one file) working, and
 *     keeps a changed CI matrix an exact partition until the manifest is
 *     refreshed for it.
 *
 * Refresh the manifest from a green CI run with
 * `node scripts/refresh-viewer-test-durations.mjs --run <run-id>`.
 *
 * Refuses (exit 1) rather than printing nothing: an empty selection would
 * make `tsx --test` fall back to its own default glob instead of failing.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainEntry } from './lib/is-main-entry.mjs';

export const MANIFEST_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/viewer/test-durations.json');

export class ShardSelectionError extends Error {}

/** No measured files: every path takes the hash. */
export const EMPTY_MANIFEST = Object.freeze({ shards: 0, seconds: Object.freeze({}) });

// Same alphabet and modulus as the awk program that used to select shards:
// awk's index() is 1-based and 0 for a character outside the alphabet.
const ALPHABET = ' !"#$%&()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~';

/** The legacy path hash, bit-for-bit what the awk selector computed. */
export function pathHash(path) {
  let h = 0;
  for (const ch of path) h = (h * 31 + (ALPHABET.indexOf(ch) + 1)) % 1000003;
  return h;
}

const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Greedy LPT over the manifest.
 * @param {Record<string, number>} durations path -> seconds
 * @param {number} shardCount
 * @returns {Map<string, number>} manifest path -> shard
 */
export function packManifest(durations, shardCount) {
  const entries = Object.entries(durations).sort(([pa, da], [pb, db]) => db - da || byPath(pa, pb));
  const load = new Array(shardCount).fill(0);
  const out = new Map();
  for (const [path, seconds] of entries) {
    let best = 0;
    for (let s = 1; s < shardCount; s++) if (load[s] < load[best]) best = s;
    load[best] += seconds;
    out.set(path, best);
  }
  return out;
}

/**
 * The shard every given path runs in.
 * @param {string[]} paths
 * @param {{ shards: number, seconds: Record<string, number> }} manifest
 * @param {number} shardCount
 * @returns {Map<string, number>}
 */
export function assignShards(paths, manifest, shardCount) {
  const packed = manifest.shards === shardCount ? packManifest(manifest.seconds, shardCount) : new Map();
  const out = new Map();
  for (const p of paths) out.set(p, packed.has(p) ? packed.get(p) : pathHash(p) % shardCount);
  return out;
}

/**
 * The paths shard `shard` runs, in input order.
 * @param {string[]} paths
 * @param {{ shards: number, seconds: Record<string, number> }} manifest
 * @param {number} shard
 * @param {number} shardCount
 */
export function selectShard(paths, manifest, shard, shardCount) {
  const assigned = assignShards(paths, manifest, shardCount);
  return paths.filter((p) => assigned.get(p) === shard);
}

/** Parse and validate a manifest's text. */
export function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ShardSelectionError(`manifest is not JSON: ${err.message}`);
  }
  const { shards, seconds: table } = data ?? {};
  if (!Number.isInteger(shards) || shards < 1 || !table || typeof table !== 'object' || Array.isArray(table)) {
    throw new ShardSelectionError('manifest must be { "shards": <count>, "seconds": { <path>: <seconds> } }');
  }
  for (const [path, seconds] of Object.entries(table)) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      throw new ShardSelectionError(`manifest entry ${JSON.stringify(path)} is not a non-negative number of seconds`);
    }
  }
  return { shards, seconds: table };
}

/** Parse TEST_SHARDS / TEST_SHARD. Unset TEST_SHARDS means one shard holding everything. */
export function shardFromEnv(env) {
  const count = env.TEST_SHARDS === undefined || env.TEST_SHARDS === '' ? 1 : Number(env.TEST_SHARDS);
  const shard = env.TEST_SHARD === undefined || env.TEST_SHARD === '' ? 0 : Number(env.TEST_SHARD);
  if (!Number.isInteger(count) || count < 1) {
    throw new ShardSelectionError(`TEST_SHARDS=${JSON.stringify(env.TEST_SHARDS)} is not a positive integer`);
  }
  if (!Number.isInteger(shard) || shard < 0 || shard >= count) {
    throw new ShardSelectionError(`TEST_SHARD=${JSON.stringify(env.TEST_SHARD)} is not in 0..${count - 1}`);
  }
  return { shard, count };
}

function main() {
  try {
    const { shard, count } = shardFromEnv(process.env);
    const paths = readFileSync(0, 'utf8').split('\n').filter((l) => l.length > 0);
    const manifest = count === 1 ? EMPTY_MANIFEST : parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
    const selected = selectShard(paths, manifest, shard, count);
    if (selected.length === 0) {
      throw new ShardSelectionError(`shard ${shard}/${count} selected no test files from ${paths.length} candidates`);
    }
    process.stdout.write(selected.join('\n') + '\n');
  } catch (err) {
    if (!(err instanceof ShardSelectionError)) throw err;
    console.error(`viewer-test-shards: ${err.message}`);
    process.exit(1);
  }
}

if (isMainEntry(import.meta.url)) main();
