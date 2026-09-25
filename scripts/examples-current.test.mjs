/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The examples are what a developer copies to get started, and nothing held
 * them to the packages they demonstrate (#5538). The two viewers still pinned
 * parser ^3 / geometry ^2 / data ^2 while the workspace had moved to 8 / 7 / 5,
 * and no example had a `build` script, so turbo never compiled one and the
 * drift was invisible until a user ran it.
 *
 * The two viewers depend on the *published* packages (registry ranges, not
 * `workspace:*`) so their folders can be copied out of the repo (#5737).
 * Three rules keep that working:
 *  - a registry range on an @ifc-lite package targets the workspace's current
 *    major or the one before it. One behind is the window between a Version
 *    Packages PR (which bumps the workspace to a not-yet-published major) and
 *    the follow-up PR that moves the example once it is on npm. Two behind
 *    fails here, so the drift of #5538 cannot build up again;
 *  - `changeset version` must leave those ranges alone. It used to rewrite
 *    them to the just-bumped, unpublished majors without touching the
 *    lockfile, which broke `pnpm install --frozen-lockfile` on main (#5960).
 *    The test assembles the real release plan with the repo's changeset
 *    config and checks that no example with a registry range is in it;
 *  - every example has `build` and `typecheck`, so `pnpm build` / `pnpm
 *    typecheck` compile it alongside the packages it uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** `@ifc-lite/<name>` -> current workspace version. */
const workspaceVersions = new Map(
  readdirSync(join(root, 'packages'))
    .map((dir) => join(root, 'packages', dir, 'package.json'))
    .filter(existsSync)
    .map(readJson)
    .filter((pkg) => typeof pkg.name === 'string' && typeof pkg.version === 'string')
    .map((pkg) => [pkg.name, pkg.version]),
);

const examples = readdirSync(join(root, 'examples'))
  .filter((dir) => existsSync(join(root, 'examples', dir, 'package.json')))
  .map((dir) => ({ dir, pkg: readJson(join(root, 'examples', dir, 'package.json')) }));

const major = (version) => Number(/^(\d+)\./.exec(version)?.[1]);

test('found the examples and the workspace packages', () => {
  assert.ok(examples.length >= 4, `expected at least 4 examples, found ${examples.length}`);
  assert.ok(workspaceVersions.has('@ifc-lite/parser'));
});

for (const { dir, pkg } of examples) {
  test(`${dir}: @ifc-lite registry ranges target the current or previous workspace major`, () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@ifc-lite/') || range.startsWith('workspace:')) continue;
      const current = workspaceVersions.get(name);
      if (!current) continue; // not a workspace package
      const pinned = Number(/^[\^~]?(\d+)\./.exec(range)?.[1]);
      assert.ok(
        pinned === major(current) || pinned === major(current) - 1,
        `${dir} depends on ${name}@${range}, but the workspace ships ${current}: ` +
          'move it to the latest published major (`npm view ' + name + ' version`)',
      );
    }
  });

  test(`${dir}: has build and typecheck scripts, so turbo compiles it`, () => {
    assert.equal(typeof pkg.scripts?.build, 'string', `${dir} has no build script`);
    assert.equal(typeof pkg.scripts?.typecheck, 'string', `${dir} has no typecheck script`);
  });
}

/** Examples that depend on at least one @ifc-lite package by registry range. */
const registryExamples = examples.filter(({ pkg }) =>
  Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).some(
    ([name, range]) =>
      workspaceVersions.has(name) && typeof range === 'string' && !range.startsWith('workspace:'),
  ),
);

test('changeset version leaves the examples\' registry ranges alone (#5960)', async () => {
  assert.ok(registryExamples.length > 0, 'expected at least one example on registry ranges');

  // The same modules, config and package graph `changeset version` uses.
  const cli = createRequire(realpathSync(join(root, 'node_modules/@changesets/cli/package.json')));
  const load = (name) => import(pathToFileURL(cli.resolve(name)).href);
  const { getPackages } = await load('@manypkg/get-packages');
  const { readConfig } = await load('@changesets/config');
  const { assembleReleasePlan } = await load('@changesets/assemble-release-plan');

  const packages = await getPackages(root);
  const { config, errors } = await readConfig(root, packages);
  assert.deepEqual(errors ?? [], [], 'the changeset config should be valid');

  // A major bump of every @ifc-lite package the examples use: the case that
  // pushed the examples' ranges past what npm had published.
  const bumped = new Set(
    registryExamples.flatMap(({ pkg }) =>
      Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => workspaceVersions.has(name)),
    ),
  );
  const changeset = {
    id: 'examples-current-probe',
    summary: 'probe',
    releases: [...bumped].map((name) => ({ name, type: 'major' })),
  };
  const plan = assembleReleasePlan([changeset], packages, config, undefined);

  const released = new Set(plan.releases.map((release) => release.name));
  for (const name of bumped) assert.ok(released.has(name), `${name} should be in the release plan`);
  for (const { dir, pkg } of registryExamples) {
    assert.ok(
      !released.has(pkg.name),
      `changeset version would bump ${dir} (${pkg.name}) and rewrite its registry ranges to unpublished versions`,
    );
  }
});
