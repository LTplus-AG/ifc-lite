/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { absoluteOutput, assetsDirectory, requireOptions } from '../showcase-args.mjs';

test('a missing assets directory is refused instead of becoming the working directory (#8567)', () => {
  assert.throws(() => assetsDirectory(undefined, {}), /missing --assets/);
  assert.throws(() => assetsDirectory('', {}), /missing --assets/);
  assert.throws(() => assetsDirectory('  ', { SPLAT_SPIKE_ASSETS: '' }), /missing --assets/);
  assert.equal(assetsDirectory(undefined, { SPLAT_SPIKE_ASSETS: '/data/gaussian' }), '/data/gaussian');
  assert.equal(assetsDirectory('/explicit', { SPLAT_SPIKE_ASSETS: '/env' }), '/explicit', 'the argument wins over the environment');
});

test('required options name every missing value (#8567)', () => {
  assert.throws(() => requireOptions({ asset: 'a.ply' }, ['asset', 'out', 'take'], 'demo'), /missing --out, --take; usage: demo/);
  assert.throws(() => requireOptions({ asset: '' }, ['asset']), /missing --asset/);
  assert.doesNotThrow(() => requireOptions({ asset: 'a.ply', out: '/o' }, ['asset', 'out']));
});

test('outputs must be absolute directories (#8567)', () => {
  assert.equal(absoluteOutput('/tmp/take'), '/tmp/take');
  assert.throws(() => absoluteOutput('take'), /absolute/);
  assert.throws(() => absoluteOutput(undefined), /absolute/);
});
