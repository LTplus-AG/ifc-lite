/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether a merge-queue batch runs the SMLib native-adapter lane
 * (geometry-platform.yml): its paths list, less BATCH_EXCLUDE, plus BATCH_KEEP.
 * The lane takes over an hour, and the full list (the labelled-PR route's)
 * sent unrelated batches through it (#10595: a CLI test and
 * tests/models/manifest.json). FAILS CLOSED: an unreadable paths list, a
 * checkout that is not the two-parent merge commit, an empty or unreadable
 * diff, and any change to a file the decision reads (the workflow, the CLI
 * and its imports, read from the batch's HEAD) all answer `run: true`. The
 * CLI and the guard live in scripts/check-native-adapter-triggers.mjs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';
import { matchesAny } from './ci-path-coverage.mjs';

/**
 * Globs of `on.pull_request.paths` that do NOT run the lane on a merge-queue
 * batch: inputs the labelled-PR route wants, outside the native/retained
 * engine (crates in the closure that are not the engine, the CLI and wasm
 * packaging, the viewer host, corpus and repo-wide config). Each entry is
 * removed verbatim, so a narrower glob under it (rust/processing/src/processor/**)
 * still runs, and a path added to the workflow runs until it is listed here.
 * A script the lane runs with `node scripts/...` cannot be excluded
 * (check-native-adapter-triggers.mjs's audit holds that).
 */
export const BATCH_EXCLUDE = [
  'rust/clash/**',
  'rust/core/**',
  'rust/export/**',
  'rust/landxml/**',
  'rust/processing/**',
  'rust/testkit/**',
  'packages/cli/**',
  'packages/geometry/**',
  'packages/wasm/**',
  'apps/viewer/src/components/viewer/Viewport.tsx',
  'apps/viewer/src/components/viewer/ViewportContainer.tsx',
  'apps/viewer/vite.config.ts',
  'apps/viewer/vite-plugins/**',
  'apps/viewer/package.json',
  'apps/viewer/public/_fixtures/AC20-FZK-Haus.ifc',
  'apps/viewer/public/samples/building-architecture.ifc',
  'apps/viewer/public/samples/hello-wall.ifc',
  'playwright.config.ts',
  'tests/benchmark/frames/**',
  'tests/models/manifest.json',
  'pnpm-workspace.yaml',
  'package.json',
  'turbo.json',
  'LICENSE',
];

/** Retained code under an excluded glob, which a batch still runs on. Each must sit under a paths-list glob. */
export const BATCH_KEEP = [
  'packages/cli/src/retained/**',
  'packages/cli/src/**/*retained*',
  'rust/processing/**/*retained*',
];

/** On a batch, the paths list less `exclude`, plus `keep`. */
export const batchGlobs = (pr, exclude = BATCH_EXCLUDE, keep = BATCH_KEEP) => [...pr.filter((g) => !exclude.includes(g)), ...keep];

/** `entries` and every `scripts/` module they import, transitively; a missing file ends its branch. */
export function scriptImports(root, entries) {
  const queue = [...entries];
  const seen = new Set();
  while (queue.length > 0) {
    const script = queue.pop();
    if (seen.has(script)) continue;
    seen.add(script);
    if (!existsSync(join(root, script))) continue;
    for (const m of readFileSync(join(root, script), 'utf8').matchAll(/from '(\.{1,2}\/[^']+\.mjs)'/g)) {
      const next = posix.normalize(posix.join(posix.dirname(script), m[1]));
      if (next.startsWith('scripts/')) queue.push(next);
    }
  }
  return seen;
}

// -z: without it git quotes a non-ASCII path, which then matches no glob.
const gitPaths = (root, args) => execFileSync('git', ['-C', root, ...args, '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);

/**
 * Whether a merge-queue batch must run the lane, given the workflow's paths
 * list `pr` and the `decider` files the decision itself reads. The
 * `pull_request` checkout is the merge of the batch into `main`, so its first
 * parent is `main` and the diff against it is the batch. Every doubt answers
 * `run: true`.
 */
export function decideBatch(root, pr, decider) {
  let changed;
  let hits;
  try {
    const parents = execFileSync('git', ['-C', root, 'rev-list', '--parents', '-n', '1', 'HEAD'], { encoding: 'utf8' }).trim().split(' ').filter(Boolean);
    if (parents.length !== 3) return { run: true, reason: `HEAD has ${Math.max(parents.length - 1, 0)} parent(s), not the two of a PR merge commit; running` };
    // --no-renames: a file moved out of a watched directory must count by its old path too.
    changed = gitPaths(root, ['diff', '--name-only', '--no-renames', parents[1], 'HEAD']);
    if (changed.length === 0) return { run: true, reason: 'the batch diff is empty, which a real batch never is; running' };
    const own = changed.find((f) => decider.has(f));
    if (own) return { run: true, reason: `the batch changes ${own}, which this decision reads; running` };
    const globs = batchGlobs(pr);
    hits = changed.filter((f) => matchesAny(f, globs));
  } catch (err) {
    return { run: true, reason: `cannot decide (${err.message.split('\n')[0]}); running` };
  }
  if (hits.length === 0) return { run: false, reason: `none of the batch's ${changed.length} changed file(s) is a path the lane observes` };
  const shown = hits.slice(0, 10).join(', ');
  return { run: true, reason: `${hits.length} of ${changed.length} changed file(s) are paths the lane observes: ${shown}${hits.length > 10 ? ', ...' : ''}` };
}
