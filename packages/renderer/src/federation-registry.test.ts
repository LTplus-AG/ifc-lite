/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { FederationRegistry } from './federation-registry.js';

describe('FederationRegistry - offset assignment', () => {
  it('registers models with non-overlapping offsets, a +1 gap, and overlay headroom', () => {
    const reg = new FederationRegistry();
    const offsetA = reg.registerModel('modelA', 100);
    const offsetB = reg.registerModel('modelB', 50);

    assert.equal(offsetA, 0);
    // Next model starts after modelA's range (maxExpressId 100) + 1 gap +
    // OVERLAY_ID_HEADROOM (1_000_000) reserved for mutation-added entities.
    assert.equal(offsetB, 1_000_101);
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
    const offsetB = reg.registerModel('modelB', 50); // offset 1_000_101

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

  it('allows registration landing EXACTLY on the MAX_SAFE_OFFSET boundary, rejects one past it', () => {
    // The guard is `nextOffset + maxExpressId > MAX_SAFE_OFFSET`: landing
    // exactly ON the limit must be allowed (the boundary itself is safe),
    // only crossing it must throw. Testing only far past the limit (as the
    // test above does) cannot tell `>` apart from `>=` at the boundary.
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 0); // offset 0, nextOffset -> 1 + OVERLAY_ID_HEADROOM = 1_000_001
    // sum = nextOffset(1_000_001) + maxExpressId(1_998_999_999) = 2_000_000_000 exactly.
    assert.doesNotThrow(() => reg.registerModel('modelB', 1_998_999_999));
    // nextOffset now overflows MAX_SAFE_OFFSET; any further model throws.
    assert.throws(() => reg.registerModel('modelC', 0), /exceed safe ID limit/);
  });
});

describe('FederationRegistry - toGlobalId / fromGlobalId round-trip', () => {
  it('keeps reserved but unpublished progressive IDs unpickable', () => {
    const reg = new FederationRegistry();
    const offset = reg.reserveModel('landxml', 12);
    assert.equal(offset, 0);
    assert.equal(reg.fromGlobalId(1), null, 'reservation alone never fabricates ownership');
    assert.throws(() => reg.toGlobalId('landxml', 1), /not published/);

    reg.publishRange('landxml', 1, 3);
    assert.equal(reg.toGlobalId('landxml', 1), 1);
    assert.deepEqual(reg.fromGlobalId(3), { modelId: 'landxml', expressId: 3 });
    assert.equal(reg.fromGlobalId(4), null, 'the reserved hole remains unpickable');
  });

  it('packs later models after the fixed reservation and overlay headroom', () => {
    const reg = new FederationRegistry();
    reg.reserveModel('landxml', 12);
    const offset = reg.registerModel('ifc', 0);
    assert.equal(offset, 1_000_013);
    reg.publishRange('landxml', 1, 12);
    assert.throws(() => reg.publishRange('landxml', 13, 13), /Invalid published range/);
  });

  it('rejects late source growth and bounds explicitly owned overlay headroom', () => {
    const reg = new FederationRegistry();
    reg.reserveModel('landxml', 2);
    reg.publishRange('landxml', 1, 2);
    reg.registerModel('later', 1);
    reg.publishOverlayRange('landxml', 3, 1_000_002);
    assert.deepEqual(reg.fromGlobalId(1_000_002), { modelId: 'landxml', expressId: 1_000_002 });
    assert.throws(() => reg.publishOverlayRange('landxml', 1_000_003, 1_000_003), /Invalid overlay range/);
    assert.throws(() => reg.publishRange('landxml', 3, 3), /Invalid published range/);
  });

  it('previews only the exact next overlay range without publishing ownership', () => {
    const reg = new FederationRegistry();
    reg.registerModel('editable', 3);
    const otherOffset = reg.registerModel('other', 3);

    assert.equal(reg.previewOverlayGlobalId('editable', 4, 6, 6), 6);
    assert.equal(reg.fromGlobalId(6), null, 'a GPU staging preview must not make an ID pickable');
    assert.throws(() => reg.toGlobalId('editable', 6), /not published/);
    assert.deepEqual(reg.fromGlobalId(otherOffset + 2), { modelId: 'other', expressId: 2 });
    assert.throws(
      () => reg.previewOverlayGlobalId('editable', 5, 6, 6),
      /contiguously/,
      'a preview may not skip a strict ownership hole',
    );
  });

  it('removal and reload burn only the removed reservation and preserve survivors', () => {
    const reg = new FederationRegistry();
    reg.reserveModel('first', 4);
    reg.publishRange('first', 1, 2);
    const survivor = reg.registerModel('survivor', 2);
    reg.unregisterModel('first');
    const reloaded = reg.reserveModel('first', 4);
    assert.ok(reloaded > survivor);
    assert.deepEqual(reg.fromGlobalId(survivor + 2), { modelId: 'survivor', expressId: 2 });
  });

  it('round-trips expressId -> globalId -> {modelId, expressId} across multiple models', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 100); // offset 0
    reg.registerModel('modelB', 200); // offset 1_000_101

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
    reg.registerModel('modelB', 50); // offset 1_000_101, range [1_000_101, 1_000_151]
    reg.registerModel('modelC', 30); // offset 2_000_152, range [2_000_152, 2_000_182]

    assert.deepEqual(reg.fromGlobalId(0), { modelId: 'modelA', expressId: 0 });
    assert.deepEqual(reg.fromGlobalId(100), { modelId: 'modelA', expressId: 100 });
    assert.deepEqual(reg.fromGlobalId(1_000_101), { modelId: 'modelB', expressId: 0 });
    assert.deepEqual(reg.fromGlobalId(1_000_151), { modelId: 'modelB', expressId: 50 });
    assert.deepEqual(reg.fromGlobalId(2_000_152), { modelId: 'modelC', expressId: 0 });
    assert.deepEqual(reg.fromGlobalId(2_000_182), { modelId: 'modelC', expressId: 30 });
  });

  it('N=many with a gap: unregistering a middle model leaves a dead zone that resolves to null', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 100); // range [0, 100]
    reg.registerModel('modelB', 50); // offset 1_000_101, range [1_000_101, 1_000_151]
    reg.registerModel('modelC', 30); // offset 2_000_152, range [2_000_152, 2_000_182]

    reg.unregisterModel('modelB');

    // A globalId that used to belong to modelB now lands in the gap between
    // modelA's and modelC's ranges - this is the exact collision-prevention
    // mechanism under test: it must resolve to null, never to a wrong model.
    assert.equal(reg.fromGlobalId(1_000_120), null);

    // The surrounding models are unaffected.
    assert.deepEqual(reg.fromGlobalId(50), { modelId: 'modelA', expressId: 50 });
    assert.deepEqual(reg.fromGlobalId(2_000_160), { modelId: 'modelC', expressId: 8 });
  });

  it('globalId landing before the very first range resolves to null', () => {
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 10); // offset 0, so nothing is "before" it here
    reg.registerModel('modelB', 10); // offset 1_000_011

    reg.unregisterModel('modelA');
    // Now the only remaining range starts at offset 0 is gone; sortedRanges = [modelB @1_000_011]
    assert.equal(reg.fromGlobalId(5), null, 'below the first remaining range -> null, not a wrong match');
  });
});

