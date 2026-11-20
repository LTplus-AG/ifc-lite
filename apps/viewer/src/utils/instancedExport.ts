/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-instanced occurrences are rendered from compact shards and are deliberately
 * absent from `geometryResult.meshes` (the flat consumer set), so one-shot
 * full-geometry exporters (glTF / IFC5) would otherwise drop them. This helper
 * materializes the instanced occurrences from the live renderer scene and appends
 * them to a copy of the geometryResult at export time only (transient — not retained).
 *
 * Instancing used to apply to the PRIMARY model only (shard entity ids lived in the
 * primary model's id space, idOffset 0) — true when this helper was written (#1238,
 * 2026-06-21), which is why it used to take a bare `isPrimary` boolean and no-op for
 * every federated model.
 *
 * That stopped being true on 2026-08-06 (#2255, "deliver GPU instancing to federated
 * models"): `useIfcLoader` now enables instancing for every load, primary and
 * federated, and `useGeometryStreaming` re-homes a federated shard's occurrence ids
 * onto that model's GLOBAL id space by `idOffset` before upload — the SAME shift
 * `finalizeModel` applies to that model's flat meshes. `Scene.getAllInstancedMeshData()`
 * already returns every loaded model's occurrences, unfiltered, already in the global
 * id space and the same world-space frame flat meshes use — so a federated model's
 * instanced entities are present and correctly keyed, they just never reached callers
 * that gated on `isPrimary` (#2865/#2878 follow-up).
 *
 * `getAllInstancedMeshData()` itself is not scoped to one model, though — a caller
 * building a SINGLE model's export (or a single model's clash element set) must not
 * splice in every OTHER loaded model's instanced occurrences too, or a federation of
 * N models would count each instanced entity N times over. `modelRange` is that scope:
 * pass this model's `{ idOffset, maxExpressId }` (both already on `FederatedModel`,
 * the same bracket `FederationRegistry.isInModel` uses) to restrict the appended set to
 * ids `idOffset+1 .. idOffset+maxExpressId`. Pass `null` only when the caller's
 * `geometryResult` already spans every loaded model (e.g. the merged Cesium world
 * view) or when there is provably only one model loaded, so there is nothing else to
 * wrongly include.
 */
import { getGlobalRenderer } from '../hooks/useBCF.js';
import { placedViewGeometry } from '@/lib/model-placement/view-geometry';
import { modelIndices } from '@/lib/model-placement/model-indices';
import type { GeometryResult } from '@ifc-lite/geometry';
import { hasRetainedShapeOnlyModel, type RetainedGeometrySummary } from '@/store/retainedGeometry';
import { meshIsResident } from '@/lib/geometry-backing/geometry-readback';
import { sceneGeometryReleased } from '@/lib/geometry-backing/scene-released';
import { getViewerState } from '@/store/viewerStoreHandle';
import { GeometryUnavailableError } from '@/lib/geometry-backing/geometry-readback';
import { geometryOwnerNeedsReadback } from '@/lib/geometry-backing/geometry-owner-residency';
import { storeGeometryOwners } from '@/lib/geometry-backing/store-geometry-owners';
import { releasedCopyFrom } from '@/lib/geometry-backing/store-mesh-readback';
import type { ReleasedExportGeometry } from '@/lib/geometry-backing/export-readback';
import type { MeshData } from '@ifc-lite/geometry';

/** This model's global-id bracket, for scoping `getAllInstancedMeshData()`'s
 *  unfiltered (all-models) output down to just this model's occurrences. */
export interface InstancedModelRange {
  /** Known owner; ID ranges can overlap between collab and normally loaded models. */
  modelId?: string;
  /** `FederatedModel.idOffset` — global ids for this model start at `idOffset + 1`. */
  idOffset: number;
  /** `FederatedModel.maxExpressId` — the highest LOCAL id in this model, so the
   *  global-id upper bound is `idOffset + maxExpressId`. */
  maxExpressId: number;
  /**
   * This model's OWN renderer model index (`modelIndices(state.models).get(modelId)`),
   * when known. `getAllInstancedMeshData()`'s pieces each carry the renderer
   * `modelIndex` of the template they were materialized from (#4890 review):
   * a collab-joined model and a normally loaded model CAN share an
   * overlapping global-id range (the comment above already warns of this),
   * and the id-range filter alone would then leak one model's occurrences
   * into the other's export/index. Passing this narrows the filter with an
   * exact-owner check; omitting it leaves the id-range filter as the sole
   * check, exactly as before — never a behavior change for a caller with no
   * renderer index to give.
   */
  rendererModelIndex?: number;
}

