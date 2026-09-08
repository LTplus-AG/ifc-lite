/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The federation invariant "every express id on a mesh is global", for the
 * source representation item — `MeshData.geometryItemId` on the flat path and
 * `DecodedInstance.itemId` on the GPU-instanced path (#2985/#3199).
 *
 * **The defect this pins.** The loader shifted `expressId` and (since #1781)
 * `textureRef.textureId` by the model's federation `idOffset` and left
 * `geometryItemId` in the model's LOCAL id space, on a mesh whose `expressId`
 * beside it was already global. Resolution back to (model, expressId) in this
 * app is RANGE-based — `FederationRegistry.fromGlobalId` /
 * `getModelForGlobalId` and `modelSlice.resolveGlobalIdFromModels` all ask
 * which model's id range contains the number — so an unshifted item id from a
 * model loaded at offset 1,000,000 is a small number that falls squarely
 * inside the PRIMARY model's range. It resolves. It resolves to a real entity.
 * It is the wrong entity in the wrong model, and nothing downstream can tell
 * that answer from a correct one.
 *
 * That is why every assertion below goes through the REAL resolution helpers
 * rather than checking that the number grew. "Bigger than it was" is the one
 * property the defect also satisfies once you shift by anything at all; the
 * question that discriminates is which model the id lands in.
 *
 * **Why both paths are in one file.** They are two functions because a
 * `MeshData` and a `DecodedInstance` are different shapes, not because they
 * are two decisions. `Scene.getInstancedMeshDataPieces` materializes an
 * instanced occurrence into a `MeshData` and stamps its `itemId` onto
 * `geometryItemId`, so if only one side shifts, the instanced path feeds the
 * flat field a local number and the mixed-space bug comes back through the
 * other door. The final test here asserts the two agree on identical input.
 *
 * **What is real and what is seeded.** The two functions under test are the
 * production ones, imported from the modules that call them — the loader's
 * federated finalize (`useIfcLoader.ts`) and the instanced-shard drain
 * (`useGeometryStreaming.ts`) each call exactly one of them and nothing else
 * shifts these ids. That those call sites are wired is pinned end-to-end
 * elsewhere, on `expressId`, by tests that drive the real code paths:
 * `useIfcLoader.federatedIdOffset.test.tsx` runs a real federated `loadFile`
 * and `useGeometryStreaming.instancedShards.test.tsx` mounts the real hook
 * with real IFNS bytes. Neither can be extended to cover `geometryItemId`:
 * the only federated formats that load without the WASM engine (GLB, IFCX)
 * do not produce a source item id at all, and hand-building item-id-carrying
 * IFNS bytes would pin a wire format rather than this behaviour. Seeded here
 * is the federation registry state, through its real store action
 * `registerModelOffset`, exactly as a real primary load's finalize does it.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData, DecodedInstance } from '@ifc-lite/geometry';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { applyFederationOffsetToMesh } from './useIfcLoader.js';
import { applyFederationOffsetToShard } from '../components/viewer/useGeometryStreaming.js';

// ─── The two-model federation this file is about ───────────────────────────
//
// The primary is deliberately given a WIDE range so the secondary's offset is
// large: a raw local item id from the secondary is then a small number that
// lands inside the primary's range rather than in the gap between models. A
// narrow primary would let an unshifted id resolve to `null`, which is a MISS
// — visible, and not the failure mode this file exists for.

const PRIMARY_MAX_EXPRESS_ID = 999_999;
const SECONDARY_MAX_EXPRESS_ID = 5_000;
/** Small enough to sit inside the primary's range when left unshifted. */
const LOCAL_ITEM_ID = 4_638;
const LOCAL_EXPRESS_ID = 4_600;

let secondaryOffset = 0;

beforeEach(() => {
  const store = useViewerStore.getState();
  store.resetViewerState();
  store.clearAllModels(); // also clears the federation registry

  const primaryOffset = store.registerModelOffset('primary', PRIMARY_MAX_EXPRESS_ID);
  assert.equal(primaryOffset, 0, 'sanity: the primary must be the FIRST registration');
  secondaryOffset = store.registerModelOffset('secondary', SECONDARY_MAX_EXPRESS_ID);
  assert.equal(
    secondaryOffset,
    // +1 gap, plus FederationRegistry's OVERLAY_ID_HEADROOM (1_000_000)
    // reserved after every model's own range.
    PRIMARY_MAX_EXPRESS_ID + 1 + 1_000_000,
    'sanity: the secondary must start after the primary\'s range — if this changes, the '
    + '"unshifted id lands in the primary" premise below is no longer set up',
  );

  // The same two models in the store, so the store-backed resolver
  // (`resolveGlobalIdFromModels`, the canonical one per AGENTS.md) can be
  // asked the same question as the registry.
  const models: FederatedModel[] = [
    { ...fixtureModel('primary', { idOffset: 0 }), maxExpressId: PRIMARY_MAX_EXPRESS_ID },
    { ...fixtureModel('secondary', { idOffset: secondaryOffset }), maxExpressId: SECONDARY_MAX_EXPRESS_ID },
  ];
  for (const model of models) useViewerStore.getState().addModel(model);
});

function mesh(overrides: Partial<MeshData>): MeshData {
  return {
    expressId: LOCAL_EXPRESS_ID,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    ...overrides,
  };
}

/** Only the field `applyFederationOffsetToShard` takes: the occurrence list.
 *  Deliberately not a whole `DecodedInstancedShard` — the shard header is
 *  wire-format surface, and a fixture that has to keep up with it would make
 *  this file fail for reasons unrelated to what it pins. */
function shard(overrides: Partial<DecodedInstance>): { instances: DecodedInstance[] } {
  return {
    instances: [
      {
        templateIndex: 0,
        entityId: LOCAL_EXPRESS_ID,
        color: [1, 1, 1, 1],
        transform: new Float32Array(16),
        ...overrides,
      },
    ],
  };
}

/** `fromGlobalId` through the store, i.e. the registry-backed resolver. */
function resolve(globalId: number) {
  return useViewerStore.getState().fromGlobalId(globalId);
}

describe('federation id-offset — the source item id is re-homed with the express id beside it (#2985)', () => {
  it('the premise: an UNSHIFTED item id resolves to a real entity in the WRONG model', () => {
    // Not a property of the fix — a property of the id space, asserted so the
    // tests below are known to be discriminating rather than vacuous. If this
    // ever fails, an unshifted id has started resolving to null and the
    // "plausible wrong answer" this file guards against no longer exists in
    // the form described.
    assert.equal(
      useViewerStore.getState().findModelForGlobalId(LOCAL_ITEM_ID),
      'primary',
      'the raw local item id must fall inside the PRIMARY model\'s range',
    );
    assert.deepEqual(
      useViewerStore.getState().resolveGlobalIdFromModels(LOCAL_ITEM_ID),
      { modelId: 'primary', expressId: LOCAL_ITEM_ID },
      'the store-backed resolver must agree: an unshifted id is not a miss, it is a wrong hit',
    );
  });

  it('flat path: the shifted materialId resolves back to its OWN model, not the primary (#3525)', () => {
    // Same shape as geometryItemId, disjoint field (#3199): a material-layer
    // mesh carries `materialId` instead of `geometryItemId`, never both. If
    // this is left unshifted while `expressId` on the same mesh is global,
    // the mesh's material resolves to a REAL entity in the WRONG model.
    const m = mesh({ materialId: LOCAL_ITEM_ID });
    applyFederationOffsetToMesh(m, secondaryOffset);

    assert.deepEqual(
      resolve(m.materialId!),
      { modelId: 'secondary', expressId: LOCAL_ITEM_ID },
      'materialId must resolve to the secondary model and back to its original local id',
    );
    assert.equal(
      useViewerStore.getState().findModelForGlobalId(m.materialId!),
      'secondary',
      'a raw-local material id would answer "primary" here — that is the defect (#3525)',
    );
    assert.deepEqual(
      useViewerStore.getState().resolveGlobalIdFromModels(m.materialId!),
      { modelId: 'secondary', expressId: LOCAL_ITEM_ID },
      'the store-backed resolver (the canonical one) must agree with the registry',
    );
    assert.equal(
      resolve(m.expressId)?.modelId,
      resolve(m.materialId!)?.modelId,
      'expressId and materialId on one mesh must resolve to the same model',
    );
  });

  it('flat path: an absent materialId stays absent — not NaN, not the bare offset (#3525)', () => {
    const m = mesh({});
    assert.equal('materialId' in m, false, 'sanity: the fixture must not carry the field');

    applyFederationOffsetToMesh(m, secondaryOffset);

    const materialId: number | undefined = m.materialId;
    assert.equal('materialId' in m, false, 'the key must not be invented');
    assert.equal(materialId, undefined, 'an absent material id must stay absent');
    assert.notEqual(materialId, secondaryOffset, 'an absent material id must not become the bare offset');
  });

  it('a source materialId of 0 is shifted, not dropped by a truthiness guard (#3525)', () => {
    const m = mesh({ materialId: 0 });
    applyFederationOffsetToMesh(m, secondaryOffset);
    assert.equal(m.materialId, secondaryOffset, 'a 0 material id must still be shifted');
  });

  it('materialId and geometryItemId are never both offset into the SAME resolved model incorrectly — control: primary model stays untouched at zero offset (#3525)', () => {
    const m = mesh({ materialId: LOCAL_ITEM_ID });
    applyFederationOffsetToMesh(m, 0);
    assert.equal(m.materialId, LOCAL_ITEM_ID, 'a zero offset (primary model) must leave materialId untouched');
  });

  it('flat path: the shifted geometryItemId resolves back to its OWN model, not the primary', () => {
    const m = mesh({ geometryItemId: LOCAL_ITEM_ID });
    applyFederationOffsetToMesh(m, secondaryOffset);

    assert.deepEqual(
      resolve(m.geometryItemId!),
      { modelId: 'secondary', expressId: LOCAL_ITEM_ID },
      'geometryItemId must resolve to the secondary model and back to its original local id',
    );
    assert.equal(
      useViewerStore.getState().findModelForGlobalId(m.geometryItemId!),
      'secondary',
      'a raw-local item id would answer "primary" here — that is the defect',
    );
    assert.deepEqual(
      useViewerStore.getState().resolveGlobalIdFromModels(m.geometryItemId!),
      { modelId: 'secondary', expressId: LOCAL_ITEM_ID },
      'the store-backed resolver (the canonical one) must agree with the registry',
    );
    // The two ids on the SAME mesh must live in the same space. This is the
    // assertion the mixed-space bug fails: a global expressId beside a local
    // item id resolve to two different models.
    assert.equal(
      resolve(m.expressId)?.modelId,
      resolve(m.geometryItemId!)?.modelId,
      'expressId and geometryItemId on one mesh must resolve to the same model',
    );
  });

  it('instanced path: the shifted occurrence itemId resolves back to its OWN model', () => {
    const s = shard({ itemId: LOCAL_ITEM_ID });
    applyFederationOffsetToShard(s, secondaryOffset);
    const instance = s.instances[0]!;

    assert.deepEqual(
      resolve(instance.itemId!),
      { modelId: 'secondary', expressId: LOCAL_ITEM_ID },
      'the occurrence itemId must resolve to the secondary model and back to its local id',
    );
    assert.equal(
      useViewerStore.getState().findModelForGlobalId(instance.itemId!),
      'secondary',
    );
    assert.deepEqual(
      useViewerStore.getState().resolveGlobalIdFromModels(instance.itemId!),
      { modelId: 'secondary', expressId: LOCAL_ITEM_ID },
    );
    assert.equal(
      resolve(instance.entityId)?.modelId,
      resolve(instance.itemId!)?.modelId,
      'entityId and itemId on one occurrence must resolve to the same model',
    );
  });

  it('flat path: an absent geometryItemId stays absent — not NaN, not the bare offset', () => {
    const m = mesh({});
    assert.equal('geometryItemId' in m, false, 'sanity: the fixture must not carry the field');

    applyFederationOffsetToMesh(m, secondaryOffset);

    const itemId: number | undefined = m.geometryItemId;
    assert.equal('geometryItemId' in m, false, 'the key must not be invented');
    // Strict equality against `undefined` rules out BOTH naive shifts at once:
    // `undefined + offset` is NaN (which loses every comparison, so a consumer
    // range-checking it gets "no model" rather than an error), and
    // `(x ?? 0) + offset` is a number.
    assert.equal(itemId, undefined, 'an absent item id must stay absent');
    // Spelled out, because the bare offset is the valid-but-WRONG shape: it is
    // a number inside the secondary model's range, so it RESOLVES — to express
    // id 0, an entity that does not exist, reported as if it did.
    assert.notEqual(itemId, secondaryOffset, 'an absent item id must not become the bare offset');
    // Still true of the mesh's other ids, so the guard did not skip the mesh.
    assert.equal(m.expressId, LOCAL_EXPRESS_ID + secondaryOffset);
  });

  it('instanced path: an absent itemId stays absent — not NaN, not the bare offset', () => {
    const s = shard({});
    const instance = s.instances[0]!;
    assert.equal('itemId' in instance, false, 'sanity: the fixture must not carry the field');

    applyFederationOffsetToShard(s, secondaryOffset);

    const itemId: number | undefined = instance.itemId;
    assert.equal('itemId' in instance, false, 'the key must not be invented');
    assert.equal(itemId, undefined, 'an absent item id must stay absent — neither NaN nor a number');
    assert.notEqual(itemId, secondaryOffset, 'an absent item id must not become the bare offset');
    assert.equal(instance.entityId, LOCAL_EXPRESS_ID + secondaryOffset);
  });

  it('a source item id of 0 is shifted, not dropped by a truthiness guard', () => {
    // `#0` is not a STEP instance name, so this should not occur in practice —
    // but the guard that would drop it (`if (mesh.geometryItemId)`) is the
    // third naive spelling of this shift, and it fails silently by leaving a
    // LOCAL id behind, which is the exact defect. `serverMesh.test.ts` pins
    // the same 0-is-not-absent rule one layer up.
    const m = mesh({ geometryItemId: 0 });
    applyFederationOffsetToMesh(m, secondaryOffset);
    assert.equal(m.geometryItemId, secondaryOffset, 'a 0 item id must still be shifted');

    const s = shard({ itemId: 0 });
    applyFederationOffsetToShard(s, secondaryOffset);
    assert.equal(s.instances[0]!.itemId, secondaryOffset, 'a 0 occurrence item id must still be shifted');
  });

  it('the flat and instanced paths agree on identical input', () => {
    // The anti-drift assertion: `getInstancedMeshDataPieces` stamps an
    // occurrence's `itemId` onto a materialized mesh's `geometryItemId`, so
    // the two fields are the same id in two carriers and must be shifted the
    // same way. Comparing the RESOLVED (model, expressId) rather than the raw
    // numbers keeps this honest if the id space itself is ever reshaped.
    const m = mesh({ expressId: LOCAL_EXPRESS_ID, geometryItemId: LOCAL_ITEM_ID });
    const s = shard({ entityId: LOCAL_EXPRESS_ID, itemId: LOCAL_ITEM_ID });

    applyFederationOffsetToMesh(m, secondaryOffset);
    applyFederationOffsetToShard(s, secondaryOffset);
    const instance = s.instances[0]!;

    assert.equal(m.expressId, instance.entityId, 'the element id must shift identically on both paths');
    assert.equal(m.geometryItemId, instance.itemId, 'the item id must shift identically on both paths');
    assert.deepEqual(resolve(m.geometryItemId!), resolve(instance.itemId!));
  });

  it('a zero offset (the primary model) leaves every id untouched', () => {
    const m = mesh({ geometryItemId: LOCAL_ITEM_ID });
    applyFederationOffsetToMesh(m, 0);
    assert.equal(m.expressId, LOCAL_EXPRESS_ID);
    assert.equal(m.geometryItemId, LOCAL_ITEM_ID);

    const s = shard({ itemId: LOCAL_ITEM_ID });
    applyFederationOffsetToShard(s, 0);
    assert.equal(s.instances[0]!.entityId, LOCAL_EXPRESS_ID);
    assert.equal(s.instances[0]!.itemId, LOCAL_ITEM_ID);
  });
});