describe('FederationRegistry - mutation-overlay id collision with the next model', () => {
  it('an overlay-allocated id in a non-last model must not resolve to a real entity in the next model', () => {
    // StoreEditor.addEntity() (packages/mutations/src/store-editor.ts) allocates
    // new entity expressIds from a per-model watermark starting at
    // maxExistingId + 1 — it has no knowledge of the FederationRegistry's global
    // offset scheme. If the registry packs the next model's offset directly at
    // modelA.maxExpressId + 1 (a bare +1 gap), then adding even a SINGLE new
    // entity to modelA (via the AddElement tool, IDS auto-fix, etc.) produces a
    // local expressId that, once offset to a globalId, lands exactly on modelB's
    // real entity #0 — a silent misattribution to a genuine, unrelated entity.
    const reg = new FederationRegistry();
    reg.registerModel('modelA', 100); // modelA real entities occupy local ids [0, 100]
    reg.registerModel('modelB', 50);  // modelB real entities occupy local ids [0, 50]

    // Simulate StoreEditor's watermark allocation: the first entity added to
    // modelA after load gets local expressId 101 (maxExistingId + 1).
    const overlayLocalId = 101;
    reg.publishOverlayRange('modelA', overlayLocalId, overlayLocalId);
    const overlayGlobalId = reg.toGlobalId('modelA', overlayLocalId);

    const resolved = reg.fromGlobalId(overlayGlobalId);

    // It must NEVER resolve as modelB's real, pre-existing entity #0 — that is
    // a completely different element silently standing in for the newly added
    // one (annotations, BCF markup, and storey inference would all target the
    // wrong entity with no error surfaced).
    assert.notDeepEqual(resolved, { modelId: 'modelB', expressId: 0 });
  });
});