/**
 * One export operation's read-back geometry (#10264, #10887), handed to its `run` by
 * {@link withReleasedExportGeometry} and passed explicitly to the collectors that operation calls.
 * There is no ambient context: a collector called without one sees only resident geometry, so
 * unrelated code can never read (or be scoped by) another operation's preparation.
 */
export interface ReleasedExportContext {
  readonly prepared: ReleasedExportGeometry | null;
  /** The models this operation was prepared for (#10887 r4647377537); absent: every model. The collector judges
   * release over exactly these, so a released model outside them cannot refuse or skew the operation. */
  readonly scope?: readonly string[];
}

export function withInstancedMeshes(
  geometryResult: GeometryResult,
  modelRange: InstancedModelRange | null,
  context?: ReleasedExportContext,
): GeometryResult {
  // Released CPU geometry (#10264): substitute what this operation read back; without its
  // context, fail rather than export empty arrays and no occurrences.
  const prepared = context?.prepared ?? null;
  if (!prepared && geometryReleased(geometryResult, modelRange?.modelId ? [modelRange.modelId] : context?.scope)) {
    throw new GeometryUnavailableError('Released geometry must be exported inside withReleasedExportGeometry');
  }
  if (prepared) {
    geometryResult = { ...geometryResult, meshes: geometryResult.meshes.map((mesh) => {
      if (meshIsResident(mesh)) return mesh;
      // Consumers pass copies (federation modelIndex, placement): resolve by provenance, keep their scalars.
      const copy = releasedCopyFrom(prepared.flat, mesh);
      if (!copy) throw new GeometryUnavailableError(`Mesh of entity ${mesh.expressId} was not read back for export`);
      return copy;
    }) };
  }
  geometryResult = placedViewGeometry(geometryResult, undefined, modelRange?.modelId);
  const scene = getGlobalRenderer()?.getScene();
  const live = scene?.getAllInstancedMeshData() ?? [];
  // An occurrence without a modelIndex belongs to the sole model (canonical index 0); in a
  // federation it is ambiguous, and an owner-scoped export must not guess.
  const singleModel = getViewerState().models.size <= 1;
  const occurrenceIndex = (mesh: MeshData) => mesh.modelIndex ?? (singleModel ? 0 : undefined);
  const residentInstances = prepared ? live.filter((mesh) => {
    const index = occurrenceIndex(mesh);
    if (index === undefined) throw new GeometryUnavailableError('A resident instanced export has no model owner');
    return prepared.scopeModelIndices.has(index) && !prepared.instancedModelIndices.has(index);
  }) : live;
  const all = prepared ? [...prepared.instanced, ...residentInstances] : residentInstances;
  const ownerIndex = modelRange?.rendererModelIndex ?? (modelRange?.modelId
    ? modelIndices(getViewerState().models).get(modelRange.modelId) : undefined);
  const ownedBy = (m: MeshData, owner: number) => {
    const index = occurrenceIndex(m);
    if (index === undefined) throw new GeometryUnavailableError(`Instanced entity ${m.expressId} has no model owner in a federation`);
    return index === owner;
  };
  const instanced = modelRange
    ? all.filter(
        (m) => m.expressId > modelRange.idOffset && m.expressId <= modelRange.idOffset + modelRange.maxExpressId
          && (ownerIndex === undefined || ownedBy(m, ownerIndex)),
      )
    : all;
  if (instanced.length === 0) return geometryResult;

  let totalTriangles = geometryResult.totalTriangles;
  let totalVertices = geometryResult.totalVertices;
  for (const m of instanced) {
    totalTriangles += m.indices.length / 3;
    totalVertices += m.positions.length / 3;
  }
  return {
    ...geometryResult,
    meshes: [...geometryResult.meshes, ...instanced],
    totalTriangles,
    totalVertices,
  };
}

/**
 * `modelId`'s instanced range, owner index included: an overlapping-id collab model's occurrences fall inside the id
 * bracket too, and only the renderer index tells them apart (#10695). `models` must be the store's whole map: the
 * index allocator releases any id missing from the map it is given.
 */
