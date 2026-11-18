/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useViewerStore } from '@/store';
import { elementsFromStep } from '@ifc-lite/clash/step';
import type { ClashElement, ExclusionSet } from '@ifc-lite/clash';
import { withInstancedMeshes } from '@/utils/instancedExport';
import { recordGatheredModel } from '@/lib/federation/federation-identity';
import { rememberPlacementSnapshot } from '@/lib/model-placement/placement-snapshot';
import type { ClashFederationIdentity } from './federation-identity';

/** Canonical live geometry collection shared by panel orchestration and agent analysis. */
export function gatherClashElements(modelIds?: ReadonlySet<string>): {
  elements: ClashElement[]; exclusions: ExclusionSet; federationIdentity: ClashFederationIdentity;
} {
    const state = useViewerStore.getState();
    const elements: ClashElement[] = [];
    const exclusions: ExclusionSet = new Set<string>();
    const federationIdentity = new Map<string, unknown>();
    const federation = { toGlobalId: (modelId: string, expressId: number) => state.toGlobalId(modelId, expressId) };

    for (const [modelId, model] of state.models) {
      if (modelIds && !modelIds.has(modelId)) continue;
      const store = model.ifcDataStore;
      const geometryResult = model.geometryResult;
      if (!store || !geometryResult) continue;
      // Every entity whose geometry went fully GPU-instanced (8+ repeats,
      // `INSTANCE_MIN_OCCURRENCES` in the wasm mesher) is ABSENT from
      // `geometryResult.meshes` — doors, windows, columns, sprinklers, the
      // exact repeated components a clash run exists to catch (#2865).
      // `withInstancedMeshes` is the SAME helper the glTF/IFC5 export path
      // (#2558/#2576) uses to restore them: it materializes every occurrence
      // from the live renderer scene's GPU instance buffers
      // (`Scene.getAllInstancedMeshData`) and appends real triangles, not an
      // approximation — no separate AABB-only code path, so a clash reported
      // off an instanced entity is exactly as exact as one reported off a flat
      // one. GPU instancing stopped being primary-only on 2026-08-06 (#2255) —
      // federated models get instanced shards too, re-homed onto their own
      // global id space at drain — so every model in this loop can have
      // instanced entities, not just the one at idOffset 0 (#2865/#2878
      // follow-up). `{ idOffset, maxExpressId }` scopes the (unfiltered,
      // all-models) scene data down to THIS model's global-id bracket, so a
      // federation of N models does not count each instanced entity N times
      // over as this loop visits every model. Returns the SAME object back
      // when there is nothing to add (no renderer mounted, or nothing
      // instanced for this model), so this is a no-op for every case this bug
      // did not touch.
      const meshes = withInstancedMeshes(geometryResult, {
        modelId: model.id, idOffset: model.idOffset ?? 0,
        maxExpressId: model.maxExpressId ?? 0,
      }).meshes;
      if (meshes.length === 0) continue;
      // `useIfcLoader` shifts every `mesh.expressId` into the GLOBAL id space by
      // this model's `idOffset` while `ifcDataStore` stays LOCAL, so the adapter
      // has to be told the offset or it addresses the store with ids that are
      // not in it.
      //
      // `model.idOffset` is the right number to hand over, and it agrees with
      // `federation.toGlobalId` (which resolves through the `federationRegistry`
      // singleton, not through this map) because both come from the SAME
      // `registerModelOffset` call: `useIfcLoader` stores that return value as
      // `idOffset` on the model record at the same moment it shifts the meshes
      // by it. A PRIMARY load cannot skew them either — it runs
      // `clearAllModels()` first, which calls `federationRegistry.clear()`, so
      // the primary always registers at offset 0 and its meshes are left
      // unshifted. Federated IFCX layers (`useIfcFederation`) likewise keep
      // `idOffset: 0` and unshifted meshes.
      //
      // Only the secondary (federated add) path assigns a non-zero offset, and
      // it is the one path that shifts the meshes.
      const built = elementsFromStep({
        store,
        meshes,
        modelId,
        federation,
        meshIdOffset: model.idOffset ?? 0,
      });
      for (const element of built.elements) elements.push(element); // #6575: avoid JS argument limits.
      for (const key of built.exclusions) exclusions.add(key);
      // Only models that actually CONTRIBUTED elements — the condition the
      // module doc's correctness argument is stated on, so it is checked here
      // rather than assumed. Having a store and meshes is not the same thing:
      // `elementsFromStep` can build nothing from them (every mesh filtered
      // out), and such a model can hold no row, so recording it would let its
      // removal discard a result it contributed nothing to.
      if (built.elements.length === 0) continue;
      recordGatheredModel(federationIdentity, modelId, model);
    }
    rememberPlacementSnapshot(federationIdentity, state, federationIdentity.keys());
    return { elements, exclusions, federationIdentity };
}