describe('FederationRegistry - extending a model whose remaining ids arrive late', () => {
  it('publishes the added ids of the newest model and moves the next offset behind them', () => {
    const reg = new FederationRegistry();
    reg.registerModel('meshes-first', 10);
    assert.throws(() => reg.toGlobalId('meshes-first', 50), /not published/);

    assert.equal(reg.extendModel('meshes-first', 50), 50);
    assert.equal(reg.toGlobalId('meshes-first', 50), 50);
    assert.deepEqual(reg.fromGlobalId(50), { modelId: 'meshes-first', expressId: 50 });
    assert.equal(reg.fromGlobalId(51), null);
    // Same packing as a model registered with 50 from the start: 50 + 1 gap + headroom.
    assert.equal(reg.registerModel('next', 5), 1_000_051);
    // Overlay ids continue after the extended range, with the full headroom.
    assert.doesNotThrow(() => reg.publishOverlayRange('meshes-first', 51, 1_000_050));
  });

  it('keeps a later model intact: the earlier one grows into its own headroom only', () => {
    const reg = new FederationRegistry();
    const offsetA = reg.registerModel('a', 10);
    const offsetB = reg.registerModel('b', 20);

    reg.extendModel('a', 50);
    assert.equal(reg.toGlobalId('a', 50), offsetA + 50);
    assert.equal(reg.getOffset('b'), offsetB);
    assert.deepEqual(reg.fromGlobalId(offsetB + 20), { modelId: 'b', expressId: 20 });
    // The headroom shrank by the 40 ids taken from it; it still ends where it did.
    assert.throws(() => reg.publishOverlayRange('a', 51, 1_000_011), /Invalid overlay range/);
    assert.doesNotThrow(() => reg.publishOverlayRange('a', 51, 1_000_010));

    assert.throws(() => reg.extendModel('b', 20 + 2_000_000_000), /safe ID limit/);
  });

  it('stops an earlier model at the end of its headroom and leaves the later model intact', () => {
    const reg = new FederationRegistry();
    reg.registerModel('a', 10);
    const offsetB = reg.registerModel('b', 20);
    assert.equal(reg.extendModel('a', 2_000_000), 1_000_010, 'published up to the last id before the later model');
    assert.equal(reg.toGlobalId('a', 1_000_010), 1_000_010);
    assert.throws(() => reg.toGlobalId('a', 1_000_011), /not published/);
    assert.deepEqual(reg.fromGlobalId(offsetB), { modelId: 'b', expressId: 0 });
    assert.throws(() => reg.publishOverlayRange('a', 1_000_011, 1_000_011), /Invalid overlay range/);
  });

  it('refuses a range that already carries overlay ids: extending across them would alias', () => {
    const reg = new FederationRegistry();
    reg.registerModel('authored', 10);
    reg.publishOverlayRange('authored', 11, 12);
    assert.throws(() => reg.extendModel('authored', 50), /overlay IDs/);
    assert.throws(() => reg.toGlobalId('authored', 13), /not published/);
  });

  it('refuses a range that is partly published, and an unknown model', () => {
    const reg = new FederationRegistry();
    reg.reserveModel('progressive', 100);
    reg.publishRange('progressive', 0, 40);
    assert.throws(() => reg.extendModel('progressive', 200), /partly published/);
    assert.throws(() => reg.extendModel('unknown', 5), /unknown model/);
  });

  it('is a no-op for ids the model already owns', () => {
    const reg = new FederationRegistry();
    reg.registerModel('a', 10);
    assert.equal(reg.extendModel('a', 4), 10);
    assert.deepEqual(reg.getGlobalIdRange('a'), { start: 0, end: 10 });
    assert.equal(reg.registerModel('b', 1), 1_000_011);
  });
});


