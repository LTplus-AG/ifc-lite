/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { deploymentAssetsDir } from './deployment-assets-dir.mjs';

describe('deploymentAssetsDir (#4886)', () => {
  test('nests a Skew-Protected Vercel build under its deployment id', () => {
    assert.equal(deploymentAssetsDir('dpl_8cgPps7vhfso2x2YJ3Q9Zjfmj8Fr', '1'), 'assets/dpl_8cgPps7vhfso2x2YJ3Q9Zjfmj8Fr');
  });

  test('keeps the flat layout for local, CI and unprotected builds', () => {
    assert.equal(deploymentAssetsDir(undefined, undefined), 'assets');
    assert.equal(deploymentAssetsDir('dpl_8cgPps7vhfso2x2YJ3Q9Zjfmj8Fr', undefined), 'assets');
    assert.equal(deploymentAssetsDir('dpl_8cgPps7vhfso2x2YJ3Q9Zjfmj8Fr', '0'), 'assets');
    assert.equal(deploymentAssetsDir(undefined, '1'), 'assets');
  });

  test('never turns an unexpected id into a path segment', () => {
    for (const id of ['', 'dpl_', '../etc', 'dpl_a/b', 'dpl_a;Path=/', 'prj_abc']) {
      assert.equal(deploymentAssetsDir(id, '1'), 'assets', JSON.stringify(id));
    }
  });
});
