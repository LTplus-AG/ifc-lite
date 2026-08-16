/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Area / volume / weight / length for the current selection — issue #2199
 * §1 (element surface area), §2 (volume) and §6 (weight).
 *
 * This measures what the MODEL says, not what the pixels say, and it is
 * explicit about which. Two independent sources are shown side by side and
 * never blended:
 *
 * - **Declared** — the file's own `IfcElementQuantity`, occurrence first with
 *   the element's type as fallback (the #1745/#1755 rule, matching the Lists
 *   engine and the material totals panel). Gross and net stay apart, which is
 *   how §1's "indicate whether opening areas are included or excluded" is
 *   answered: IFC already encodes it in the naming, so the tool surfaces the
 *   distinction rather than inventing one.
 * - **Geometry** — `MeshData.geometryVolume`, the kernel's enclosed volume,
 *   present only where a single closed orientable solid could be PROVED. The
 *   count of elements where it could not is reported rather than hidden, which
 *   is §2's "report that the volume cannot be calculated reliably instead of
 *   returning an incorrect result". Two things follow from that field's own
 *   contract and are handled here rather than assumed away:
 *   - A GPU-instanced-only element has NO flat mesh at all; the geometry pass
 *     parks its proved volume in `GeometryResult.instancedGeometryVolumes`
 *     instead. Reading only `meshes` would report an entire precast field as
 *     unprovable while the answer sat in the side channel.
 *   - A federated model that alignment RE-BAKED (`'same-crs'` / `'reprojected'`)
 *     carries volumes measured at a size that is no longer on screen, and
 *     nothing on this side can re-measure them (#1993). Those are withheld and
 *     COUNTED SEPARATELY — "we scaled it away" is a different statement from
 *     "the kernel could not prove it", and collapsing the two would be the
 *     silent blend this whole panel exists to avoid.
 * - **Area mesh** — the triangulated mesh's total surface area, summed live
 *   from each submesh's `positions`/`indices` (`measure-modes/mesh-area.ts`,
 *   using `triangleArea` newly re-exported from `@ifc-lite/clash`'s public
 *   surface — the "mesh analysis reachable from TypeScript" prerequisite
 *   #2199 names). Unlike `geometryVolume` this needs no closed-solid proof, so
 *   it covers open shells and layered walls too; and because it re-reads
 *   `positions` on every call rather than trusting a value cached before
 *   alignment, it is NOT invalidated by federation re-baking. It is the sum of
 *   EVERY meshed face, not one side, so it is never comparable to a
 *   `NetSideArea`/`GrossSideArea` and is labelled its own "mesh" row.
 *   GPU-instanced-only elements have no flat mesh to sum and are reported as
 *   "no mesh" here too — there is no per-entity area side channel analogous
 *   to `instancedGeometryVolumes`. A mesh record that IS present but never
 *   triangulated anything (`indices.length < 3`, including the empty-array
 *   case) is likewise "no mesh", not "measured 0 m²" — those are different
 *   claims, and only the second one is true of a record with no triangles to
 *   have summed (`measure-modes/mesh-area.ts`'s `collectMeshAreas`). A mesh
 *   whose triangles genuinely sum to zero (e.g. every triangle degenerate)
 *   IS "measured" — that zero is a real answer, not an absence.
 *   Mesh area needs no `IfcDataStore`, so its collection never depends on
 *   one: `collectMeshAreas` takes mesh data alone (see its own doc comment)
 *   specifically so a future store-related early return elsewhere in this
 *   component cannot end up gating it, structurally rather than by
 *   convention.
 *
 * Values are normalised to SI at read time, while each value is still next to
 * the `ProjectUnits` that explain it, because a federation can mix a
 * millimetre model with a metre one. Display then converts once, honouring the
 * user's per-unit-type override from #1573.
 */

import { useMemo } from 'react';
import { Boxes, TriangleAlert } from 'lucide-react';
import { useViewerStore } from '@/store';
import { useIfc } from '@/hooks/useIfc';
import { stringToEntityRef, type EntityRef } from '@/store/types';
import { toGlobalIdFromModels } from '@/store/globalId';
import {
  extractQuantitiesOnDemand,
  extractTypeQuantitiesOnDemand,
  extractProjectUnits,
  ProjectUnits,
  type IfcDataStore,
} from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';
import { geometryVolumesSurviveAlignment } from '@/lib/compare/alignmentTrust';
import {
  QUANTITY_TYPE_UNIT,
  resolveQuantityDisplay,
  formatConverted,
} from '@/lib/units/display';
import { resolveFromUnit, convertValue } from '@/lib/units/convert';
import {
  pickElementQuantities,
  rollupQuantities,
  rollupGeometryVolumes,
  rollupMeshArea,
  type PickedQuantity,
  type QuantityBasis,
} from './measure-modes/quantities';
import { collectMeshAreas } from './measure-modes/mesh-area';

const QUANTITY_TYPE_LABEL: Record<number, string> = {
  0: 'Length',
  1: 'Area',
  2: 'Volume',
  4: 'Weight',
};

const BASIS_LABEL: Record<QuantityBasis, string> = {
  net: 'net',
  gross: 'gross',
  unqualified: '',
};

/**
 * Build the file-unit -> SI converter for one store's declared units.
 *
 * Goes through `convertValue` rather than multiplying by `siScale` directly so
 * an affine unit would carry its offset. None of the four families here is
 * affine today, which is exactly why doing it by hand would look correct
 * forever and then not be.
 */
function siConverterFor(units: ProjectUnits) {
  return (value: number, quantityType: number): number => {
    const entry = QUANTITY_TYPE_UNIT[quantityType];
    if (!entry) return value;
    const fileUnit = units.resolvedForUnitType(entry.unitType)
      ?? { symbol: entry.defaultSymbol, siScale: 1.0 };
    return convertValue(value, resolveFromUnit(entry.unitType, fileUnit), { scale: 1 });
  };
}

/**
 * Occurrence quantities win, with the element's type as fallback (#1755).
 *
 * "Win" requires at least one ACTUAL quantity: a named-but-empty occurrence
 * quantity set must not mask populated type-level ones. Type extraction is
 * cached per type, so a 500-door type is parsed once rather than 500 times.
 *
 * Both parse paths are served, mirroring the Lists adapter's split (#1751):
 * `extractTypeQuantitiesOnDemand` walks the STEP source and returns `null`
 * outright when there is none, which is every server-parsed store — those
 * carry the type's own quantity sets in the prebuilt table instead, keyed by
 * the TYPE's express id. Taking only the source-backed branch would drop
 * type-declared volumes on the server path while the occurrence branch (whose
 * extractor already falls back to that same table) kept working, so the loss
 * would look like a file that simply declares nothing.
 */
function quantitySetsFor(
  store: IfcDataStore,
  expressId: number,
  typeCache: Map<number, ReturnType<typeof extractQuantitiesOnDemand>>,
) {
  const typeQsets = () => {
    if (!store.relationships) return [];
    const typeIds = store.relationships.getRelated(expressId, RelationshipType.DefinesByType, 'inverse');
    if (typeIds.length === 0) return [];
    const typeId = typeIds[0];
    let cached = typeCache.get(typeId);
    if (!cached) {
      cached = store.source?.length
        ? (extractTypeQuantitiesOnDemand(store, expressId)?.quantities ?? [])
        : (store.quantities?.getForEntity(typeId) ?? []);
      typeCache.set(typeId, cached);
    }
    return cached;
  };

  const own = extractQuantitiesOnDemand(store, expressId);
  return own.some((qset) => qset.quantities.length > 0) ? own : typeQsets();
}

export function MeasureQuantities() {
  const selectedEntity = useViewerStore((s) => s.selectedEntity);
  const selectedEntitiesSet = useViewerStore((s) => s.selectedEntitiesSet);
  const unitDisplayOverrides = useViewerStore((s) => s.unitDisplayOverrides);
  const { models, ifcDataStore, geometryResult } = useIfc();

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
    // not merely suspect, they describe a different size — so they are never
    // read, rather than read and quietly compared.
    const rescaledModelIds = new Set<string>();
    if (models.size > 0) {
      for (const [id, m] of models) {
        if (!geometryVolumesSurviveAlignment(m.federationAlignmentStatus)) {
          rescaledModelIds.add(id);
          continue;
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
    const typeCaches = new Map<string, Map<number, ReturnType<typeof extractQuantitiesOnDemand>>>();
    const perElement: PickedQuantity[][] = [];
    const geometryVolumes: Array<number | undefined> = [];
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
      let typeCache = typeCaches.get(ref.modelId);
      if (!typeCache) {
        typeCache = new Map();
        typeCaches.set(ref.modelId, typeCache);
      }

      perElement.push(
        pickElementQuantities(
          quantitySetsFor(store, ref.expressId, typeCache),
          siConverterFor(units),
        ),
      );
      // A re-baked model contributes no volume AND is not counted as unproved:
      // the kernel proved one, alignment invalidated it, and the note below
      // says exactly that.
      if (rescaledModelIds.has(ref.modelId)) {
        rescaled += 1;
      } else {
        geometryVolumes.push(
          volumeByGlobalId.get(toGlobalIdFromModels(models, ref.modelId, ref.expressId)),
        );
      }
    }

    return {
      declared: rollupQuantities(perElement),
      geometry: rollupGeometryVolumes(geometryVolumes),
      meshArea: rollupMeshArea(meshAreas),
      meshAreaIncomplete,
      elements: refs.length,
      withoutStore,
      rescaled,
    };
  }, [refs, models, ifcDataStore, geometryResult, meshAreaByGlobalId]);

  // Totals are already SI, so display resolves against an EMPTY unit context —
  // handing it the file's declared millimetres would scale a metre total again.
  const render = (value: number, quantityType: number): string => {
    const disp = resolveQuantityDisplay(value, quantityType, ProjectUnits.empty(), unitDisplayOverrides);
    const formatted = disp.converted !== null
      ? formatConverted(disp.converted)
      : value.toLocaleString(undefined, { maximumFractionDigits: 3 });
    return disp.unit ? `${formatted} ${disp.unit}` : formatted;
  };

  if (!summary) {
    return (
      <div className="border-t px-2 py-2 text-center text-[10px] text-muted-foreground">
        Select elements to read their quantities
      </div>
    );
  }

  const { declared, geometry, meshArea, meshAreaIncomplete, elements, withoutStore, rescaled } = summary;
  const nothing = declared.length === 0 && geometry.proved === 0 && meshArea.withMesh === 0;

  return (
    <div className="border-t px-2 py-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-primary">
          <Boxes className="h-3 w-3" />
          Quantities
        </span>
        <span className="font-mono text-[9px] text-muted-foreground">
          {elements} element{elements === 1 ? '' : 's'}
        </span>
      </div>

      {nothing ? (
        <div className="flex items-start gap-1.5 text-[10px] leading-tight text-muted-foreground">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />
          <span>
            The selection declares no quantities, no enclosed volume could be
            proved from its geometry, and no triangulated mesh area could be
            measured either.
          </span>
        </div>
      ) : (
        <div className="space-y-0.5 overflow-x-auto">
          {declared.map((r) => (
            <div
              key={`${r.quantityType}-${r.basis}`}
              className="flex items-baseline gap-2 whitespace-nowrap"
              title={r.provenance.join('\n')}
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
                {QUANTITY_TYPE_LABEL[r.quantityType] ?? r.quantityType} {BASIS_LABEL[r.basis]}
              </span>
              <span className="font-mono text-[11px] tabular-nums">{render(r.total, r.quantityType)}</span>
              {r.contributing < elements && (
                <span className="font-mono text-[9px] text-amber-600 dark:text-amber-500">
                  {r.contributing}/{elements}
                </span>
              )}
            </div>
          ))}

          {geometry.proved > 0 && (
            <div
              className="flex items-baseline gap-2 whitespace-nowrap"
              title="Enclosed volume computed from the meshed geometry, after opening cuts. Not an IFC GrossVolume."
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
                Volume mesh
              </span>
              <span className="font-mono text-[11px] tabular-nums">{render(geometry.total, 2)}</span>
              {geometry.unproved > 0 && (
                <span className="font-mono text-[9px] text-amber-600 dark:text-amber-500">
                  {geometry.proved}/{elements}
                </span>
              )}
            </div>
          )}

          {meshArea.withMesh > 0 && (
            <div
              className="flex items-baseline gap-2 whitespace-nowrap"
              title="Total triangulated surface of the meshed geometry — every face, not one side. Not an IFC NetSideArea/GrossSideArea."
            >
              <span className="w-[5.5rem] shrink-0 font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70">
                Area mesh
              </span>
              <span className="font-mono text-[11px] tabular-nums">{render(meshArea.total, 1)}</span>
              {meshArea.withoutMesh > 0 && (
                <span className="font-mono text-[9px] text-amber-600 dark:text-amber-500">
                  {meshArea.withMesh}/{elements}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* The openings question, stated rather than assumed. This tool never
          decides whether an opening is subtracted — it reports which
          convention each number was authored under and keeps them apart.
          Zones v2 (#2508) faces the same question when apportioning a wall's
          volume; stating it here is what lets the two features be compared
          instead of quietly differing. */}
      {!nothing && (
        <div className="font-mono text-[9px] leading-tight text-muted-foreground/70">
          net = openings excluded · gross = openings included · mesh = as built,
          after opening cuts (volume) or total triangulated surface (area)
        </div>
      )}

      {geometry.unproved > 0 && (
        <div className="font-mono text-[9px] leading-tight text-muted-foreground/70">
          {geometry.unproved} element{geometry.unproved === 1 ? '' : 's'} had no
          provable enclosed volume (open shell, layered or multi-part geometry).
        </div>
      )}
      {meshArea.withoutMesh > 0 && (
        <div className="font-mono text-[9px] leading-tight text-muted-foreground/70">
          {meshArea.withoutMesh} element{meshArea.withoutMesh === 1 ? '' : 's'} had
          no triangulated mesh to measure (e.g. instanced-only geometry).
        </div>
      )}
      {meshAreaIncomplete > 0 && (
        <div className="flex items-start gap-1.5 font-mono text-[9px] leading-tight text-amber-600 dark:text-amber-500">
          <TriangleAlert className="mt-0.5 h-2.5 w-2.5 shrink-0" />
          <span>
            {meshAreaIncomplete} element{meshAreaIncomplete === 1 ? '' : 's'} included in
            the mesh area total {meshAreaIncomplete === 1 ? 'has' : 'have'} a submesh with
            invalid vertex data; {meshAreaIncomplete === 1 ? 'its' : 'their'} contribution
            is a partial sum, not a complete measurement.
          </span>
        </div>
      )}
      {rescaled > 0 && (
        <div className="font-mono text-[9px] leading-tight text-muted-foreground/70">
          {rescaled} element{rescaled === 1 ? '' : 's'} sit{rescaled === 1 ? 's' : ''} in
          a model federation alignment rescaled; {rescaled === 1 ? 'its' : 'their'} proved
          volume no longer describes the geometry on screen and is withheld.
        </div>
      )}
      {withoutStore > 0 && (
        <div className="font-mono text-[9px] leading-tight text-muted-foreground/70">
          {withoutStore} selected element{withoutStore === 1 ? '' : 's'} could not
          be resolved to a loaded model.
        </div>
      )}
    </div>
  );
}
