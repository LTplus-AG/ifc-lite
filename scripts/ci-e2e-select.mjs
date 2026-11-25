/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertListMatchesPlan, configTestDir, fileFilter, selectedFiles } from './ci-e2e-shards.mjs';
import { isMainEntry } from './lib/is-main-entry.mjs';

const SMOKE = 'tests/e2e/viewer-smoke.e2e.spec.ts';
const SHARED_INPUT = /^(?:apps\/viewer\/|packages\/|rust\/|tests\/(?:e2e|fixtures|models)\/|(?:playwright\.config\.ts|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|turbo\.json|Cargo\.lock|Cargo\.toml)$)/;

function selectSpecs(paths, inventory) {
  const available = new Set(inventory);
  const selected = new Map();
  const unknownPaths = [];
  for (const path of [...new Set(paths)].sort()) {
    if (available.has(path) && /^[\w./-]+$/.test(path)) {
      selected.set(path, 'changed-spec');
    } else {
      unknownPaths.push(path);
    }
  }
  // Shared viewer inputs can affect any journey. Probe the general smoke
  // contract while keeping those paths unknown in the evidence.
  if (unknownPaths.some((path) => SHARED_INPUT.test(path)) && available.has(SMOKE) && !selected.has(SMOKE)) {
    selected.set(SMOKE, 'shared-input-smoke');
  }
  return {
    coverage: unknownPaths.length || selected.size === 0 ? 'unknown' : 'changed-specs-only',
    unknownPaths,
    selected: [...selected].sort(([a], [b]) => a.localeCompare(b)).map(([file, reason]) => ({ file, reason })),
    omittedSpecs: inventory.filter((file) => !selected.has(file)),
  };
}

function planMerge(root, { mergeSha, headSha }) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const [commit, base, head, ...extra] = git('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ');
  // rev-list hides parents of a shallow boundary. A depth-two checkout
  // retains the synthetic merge and both parents, even for a stale PR.
  if (!mergeSha || !headSha || commit !== mergeSha || head !== headSha || !base || extra.length) {
    throw new Error('checkout is not the expected two-parent PR merge commit');
  }
  // Disable rename detection so the removed and added paths remain visible.
  // Compare with the base tip actually used by the tested merge.
  const paths = git('diff', '--name-only', '--no-renames', '-z', base, commit, '--').split('\0').filter(Boolean);
  return { mergeSha: commit, baseSha: base, headSha: head, ...selectSpecs(paths, selectedFiles(root)) };
}

function main([mode, dir], env = process.env) {
  const root = process.cwd();
  const planFile = join(dir, 'plan.json');
  if (mode === '--plan') {
    mkdirSync(dir, { recursive: true });
    let plan;
    try {
      plan = planMerge(root, { mergeSha: env.GITHUB_SHA, headSha: env.PR_HEAD_SHA });
    } catch (error) {
      plan = { coverage: 'unknown', error: error.message, mergeSha: env.GITHUB_SHA, headSha: env.PR_HEAD_SHA, selected: [] };
    }
    plan = { schemaVersion: 1, pr: env.PR_NUMBER, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, ...plan };
    writeFileSync(planFile, JSON.stringify(plan, null, 2) + '\n');
    const filters = plan.selected.map(({ file }) => fileFilter(file));
    writeFileSync(join(dir, 'filters.txt'), filters.length ? filters.join('\n') + '\n' : '');
    appendFileSync(env.GITHUB_OUTPUT, `run=${filters.length > 0}\ncoverage=${plan.coverage}\ncount=${filters.length}\n`);
    if (plan.error) throw new Error(plan.error);
  } else if (mode === '--check-list') {
    const plan = JSON.parse(readFileSync(planFile, 'utf8'));
    const testDir = configTestDir(readFileSync(join(root, 'playwright.config.ts'), 'utf8'));
    assertListMatchesPlan(readFileSync(join(dir, 'list.txt'), 'utf8'), plan.selected.map(({ file }) => file), testDir);
  } else {
    throw new Error('Usage: node scripts/ci-e2e-select.mjs --plan|--check-list <evidence-directory>');
  }
}

if (isMainEntry(import.meta.url)) main(process.argv.slice(2));
