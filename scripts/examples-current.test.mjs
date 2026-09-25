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
 *  - every @ifc-lite dependency is `workspace:*`, so an example always builds
 *    against the sources it demonstrates. A registry range drifts on its own,
 *    and the version PR rewrites it to the next, not-yet-published major
 *    without touching the lockfile, which broke `pnpm install
 *    --frozen-lockfile` on main;
 *  - every example has `build` and `typecheck`, so `pnpm build` / `pnpm
 *    typecheck` compile it alongside the packages it uses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const examples = readdirSync(join(root, 'examples'))
  .filter((dir) => existsSync(join(root, 'examples', dir, 'package.json')))
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(root, 'examples', dir, 'package.json'), 'utf8')) }));

test('found the examples', () => {
  assert.ok(examples.length >= 4, `expected at least 4 examples, found ${examples.length}`);
});

for (const { dir, pkg } of examples) {
  test(`${dir}: depends on @ifc-lite packages through the workspace`, () => {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@ifc-lite/')) continue;
      assert.equal(range, 'workspace:*', `${dir} depends on ${name}@${range}; use workspace:*`);
    }
  });

  test(`${dir}: has build and typecheck scripts, so turbo compiles it`, () => {
    assert.equal(typeof pkg.scripts?.build, 'string', `${dir} has no build script`);
    assert.equal(typeof pkg.scripts?.typecheck, 'string', `${dir} has no typecheck script`);
  });
}
