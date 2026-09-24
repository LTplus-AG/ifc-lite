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
 * Two rules keep that from recurring:
 *  - a registry range on an @ifc-lite package must admit the workspace's
 *    current major, so a version bump that outgrows an example fails here
 *    instead of in a user's `npm install`;
 *  - every example has `build` and `typecheck`, so `pnpm build` / `pnpm
 *    typecheck` compile it alongside the packages it uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  test(`${dir}: @ifc-lite ranges admit the current workspace major`, () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@ifc-lite/') || range.startsWith('workspace:')) continue;
      const current = workspaceVersions.get(name);
      if (!current) continue; // not a workspace package
      const pinned = /^[\^~]?(\d+)\./.exec(range)?.[1];
      assert.equal(
        Number(pinned),
        major(current),
        `${dir} depends on ${name}@${range}, but the workspace ships ${current}`,
      );
    }
  });

  test(`${dir}: has build and typecheck scripts, so turbo compiles it`, () => {
    assert.equal(typeof pkg.scripts?.build, 'string', `${dir} has no build script`);
    assert.equal(typeof pkg.scripts?.typecheck, 'string', `${dir} has no typecheck script`);
  });
}
