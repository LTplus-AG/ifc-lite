/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Canonical native selection/summary lifetime retained from MeasureQuantities (#7184).
import { useMemo } from 'react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { stringToEntityRef, type EntityRef } from '@/store/types';
import { toGlobalIdFromModels } from '@/store/globalId';
import { extractMaterialPropertiesOnDemand, extractProjectUnits, ProjectUnits, type IfcDataStore, type extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { geometryVolumesSurviveAlignment } from '@/lib/compare/alignmentTrust';
import { pickElementQuantities, rollupQuantities, rollupGeometryVolumes, rollupMeshArea, MEASURABLE_QUANTITY_TYPES, type PickedQuantity } from './quantities';
import { collectMeshAreas } from './mesh-area';
import { pickIfcDensity, resolveElementWeight, rollupWeights, classifyWeightUnitKind, type WeightOutcome } from './weight';
import { siConverterFor, densitySiConverterFor, quantitySetsFor } from './quantity-source';

export function useSelectionQuantitySummary() {
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const selectedEntitiesSet = useViewerStore((s) => s.selectedEntitiesSet);
  const { models, ifcDataStore, geometryResult, activeModelId } = useIfc();

  /** The selection, as model-aware refs. Multi-selection first, primary as fallback. */
  const refs: EntityRef[] = useMemo(() => {
    if (selectedEntitiesSet.size > 0) {
      return [...selectedEntitiesSet].map(stringToEntityRef);
    }
    return selectedEntity ? [selectedEntity] : [];
  }, [selectedEntitiesSet, selectedEntity]);

  // Mesh-derived surface area (issue #2199, "mesh analysis reachable from
  // TypeScript"): summed live from each submesh's `positions`/`indices`
  // (`measure-modes/mesh-area.ts`'s `collectMeshAreas`), unlike
  // `geometryVolume` which is a scalar the wasm hashing pass computed once.
  // Because it re-reads `positions` every time, it is NOT invalidated by
  // federation re-baking the way `geometryVolume` is — a
  // `'same-crs'`/`'reprojected'` alignment mutates `positions` in place
  // (`geometryVolumesSurviveAlignment`'s own contract), so summing
  // triangles from the CURRENT positions already reflects the geometry on
  // screen. `rescaledModelIds` therefore does not gate this collection —
  // and neither, by construction, does `store`: `collectMeshAreas` takes
  // mesh data alone, so there is no `store`-shaped parameter for a future
  // early return to gate it on (see the resolution below, and the
  // adversarial review of 85ebf7d1's confirmed defect: the lookup used to
  // sit after `if (!store) continue` and silently drop an already-computed
  // area for any ref whose model lacked an `IfcDataStore`).
  //
  // Its OWN memo, keyed on the mesh data alone: per-entity total mesh area
  // is selection-independent (it iterates every loaded model's triangles,
  // never `refs`), so recomputing it inside the selection-keyed `summary`
  // memo below would re-sum the whole federation's triangles on the main
  // thread on every selection click.
  const meshAreaByGlobalId = useMemo(
    () => collectMeshAreas(
      models.size > 0
        ? [...models.values()].map((m) => m.geometryResult?.meshes)
        : [geometryResult?.meshes],
    ),
    [models, geometryResult],
  );

  const summary = useMemo(() => {
    if (refs.length === 0) return null;

    // One entry per element. `MeshData.geometryVolume` is a WHOLE-ENTITY value
    // repeated on every submesh, so it is looked up per element rather than
    // accumulated per mesh — summing submeshes would multiply an element's
    // volume by its part count. `instancedGeometryVolumes` holds the same
    // whole-entity value for entities the pipeline kept ONLY as GPU instances
    // (no flat mesh exists to carry it), already keyed by global id.
    const volumeByGlobalId = new Map<number, number>();
    const collectVolumes = (
      meshes: ReadonlyArray<{ expressId: number; geometryVolume?: number }> | undefined,
      instanced?: ReadonlyMap<number, number>,
    ) => {
      if (meshes) {
        for (const mesh of meshes) {
          if (mesh.geometryVolume === undefined) continue;
          if (!volumeByGlobalId.has(mesh.expressId)) {
            volumeByGlobalId.set(mesh.expressId, mesh.geometryVolume);
          }
        }
      }
      if (instanced) {
        for (const [id, volume] of instanced) {
          if (!volumeByGlobalId.has(id)) volumeByGlobalId.set(id, volume);
        }
      }
    };
    // Models whose vertices federation alignment re-baked. Their volumes are
    // not merely suspect, they describe a different size — so no total ever
    // includes them, and the gate is at every READ site below rather than at
    // collection: the derived-mass path (#2736) has to be able to tell "this
    // element's volume was invalidated" from "the kernel proved no volume for
    // this element", and it can only do that if the invalidated volume is
    // still visible to say so about. Nothing downstream may read this map
    // without first consulting `rescaledModelIds`.
    const rescaledModelIds = new Set<string>();
    if (models.size > 0) {
      for (const [id, m] of models) {
        if (!geometryVolumesSurviveAlignment(m.federationAlignmentStatus)) {
          rescaledModelIds.add(id);
        }
        collectVolumes(m.geometryResult?.meshes, m.geometryResult?.instancedGeometryVolumes);
      }
    } else {
      collectVolumes(geometryResult?.meshes, geometryResult?.instancedGeometryVolumes);
    }

    // Resolved directly from `refs`, BEFORE the store-dependent loop below —
    // not inside it — so no store-related branch in that loop can ever skip
    // it again. `meshAreaByGlobalId` needs no store to build or to read.
    let meshAreaIncomplete = 0;
    const meshAreas: Array<number | undefined> = refs.map((ref) => {
      const entry = meshAreaByGlobalId.get(toGlobalIdFromModels(models, ref.modelId, ref.expressId));
      if (!entry) return undefined;
      if (entry.incomplete) meshAreaIncomplete += 1;
      return entry.area;
    });

    const unitsCache = new Map<string, ProjectUnits>();
    // Per model, not per element: resolving MASSDENSITYUNIT walks the unit
    // assignment, and a 5000-element selection would otherwise redo it 5000
    // times for the one answer its model can give.
    const densityConverters = new Map<string, (value: number) => number>();
    const typeCaches = new Map<string, Map<number, ReturnType<typeof extractQuantitiesOnDemand>>>();
    const perElement: PickedQuantity[][] = [];
    const geometryVolumes: Array<number | undefined> = [];
    const weightOutcomes: WeightOutcome[] = [];
    let withoutStore = 0;
    let rescaled = 0;

    for (const ref of refs) {
      // A federated ref resolves ONLY through its own model. Falling back to
      // the legacy store for an id that is not in `models` would read some
      // other file's quantities for that express id and present them as this
      // element's — a wrong answer where `withoutStore` should have said "could
      // not be resolved". The legacy store answers for the legacy ref, and for
      // the single-model case where `models` is empty.
      const federated = ref.modelId !== 'legacy' ? models.get(ref.modelId) : undefined;
      const store = ref.modelId === 'legacy' || models.size === 0
        ? ((ifcDataStore as IfcDataStore | null) ?? undefined)
        : (federated?.ifcDataStore as IfcDataStore | undefined);
      if (!store) {
        withoutStore += 1;
        continue;
      }

      let units = unitsCache.get(ref.modelId);
      if (!units) {
        units = store.source?.length && store.entityIndex
          ? extractProjectUnits(store.source, store.entityIndex)
          : ProjectUnits.empty();
        unitsCache.set(ref.modelId, units);
      }
      let densityToSi = densityConverters.get(ref.modelId);
      if (!densityToSi) {
        densityToSi = densitySiConverterFor(units);
        densityConverters.set(ref.modelId, densityToSi);
      }
      let typeCache = typeCaches.get(ref.modelId);
      if (!typeCache) {
        typeCache = new Map();
        typeCaches.set(ref.modelId, typeCache);
      }

      const picked = pickElementQuantities(
        quantitySetsFor(store, ref.expressId, typeCache),
        siConverterFor(units),
      );
      perElement.push(picked);

      const volumeTrusted = !rescaledModelIds.has(ref.modelId);
      const volume = volumeByGlobalId.get(
        toGlobalIdFromModels(models, ref.modelId, ref.expressId),
      );

      // A re-baked model contributes no volume AND is not counted as unproved:
      // the kernel proved one, alignment invalidated it, and the note below
      // says exactly that.
      if (volumeTrusted) {
        geometryVolumes.push(volume);
      } else {
        rescaled += 1;
      }

      // Weight, with its provenance (#2736). The file's own `Qto` weight is
      // taken FIRST and, when present, is the whole answer — `pickElementQuantities`
      // already returns it net-before-gross-before-unqualified, so `find` takes
      // the most representative one. Only when there is none does the density
      // lookup run at all, which is both the correct precedence (never derive
      // over what the file declared) and the reason a large selection of
      // properly-quantified elements pays nothing for this feature.
      const declaredWeight = picked.find(
        (q) => q.quantityType === MEASURABLE_QUANTITY_TYPES.Weight,
      );
      // Exactly the complement of `resolveElementWeight`'s `no-volume` and
      // `volume-untrusted` guards — `Number.isFinite(undefined)` is `false`,
      // so this is one expression for both.
      const densityCouldMatter = volumeTrusted && Number.isFinite(volume);
      weightOutcomes.push(
        resolveElementWeight(
          declaredWeight
            ? {
                declared: { value: declaredWeight.value, provenance: declaredWeight.provenance },
                volumeTrusted,
              }
            : {
                volume,
                volumeTrusted,
                unitKind: classifyWeightUnitKind(units.resolvedForUnitType('MASSUNIT')?.symbol),
                // Only the file's own density is wired today; there is no
                // project density library to fall back to (see the module's
                // `derived-library-density`, which no call site can reach yet).
                //
                // Gated on the SAME condition as `extractProjectUnits` above,
                // and for the same reason: material properties live in
                // `IfcMaterialProperties` entities that are only reachable by
                // reading attributes out of the STEP source through
                // `entityIndex`. A server-parsed store has neither — its
                // prebuilt tables carry properties and quantities, not
                // material psets — so there is genuinely no density to read,
                // and asking anyway walks an index that is not there.
                //
                // Gated a SECOND time on the volume, because
                // `extractMaterialPropertiesOnDemand` re-parses the source
                // buffer per element and `resolveElementWeight` returns
                // `no-volume` / `volume-untrusted` BEFORE it ever reads a
                // density. Without this the panel paid that per-element parse
                // for every element it was already going to withhold — the one
                // place the per-model caching above was not applied. It is a
                // cost guard only: it mirrors the resolver's two volume
                // refusals, so every element it skips is one whose outcome the
                // density could not have changed.
                density: densityCouldMatter && store.source?.length && store.entityIndex
                  ? pickIfcDensity(
                      extractMaterialPropertiesOnDemand(store, ref.expressId),
                      densityToSi,
                    )
                  : undefined,
              },
        ),
      );
    }

    return {
      declared: rollupQuantities(perElement),
      geometry: rollupGeometryVolumes(geometryVolumes),
      meshArea: rollupMeshArea(meshAreas),
      weights: rollupWeights(weightOutcomes),
      meshAreaIncomplete,
      elements: refs.length,
      withoutStore,
      rescaled,
    };
  }, [refs, models, ifcDataStore, geometryResult, meshAreaByGlobalId]);

  return { summary, refs, models, activeModelId };
}
