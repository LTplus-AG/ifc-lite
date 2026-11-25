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

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
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

// The full lane stays authoritative. Start with package source edits; shared
// inputs, manifests, and changes elsewhere need their own coverage audit.
const PACKAGE_SOURCE = /^packages\/([a-z0-9-]+)\/src\/.+$/s;
const PACKAGE_NAME = /^(?:@[a-z0-9_.-]+\/)?[a-z0-9_][a-z0-9_.-]*$/;
const TURBO_TEST = ['exec', 'turbo', 'test', '--only', '--concurrency=1'];

function capture(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function summary(lines) {
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
}

function mergeBase() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const pr = event.pull_request;
  const [base, head, ...rest] = capture('git', ['show', '-s', '--format=%P', 'HEAD']).trim().split(' ');
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !/^[a-f0-9]{40}$/.test(base)
    || !/^[a-f0-9]{40}$/.test(head) || rest.length || head !== pr?.head?.sha
    || pr.head.ref.startsWith('mergify/merge-queue/')) {
    throw new Error('Expected the exact two-parent ordinary PR merge checkout');
  }
  return base;
}

function inputs() {
  const base = mergeBase();
  const paths = capture('git', ['diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--'])
    .split('\0').slice(0, -1);
  const dirs = paths.map((path) => PACKAGE_SOURCE.exec(path)?.[1]);
  if (!paths.length || dirs.some((dir) => !dir)) return null;
  return { base, dirs: [...new Set(dirs)] };
}

function packageTests(plan) {
  if (!Array.isArray(plan.tasks)) throw new Error('Turbo dry run did not report tasks');
  return plan.tasks.filter(({ command }) => command !== '<NONEXISTENT>').map(({ task, package: name, command }) => {
    if (task !== 'test' || !PACKAGE_NAME.test(name) || typeof command !== 'string' || !command) {
      throw new Error('Unexpected Turbo test task in dry run');
    }
    return name;
  }).sort();
}

function runShadow() {
  const input = inputs();
  if (!input) throw new Error('Package source eligibility changed since preflight');
  const started = performance.now();
  const graph = (filters) => JSON.parse(capture('pnpm', [...TURBO_TEST, ...filters, '--dry=json']));
  const full = graph(OWN_JOB.map((name) => '--filter=!' + name));
  const affected = graph(['--filter=...[' + input.base + ']']);
  const known = new Set(full.packages.concat(OWN_JOB));
  for (const dir of input.dirs) {
    const manifest = JSON.parse(readFileSync('packages/' + dir + '/package.json', 'utf8'));
    if (!known.has(manifest.name) || !affected.packages.includes(manifest.name)) {
      throw new Error('Turbo did not resolve a changed workspace package: ' + dir);
    }
  }
  const affectedTests = new Set(packageTests(affected));
  const allTests = packageTests(full);
  const selected = allTests.filter((name) => affectedTests.has(name));
  const filters = selected.map((name) => '--filter=' + name);
  if (filters.length && JSON.stringify(packageTests(graph(filters))) !== JSON.stringify(selected)) {
    throw new Error('Exact Turbo filters did not reproduce the selected test plan');
  }

  summary([
    '### Package Node tests (shadow)',
    '',
    'Base parent: `' + input.base + '`',
    'Selected: ' + selected.length + '/' + allTests.length + ' package test tasks',
    'Queue coverage also includes the standalone integration and oracle checks.',
    'Planning: ' + Math.round(performance.now() - started) + ' ms',
    ...selected.map((name) => '- `' + name + '`'),
  ]);
  if (!filters.length) {
    summary(['No package test tasks executed.']);
    return 0;
  }

  const testStarted = performance.now();
  const child = spawnSync('pnpm', [...TURBO_TEST, ...filters, '--summarize'], { stdio: 'inherit' });
  const result = child.error?.message ?? child.signal ?? 'exit ' + child.status;
  summary(['', 'Turbo test wall time: ' + Math.round(performance.now() - testStarted) + ' ms (' + result + ')']);
  return child.status ?? 1;
}

function main(argv) {
  if (argv[0] === '--shadow-preflight') {
    const eligible = Boolean(inputs());
    if (!eligible) summary(['Package Node shadow declined: expected a nonempty, package-source-only diff.']);
    appendFileSync(process.env.GITHUB_OUTPUT, 'eligible=' + eligible + '\n');
    return;
  }
  if (argv[0] === '--shadow-run') {
    process.exitCode = runShadow();
    return;
  }

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
