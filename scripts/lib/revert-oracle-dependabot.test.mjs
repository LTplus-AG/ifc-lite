/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { isDependabotDependencyOnly } from './revert-oracle-dependabot.mjs';

const entries = (...paths) => paths.map((path) => ({ status: 'M', path }));

test('#4080: Dependabot-only dependency manifests and lockfiles use the normal test lanes', () => {
  assert.equal(
    isDependabotDependencyOnly(
      'dependabot[bot]',
      entries(
        'package.json',
        'packages/viewer/package.json',
        'rust/geometry/Cargo.toml',
        'pnpm-lock.yaml',
        'Cargo.lock',
        'apps/server/Dockerfile',
        'packages/collab-server/Dockerfile',
      ),
    ),
    true,
  );
});

test('#4080: the exception cannot swallow authored or mixed changes', () => {
  assert.equal(isDependabotDependencyOnly('BIMvoice', entries('package.json')), false);
  assert.equal(isDependabotDependencyOnly('app/dependabot', entries('package.json')), false);
  assert.equal(isDependabotDependencyOnly('dependabot[bot]', []), false);
  assert.equal(
    isDependabotDependencyOnly('dependabot[bot]', entries('package.json', 'packages/viewer/src/index.ts')),
    false,
  );
  assert.equal(isDependabotDependencyOnly('dependabot[bot]', entries('packages/viewer/not-package.json')), false);
  assert.equal(isDependabotDependencyOnly('dependabot[bot]', entries('apps/viewer/Dockerfile')), false);
});