describe('FederationRegistry - overlay allocation query', () => {
  it('requires a registered, fully published base and the next contiguous allocation', () => {
    const reg = new FederationRegistry();
    assert.equal(reg.canPublishOverlayFrom('unknown', 1), false);
    reg.reserveModel('a', 10);
    assert.equal(reg.canPublishOverlayFrom('a', 11), false);
    reg.publishRange('a', 0, 5);
    assert.equal(reg.canPublishOverlayFrom('a', 6), false);
    reg.publishRange('a', 6, 10);
    assert.equal(reg.canPublishOverlayFrom('a', 6), false, 'a smaller re-hydrated store cannot reuse published ids');
    assert.equal(reg.canPublishOverlayFrom('a', 12), false, 'publication cannot leave a hole');
    assert.equal(reg.canPublishOverlayFrom('a', 11), true);
    for (const [first, count] of [[11, 0], [11, -1], [11, 1.5], [NaN, 1], [11.5, 1], [11, Infinity]]) {
      assert.equal(reg.canPublishOverlayFrom('a', first, count), false);
    }
    reg.unregisterModel('a');
    assert.equal(reg.canPublishOverlayFrom('a', 11), false);
  });

  it('checks the entire batch at the exact non-newest headroom boundary, including authored ids', () => {
    const reg = new FederationRegistry();
    reg.registerModel('a', 10);
    reg.registerModel('later', 20);
    reg.publishOverlayRange('a', 11, 1_000_009);
    assert.equal(reg.canPublishOverlayFrom('a', 1_000_010), true);
    assert.equal(reg.canPublishOverlayFrom('a', 1_000_010, 2), false);
    assert.equal(reg.canPublishOverlayFrom('a', 11), false, 'published overlay ids cannot be reused');
    reg.publishOverlayRange('a', 1_000_010, 1_000_010);
    assert.equal(reg.canPublishOverlayFrom('a', 1_000_011), false);
  });

  it('lets the newest reservation publish beyond initial headroom up to the global safe limit', () => {
    const reg = new FederationRegistry();
    reg.registerModel('prior', 10);
    const offset = reg.registerModel('a', 10);
    const end = 2_000_000_000 - offset;
    assert.equal(reg.canPublishOverlayFrom('a', 11, end - 10), true);
    assert.equal(reg.canPublishOverlayFrom('a', 11, end - 9), false);
    assert.equal(reg.previewOverlayGlobalId('a', 11, end, end), 2_000_000_000);
    assert.equal(reg.getGlobalIdRange('a')?.end, offset + 10, 'query and preview do not publish');
    reg.publishOverlayRange('a', 11, end);
    assert.equal(reg.toGlobalId('a', end), 2_000_000_000);
    assert.equal(reg.canPublishOverlayFrom('a', end + 1), false);
    assert.throws(() => reg.publishOverlayRange('a', end + 1, end + 1), /Invalid overlay range/);
    assert.throws(() => reg.registerModel('later', 1), /safe ID limit/);
  });

  it('advances the reservation before registering a neighbour after newest overlay growth', () => {
    const reg = new FederationRegistry();
    reg.registerModel('a', 10);
    reg.publishOverlayRange('a', 11, 2_000_000);
    const offset = reg.registerModel('later', 10);
    assert.ok(offset > 2_000_000);
    assert.equal(reg.canPublishOverlayFrom('a', 2_000_001), false, 'the grown envelope was fully consumed');
  });
});

describe('overlay allocation capacity with lazy publication', () => {
  it('allows unpublished allocations without weakening publication contiguity', () => {
    const registry = new FederationRegistry();
    registry.registerModel('a', 10);
    assert.equal(registry.hasOverlayCapacity('a', 12), true);
    assert.equal(registry.canPublishOverlayFrom('a', 12), false);
    assert.throws(() => registry.publishOverlayRange('a', 12, 12), /contigu/);
    registry.registerModel('later', 10);
    assert.equal(registry.hasOverlayCapacity('a', 1_000_010), true);
    assert.equal(registry.hasOverlayCapacity('a', 1_000_011), false);
    registry.publishOverlayRange('a', 11, 1_000_010);
    assert.equal(registry.hasOverlayCapacity('a', 1_000_011), false);
  });
});
