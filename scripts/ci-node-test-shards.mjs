#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which workspace packages' `test` task each `Node tests (shard n/4)` job runs.
 *
 *   node scripts/ci-node-test-shards.mjs --shard <1-4>
 *
 * prints the `turbo --filter=...` arguments for that shard, one per line.
 *
 * Shards 1-3 are PINNED lists, bin-packed from a measured run (mcp 210 s,
 * cli 193 s, create 110 s were 45% of the 1,142 s single lane). Shard 4 is
 * EVERYTHING ELSE, expressed as an exclusion of the pinned lists, so a package
 * added tomorrow runs on shard 4 without anyone editing this file.
 *
 * The failure this guards against is a suite that silently never runs. A
 * pinned name that stops matching a workspace package (renamed, removed)
 * would drop out of its pinned shard AND stay excluded from shard 4, so the
 * CLI refuses to print filters until every pinned name resolves.
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspacePackages } from './lib/list-workspace-packages.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

/** Packages whose suites run in their own jobs (viewer-tests, provenance-tests). */
export const OWN_JOB = Object.freeze(['@ifc-lite/viewer', '@ifc-lite/provenance']);

export const PINNED = Object.freeze({
  1: Object.freeze(['@ifc-lite/mcp', '@ifc-lite/parser', '@ifc-lite/sandbox']),
  2: Object.freeze(['@ifc-lite/cli', '@ifc-lite/flow-nodes', '@ifc-lite/renderer', '@ifc-lite/rules']),
  3: Object.freeze(['@ifc-lite/create', '@ifc-lite/export', '@ifc-lite/ids', '@ifc-lite/collab-server']),
});

export const CATCH_ALL = 4;
export const SHARD_COUNT = 4;

// Same parents as pnpm-workspace.yaml.
const WORKSPACE_PARENTS = ['packages', 'apps', 'examples'];

export class ShardError extends Error {}

function fail(message) {
  throw new ShardError(message);
}

/**
 * Every pinned or own-job name must be a workspace package.
 * @param {Iterable<string>} workspaceNames
 */
export function assertNamesResolve(workspaceNames) {
  const names = new Set(workspaceNames);
  const missing = [...Object.values(PINNED).flat(), ...OWN_JOB].filter((n) => !names.has(n));
  if (missing.length > 0) {
    fail(
      `shard list names ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not ` +
        'a workspace package. Fix PINNED/OWN_JOB in scripts/ci-node-test-shards.mjs; a stale ' +
        'name would leave that suite in no shard at all.',
    );
  }
}

/**
 * The turbo filter arguments for one shard.
 * @param {number} shard
 * @returns {string[]}
 */
export function shardFilters(shard) {
  if (PINNED[shard]) return PINNED[shard].map((p) => `--filter=${p}`);
  if (shard === CATCH_ALL) {
    return [...OWN_JOB, ...Object.values(PINNED).flat()].map((p) => `--filter=!${p}`);
  }
  return fail(`unknown shard ${JSON.stringify(shard)}; expected 1-${SHARD_COUNT}.`);
}

/**
 * The shard each package lands in, by the same rules turbo applies to the
 * filters above: a pinned shard takes its listed names, the catch-all takes
 * every name none of its negative filters remove. Own-job packages land in
 * no shard. Used by the test to prove the shards PARTITION the workspace.
 * @param {Iterable<string>} workspaceNames
 * @returns {Map<string, number[]>} package -> shards that would run it.
 */
export function assignment(workspaceNames) {
  const out = new Map();
  for (const name of workspaceNames) {
    const shards = [];
    for (let s = 1; s <= SHARD_COUNT; s++) {
      const filters = shardFilters(s);
      const positive = filters.filter((f) => !f.startsWith('--filter=!')).map((f) => f.slice(9));
      const negative = filters.filter((f) => f.startsWith('--filter=!')).map((f) => f.slice(10));
      const selected = positive.length > 0 ? positive.includes(name) : !negative.includes(name);
      if (selected) shards.push(s);
    }
    out.set(name, shards);
  }
  return out;
}

/** @param {string} root */
export function workspacePackageNames(root) {
  const { packages } = listWorkspacePackages(root, fail, WORKSPACE_PARENTS);
  return packages.map(({ pkgJson }) => pkgJson?.name).filter((n) => typeof n === 'string');
}

function main(argv) {
  const at = argv.indexOf('--shard');
  const shard = at >= 0 ? Number(argv[at + 1]) : NaN;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    assertNamesResolve(workspacePackageNames(root));
    for (const f of shardFilters(shard)) console.log(f);
  } catch (err) {
    if (!(err instanceof ShardError)) throw err;
    console.error(`::error::ci-node-test-shards: ${err.message}`);
    process.exit(1);
  }
}

if (isMainEntry(import.meta.url)) main(process.argv.slice(2));
