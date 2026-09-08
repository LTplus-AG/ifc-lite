#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Ratchet: `.github/workflows/sdk-canary.yml`'s `paths:` filter must cover
 * every workspace package the job actually builds.
 *
 * THE DEFECT (#3452). The canary job runs
 * `pnpm turbo build --filter=@ifc-lite/extensions --filter=@ifc-lite/cli`,
 * which -- because `build` depends on `^build` in turbo.json -- builds the
 * FULL transitive workspace-dependency closure of both packages, in
 * topological order. The workflow's `on.pull_request.paths` named only
 * `packages/extensions/**` and `packages/cli/**`: two of the packages the
 * job actually builds from. A PR touching any other package in the closure
 * (`parser`, `sdk`, `wasm`, `mcp`, `collab`, ... -- 27 more, at the time this
 * was written) triggered no run at all: not a failure, no row, indistinguishable
 * from a pass to anyone reading the check list.
 *
 * `scripts/check-ci-path-coverage.mjs` cannot see this class: it only
 * recognises gates invoked as a literal `node scripts/*.mjs` in a `run:`
 * step, and this job's steps are `pnpm turbo build` and
 * `node packages/cli/dist/index.js ext test`. This gate exists to cover
 * exactly the case that one documents as its own blind spot.
 *
 * WHAT THIS DOES. Parses the `--filter=<pkg>` build targets out of the
 * workflow's own build step, walks the REAL `dependencies` +
 * `devDependencies` workspace graph (both -- turbo's internal package graph,
 * derived from the pnpm workspace, does not distinguish them, so a
 * `devDependency`-only package still gets built before its dependent) from
 * each target to the full transitive closure, and checks every package's
 * directory against the workflow's `on.pull_request.paths`. Anything in the
 * closure that no glob covers is a NAMED violation.
 *
 * DELIBERATELY NOT A HAND-MAINTAINED LIST. The obvious fix -- write out the
 * ~29-package closure as literal `paths:` entries -- rots exactly the way the
 * 2-of-20 list already did: nothing forces the next dependency edit to update
 * it. This derives the closure from the same `package.json` files the build
 * itself reads, so the two cannot drift apart without this gate noticing.
 * A hand-edited list is still the OUTPUT (see the `paths:` block this PR
 * writes into the workflow) -- it is verified on every run rather than
 * trusted once. Also note `@ifc-lite/viewer-core` (a `packages/cli`
 * dependency) lives in `packages/viewer`, not `packages/viewer-core` -- the
 * package NAME and its directory diverge here, which is exactly the kind of
 * detail a hand-maintained list silently gets wrong and a derived one cannot.
 *
 * FAILS CLOSED. A missing workflow, an unparseable trigger, no `--filter=`
 * targets found, a closure package with no `packages/<dir>` on disk, or a
 * dependency name the workspace scan never saw -- each is a NAMED failure,
 * never a silent pass.
 *
 * Run via `node scripts/check-sdk-canary-coverage.mjs` (CI Node tests job).
 * `--root <dir>` points it at a mutated copy of the tree; that is how
 * `check-sdk-canary-coverage.test.mjs` proves it fires.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { matchesAny, parseWorkflowPrPaths } from './lib/ci-path-coverage.mjs';
import { listWorkspacePackages } from './lib/list-workspace-packages.mjs';

const rootFlag = process.argv.indexOf('--root');
const ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? process.argv[rootFlag + 1]
    : join(dirname(fileURLToPath(import.meta.url)), '..');

const WORKFLOW = '.github/workflows/sdk-canary.yml';
const abs = (p) => join(ROOT, p);

class CheckFailure extends Error {}
function fail(message) {
  throw new CheckFailure(message);
}

function main() {
  let text;
  try {
    text = readFileSync(abs(WORKFLOW), 'utf8');
  } catch (err) {
    fail(`cannot read ${WORKFLOW}: ${err.code || err.message}.`);
  }

  // 1. The build targets: the `--filter=<pkg>` values on the turbo build
  //    step. This is the SAME command GitHub Actions will run, read literally
  //    rather than assumed, so a future change to which packages get built
  //    (e.g. dropping `--filter=@ifc-lite/extensions`) changes what this gate
  //    checks without anyone having to remember to update it here too.
  const buildStep = text.match(/run:\s*pnpm turbo build\b([^\n]*)/);
  if (!buildStep) {
    fail(
      `${WORKFLOW}: no \`pnpm turbo build\` step found. This gate cannot determine ` +
        'which packages the canary job actually builds.',
    );
  }
  const targets = [...buildStep[1].matchAll(/--filter=(\S+)/g)].map((m) => m[1]);
  if (targets.length === 0) {
    fail(
      `${WORKFLOW}: the turbo build step has no --filter=<pkg> arguments. ` +
        'Refusing to check coverage of an empty target set as if it were correct.',
    );
  }

  // 2. The real workspace dependency graph: every packages/* package, keyed
  //    by its package.json `name`, with the union of its `dependencies` and
  //    `devDependencies` that use the `workspace:` protocol.
  const { packages } = listWorkspacePackages(ROOT, fail, ['packages']);
  const byName = new Map();
  for (const pkg of packages) {
    const name = pkg.pkgJson?.name;
    if (typeof name !== 'string' || name === '') {
      fail(`${pkg.dir}/package.json has no string "name" -- cannot key the dependency graph.`);
    }
    const deps = { ...(pkg.pkgJson.dependencies || {}), ...(pkg.pkgJson.devDependencies || {}) };
    const workspaceDeps = Object.entries(deps)
      .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('workspace:'))
      .map(([dep]) => dep);
    byName.set(name, { rel: pkg.rel, workspaceDeps });
  }

  // 3. BFS the transitive closure from every build target.
  const closure = new Set();
  const queue = [...targets];
  while (queue.length > 0) {
    const name = queue.pop();
    if (closure.has(name)) continue;
    closure.add(name);
    const info = byName.get(name);
    if (!info) {
      fail(
        `${WORKFLOW} builds "${name}", which is not a package name found under packages/*. ` +
          'Either the workspace moved it or this gate\'s package scan is stale -- either way ' +
          'the closure below would be short, not empty, so refusing rather than proceeding.',
      );
    }
    for (const dep of info.workspaceDeps) queue.push(dep);
  }

  // 4. The trigger. `triggersOnPr: false` or `paths: null` both mean "every
  //    path reaches this job" -- the same convention check-ci-path-coverage
  //    uses -- so there is nothing to check; a job with no path filter cannot
  //    have this defect.
  let triggersOnPr;
  let paths;
  try {
    ({ triggersOnPr, paths } = parseWorkflowPrPaths(text));
  } catch (err) {
    fail(`cannot read the triggers of ${WORKFLOW}: ${err.message}`);
  }
  if (!triggersOnPr || paths === null) {
    console.log(
      `✅ check-sdk-canary-coverage: ${WORKFLOW} has no path filter (or none on pull_request) -- ` +
        'every path reaches it, so the closure cannot be uncovered.',
    );
    return;
  }

  // 5. The mechanical diff: every closure package's directory must be
  //    covered by some glob in `paths`.
  const violations = [];
  for (const name of [...closure].sort()) {
    const info = byName.get(name);
    if (!matchesAny(info.rel, paths)) {
      violations.push({ name, rel: info.rel });
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n❌ check-sdk-canary-coverage: ${WORKFLOW} builds ${closure.size} package(s) ` +
        `(transitively, from ${targets.join(', ')}) but its \`paths:\` filter covers only ` +
        `${closure.size - violations.length} of them.\n`,
    );
    for (const v of violations) {
      console.error(`  • ${v.name} (${v.rel}/**) can trigger a build that never runs.`);
    }
    console.error(
      '\nA change to any of the packages above breaks the canary job without the job ever\n' +
        `running. Add each missing directory to ${WORKFLOW}'s \`paths:\`.\n`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `✅ check-sdk-canary-coverage: ${WORKFLOW}'s \`paths:\` covers all ${closure.size} ` +
      `package(s) transitively built from ${targets.join(', ')}.`,
  );
}

try {
  main();
} catch (err) {
  if (err instanceof CheckFailure) {
    console.error(`❌ check-sdk-canary-coverage: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
