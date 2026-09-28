/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { SweptDiskDescriptions } from '@ifc-lite/geometry';
import { SweptDiskCache, type AnalyticSourceModel } from './swept-disk-cache.js';

class ControlledCache extends SweptDiskCache {
  readonly batches: Array<{ ids: number[]; finish: (diagnostics?: string[]) => void }> = [];

  protected override extract(_model: AnalyticSourceModel, ids: readonly number[]): Promise<SweptDiskDescriptions> {
    return new Promise((resolve) => {
      this.batches.push({
        ids: [...ids],
        finish: (diagnostics = []) => resolve({
          up_axis: 'Z', units: 'm', coordinate_space: 'absolute_ifc_world',
          elements: Object.fromEntries(ids.map((id) => [String(id), []])), diagnostics,
        }),
      });
    });
  }
}

it('serializes overlapping follow-up selections after one in-flight batch (#5778)', async () => {
  const cache = new ControlledCache();
  const release = cache.retain();
  const model: AnalyticSourceModel = { id: 'rebar', ifcDataStore: null,
    sourceFile: new File(['ISO-10303-21'], 'rebar.ifc') };
  try {
    const first = cache.get(model, [1]);
    const second = cache.get(model, [2]);
    const third = cache.get(model, [2]);
    assert.deepEqual(cache.batches.map((batch) => batch.ids), [[1]],
      'both later selections wait for the first extraction');

    cache.batches[0].finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cache.batches.map((batch) => batch.ids), [[1], [2]],
      'concurrent waiters share one follow-up extraction for the same product');

    cache.batches[1].finish();
    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
    assert.deepEqual([...firstResult.keys()], [1]);
    assert.deepEqual([...secondResult.keys()], [2]);
    assert.deepEqual([...thirdResult.keys()], [2]);
  } finally {
    release();
  }
});

it('routes each product diagnostic once without prefix collisions (#5778)', async () => {
  const cache = new ControlledCache();
  const release = cache.retain();
  const model: AnalyticSourceModel = { id: 'rebar', ifcDataStore: null,
    sourceFile: new File(['ISO-10303-21'], 'rebar.ifc') };
  try {
    const pending = cache.get(model, [1, 2]);
    cache.batches[0].finish([
      'product #1: unsupported directrix',
      'product #2, solid #3: modified by boolean operation',
      'product #11: a different product',
      'other diagnostic without a product',
      'product #1, solid #4: second occurrence',
    ]);
    const products = await pending;
    assert.deepEqual(products.get(1)?.diagnostics, [
      'product #1: unsupported directrix',
      'product #1, solid #4: second occurrence',
    ]);
    assert.deepEqual(products.get(2)?.diagnostics, [
      'product #2, solid #3: modified by boolean operation',
    ]);
  } finally {
    release();
  }
});