export function instancedModelRangeOf(modelId: string, models: ReadonlyMap<string, { idOffset?: number; maxExpressId?: number }>): InstancedModelRange | null {
  const model = models.get(modelId);
  return model ? { modelId, idOffset: model.idOffset ?? 0, maxExpressId: model.maxExpressId ?? 0, rendererModelIndex: modelIndices(models).get(modelId) } : null;
}

/** Resolves a single panel's `InstancedModelRange` (see the module doc above)
 *  from its own `modelId` plus the currently loaded models, AND whether an
 *  instanced-geometry export may proceed at all.
 *
 * `null` is the correct, unfiltered range ONLY when the model id resolved to
 * nothing because this is provably the sole loaded model. An unresolved
 * `modelId` while `models.size > 1` (e.g. no entity selected in a
 * federation, or a stale id after a model was removed) must NOT fall through
 * to `null` — `withInstancedMeshes(geometryResult, null)` then splices every
 * OTHER loaded model's instanced occurrences into this model's export. Such
 * a leak was `GeoreferencingPanel`'s KMZ export before this helper existed
 * (PR #2878 review): `canExport: false` tells the caller to withhold the
 * export instead of falling through to that unfiltered case. */
export function resolveInstancedExportGate(
  modelId: string | undefined,
  models: ReadonlyMap<string, { idOffset?: number; maxExpressId?: number; retainedGeometry?: RetainedGeometrySummary }>,
): { instancedModelRange: InstancedModelRange | null; canExport: boolean } {
  const model = modelId ? models.get(modelId) : undefined;
  const instancedModelRange = modelId ? instancedModelRangeOf(modelId, models) : null;
  // An incomplete or shape-only retained model would export its partial meshes as the model (#7955).
  const canExport = (models.size <= 1 || instancedModelRange !== null) && !hasRetainedShapeOnlyModel(model && modelId ? new Map([[modelId, model]]) : models);
  return { instancedModelRange, canExport };
}

// One preparation in memory at a time: operations run one after another (bounded readback).
let exportTail: Promise<void> = Promise.resolve();

/** Whether any loaded CPU geometry (or this result's) was released (#10264). */
export function geometryReleased(geometryResult?: GeometryResult, modelIds?: Iterable<string>): boolean {
  if (geometryResult && !geometryResult.meshes.every(meshIsResident)) return true;
  const state = getViewerState();
  const scope = modelIds === undefined ? undefined : new Set(modelIds);
  const owners = storeGeometryOwners(state);
  const renderer = getGlobalRenderer();
  // An owner the store does not know: with resident geometry supplied, only a released scene
  // (its instancing must be read back) makes the export released; with none, fail closed.
  if (scope && [...scope].some((id) => !owners.some((owner) => owner.modelId === id))) {
    return geometryResult ? !!renderer && sceneGeometryReleased(renderer) : true;
  }
  const scene = renderer?.getScene();
  if (!scope && renderer && sceneGeometryReleased(renderer)) return true;
  if (geometryResult && !scope) return false;
  const indices = modelIndices(state.models);
  return owners.some((owner) => (!scope || scope.has(owner.modelId))
    && geometryOwnerNeedsReadback(owner.geometryResult?.meshes ?? [], scene, indices.get(owner.modelId) ?? 0));
}

/**
 * Run an export so it also works once CPU geometry was released (#10264): released store meshes
 * and instanced occurrences are read back first, and `run` receives the operation's context to
 * pass to its `withInstancedMeshes` calls. Resident geometry gets an empty context, unchanged.
 */
export async function withReleasedExportGeometry<T>(run: (context: ReleasedExportContext) => T | Promise<T>, modelIds?: Iterable<string>): Promise<T> {
  const scope = modelIds === undefined ? undefined : [...modelIds];
  const previous = exportTail;
  let finish!: () => void;
  exportTail = new Promise<void>((resolve) => { finish = resolve; });
  await previous;
  try {
    if (!geometryReleased(undefined, scope)) return await run({ prepared: null, scope });
    const { prepareReleasedExport } = await import('@/lib/geometry-backing/export-readback');
    const renderer = getGlobalRenderer();
    return await run({ prepared: await prepareReleasedExport(getViewerState(), renderer?.getScene(), scope), scope });
  } finally {
    finish();
  }
}
