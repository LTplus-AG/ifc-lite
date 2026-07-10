/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { FederationRegistry } from './federation-registry.ts';

describe('FederationRegistry - offset assignment', () => {
  it('registers models with non-overlapping offsets and a +1 gap', () => {
    const reg = new FederationRegistry();
    const offsetA = reg.registerModel('modelA', 100);
    const offsetB = reg.registerModel('modelB', 50);

    assert.equal(offsetA, 0);
    // Next model starts after modelA's range (maxExpressId 100) + 1 gap
    assert.equal(offsetB, 101);
  });

  it('re-registering the same model returns the existing offset (no duplicate range)', () => {
    const reg = new FederationRegistry();
    const first = reg.registerModel('modelA', 100);
    const second = reg.registerModel('modelA', 999); // maxExpressId ignored on re-register
    assert.equal(first, 0);
    assert.equal(second, 0);
    assert.equal(reg.getModelCount(), 1);
  });

  it('unregisterModel removes the model but does NOT reclaim offset space (#federation gap)', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 100); // offset 0..100
    const offsetB = reg.registerModel('modelB', 50); // offset 101

    reg.unregisterModel('modelA');
    assert.equal(reg.hasModel('modelA'), false);
    assert.equal(reg.getModelCount(), 1);

    // A newly registered model must NOT reuse modelA's burned offset space,
    // otherwise stale references (selections, undo stack) could collide.
    const offsetC = reg.registerModel('modelC', 10);
    assert.ok(offsetC > offsetB, 'new offset must not reuse reclaimed space');
  });

  it('throws when registering a model would exceed MAX_SAFE_OFFSET (2_000_000_000)', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 1_999_999_990);
    assert.throws(() => reg.registerModel('modelB', 100), /exceed safe ID limit/);
  });
});

describe('FederationRegistry - toGlobalId / fromGlobalId round-trip', () => {
  it('round-trips expressId -> globalId -> {modelId, expressId} across multiple models', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 100); // offset 0
    reg.registerModel('modelB', 200); // offset 101

    const globalA = reg.toGlobalId('modelA', 42);
    const globalB = reg.toGlobalId('modelB', 42);
    assert.notEqual(globalA, globalB, 'same local expressId must map to distinct global IDs');

    const backA = reg.fromGlobalId(globalA);
    const backB = reg.fromGlobalId(globalB);
    assert.deepEqual(backA, { modelId: 'modelA', expressId: 42 });
    assert.deepEqual(backB, { modelId: 'modelB', expressId: 42 });
  });

  it('toGlobalId falls back to expressId unchanged for an unregistered model', () => {
    const reg = new FederationRegistry();
    assert.equal(reg.toGlobalId('unknownModel', 7), 7);
  });
});

describe('FederationRegistry - fromGlobalId binary search (N=0, N=1, N=many, gaps)', () => {
  it('N=0: returns null when no models are registered', () => {
    const reg = new FederationRegistry();
    assert.equal(reg.fromGlobalId(0), null);
    assert.equal(reg.fromGlobalId(12345), null);
  });

  it('N=1: single-model fallback where globalId === expressId (offset 0)', () => {
    const reg = new FederationRegistry();
    reg.registerModel('solo', 10);
    const result = reg.fromGlobalId(7);
    assert.deepEqual(result, { modelId: 'solo', expressId: 7 });
    // Confirm the "single model" identity: globalId equals expressId directly.
    assert.equal(reg.toGlobalId('solo', 7), 7);
  });

  it('N=1: globalId beyond the single model range resolves to null', () => {
    const reg = new FederationRegistry();
    reg.registerModel('solo', 10); // valid range [0, 10]
    assert.equal(reg.fromGlobalId(11), null);
  });

  it('N=many: resolves the correct model at each range boundary across several models', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 100); // range [0, 100]
    reg.registerModel('modelB', 50); // offset 101, range [101, 151]
    reg.registerModel('modelC', 30); // offset 152, range [152, 182]

    assert.deepEqual(reg.fromGlobalId(0), { modelId: 'modelA', expressId: 0 });
    assert.deepEqual(reg.fromGlobalId(100), { modelId: 'modelA', expressId: 100 });
    assert.deepEqual(reg.fromGlobalId(101), { modelId: 'modelB', expressId: 0 });
    assert.deepEqual(reg.fromGlobalId(151), { modelId: 'modelB', expressId: 50 });
    assert.deepEqual(reg.fromGlobalId(152), { modelId: 'modelC', expressId: 0 });
    assert.deepEqual(reg.fromGlobalId(182), { modelId: 'modelC', expressId: 30 });
  });

  it('N=many with a gap: unregistering a middle model leaves a dead zone that resolves to null', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 100); // range [0, 100]
    reg.registerModel('modelB', 50); // offset 101, range [101, 151]
    reg.registerModel('modelC', 30); // offset 152, range [152, 182]

    reg.unregisterModel('modelB');

    // A globalId that used to belong to modelB now lands in the gap between
    // modelA's and modelC's ranges - this is the exact collision-prevention
    // mechanism under test: it must resolve to null, never to a wrong model.
    assert.equal(reg.fromGlobalId(120), null);

    // The surrounding models are unaffected.
    assert.deepEqual(reg.fromGlobalId(50), { modelId: 'modelA', expressId: 50 });
    assert.deepEqual(reg.fromGlobalId(160), { modelId: 'modelC', expressId: 8 });
  });

  it('globalId landing before the very first range resolves to null', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 10); // offset 0, so nothing is "before" it here
    reg.registerModel('modelB', 10); // offset 11

    reg.unregisterModel('modelA');
    // Now the only remaining range starts at offset 0 is gone; sortedRanges = [modelB @11]
    assert.equal(reg.fromGlobalId(5), null, 'below the first remaining range -> null, not a wrong match');
  });
});
