/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Re-baking an already-loaded federation against the current anchor.
 *
 * `realignFederation` (useIfcFederation.ts) is the caller; the loop lives here
 * so it can be driven without a React store, and because federationAlign.ts is
 * already over the module-size guideline.
 *
 * Two rules this module exists to keep:
 *
 *  1. **"Do not align" is not "do not restore".** The anchor must never be
 *     ALIGNED — it defines the frame — but it must be RESTORED if it was ever
 *     aligned as a non-anchor. Switching the anchor X → A bakes X's geometry
 *     into A's frame; switching back to X used to `continue` past X before the
 *     restore step, leaving X defining a frame its own vertices are not in and
 *     every other model aligned to a frame X had left (#2007).
 *
 *  2. **The anchor is restored BEFORE anything is aligned into it.** The frame
 *     a model lands in is the anchor's `CoordinateInfo` (its RTC/shift choice),
 *     and alignment REPLACES that field on the model it re-bakes. So an anchor
 *     still carrying the previous anchor's `CoordinateInfo` hands every other
 *     model the wrong destination — restoring the anchor's vertices but reading
 *     its frame first fixes half the bug and hides the other half.
 *
 * The restore covers the whole set alignment touches: positions, normals,
 * per-mesh local-frame origins, coordinateInfo, per-entity world boxes and the
 * instanced-only world boxes. #2005 fixed two cases of a restore path covering
 * less than the alignment wrote and the origins were a third (found by running
 * the real `Building-Architecture.ifc` + `Infra-Bridge.ifc` federation through
 * two anchor switches), so capture and restore are defined next to each other
 * here and cannot answer different questions.
 */

import type { FederatedModel, PreAlignmentSnapshot } from '../../store/index.js';
import { alignGeometryToReference, type ModelGeoref } from './federationAlign.js';

type AlignableGeometry = NonNullable<FederatedModel['geometryResult']>;

/** The part of a federated model this module reads and writes. */
export interface RealignableModel {
  geometryResult?: AlignableGeometry | null;
  preAlignment?: PreAlignmentSnapshot;
  federationAlignmentStatus?: FederatedModel['federationAlignmentStatus'];
}

/**
 * Snapshot a geometry result's current state as its pre-alignment state.
 *
 * The snapshot owns everything it can be asked to put back: positions, normals
 * and origins are copied, the coordinate frame is deep-copied, and the
 * instanced-box Map is copied. The only things shared with the live geometry
 * are the world-box OBJECTS, which is sound because alignment replaces boxes
 * rather than mutating them — pinned by `federationAlign.test.ts`.
 *
 * The rule is that a snapshot and the geometry it came from are never one
 * value. Otherwise an in-place edit of the live geometry silently rewrites the
 * baseline, the restore becomes a no-op, and no assertion comparing the two can
 * see it.
 */
export function capturePreAlignment(geometry: AlignableGeometry): PreAlignmentSnapshot {
  return {
    positions: geometry.meshes.map((mesh) => new Float32Array(mesh.positions)),
    normals: geometry.meshes.map((mesh) => (
      mesh.normals && mesh.normals.length > 0 ? new Float32Array(mesh.normals) : undefined
    )),
    // Copied, not held: alignment replaces the array (`mesh.origin = [0,0,0]`)
    // today, but a copy costs three numbers and cannot be undone by a future
    // in-place writer.
    origins: geometry.meshes.map((mesh) => (mesh.origin ? [...mesh.origin] : undefined)),
    // Deep-copied, and by `structuredClone` rather than by hand: the frame is
    // nested three levels (`originalBounds.min.x`), so neither a spread nor a
    // spread-plus-one-level-of-bounds reaches the corners, and a hand-written
    // copy would silently stop covering a field added later. Holding the live
    // object instead would let anything that edits it in place (useIfcLoader
    // does exactly that to `wasmRtcOffset` on the streaming path) rewrite the
    // baseline, which turns the restore into a no-op that cannot be detected,
    // because the snapshot and the geometry would be one value.
    coordinateInfo: structuredClone(geometry.coordinateInfo),
    geometryAabbs: geometry.meshes.map((mesh) => mesh.geometryAabb),
    // The Map is copied so the snapshot owns its own entry set. The boxes
    // inside stay shared, at the same depth as the per-mesh `geometryAabbs`
    // above: alignment REPLACES box objects rather than mutating them, which is
    // pinned by `federationAlign.test.ts`.
    instancedGeometryAabbs: geometry.instancedGeometryAabbs
      ? new Map(geometry.instancedGeometryAabbs)
      : undefined,
  };
}

/**
 * Put a geometry result back exactly as the snapshot found it, undoing whatever
 * alignment baked into it.
 *
 * Normals are restored because alignment rotates them in place, so repeated
 * re-bakes would compound the rotation and drift the shading. The world boxes
 * are restored because alignment re-frames them too: re-aligning an already
 * aligned box while the vertices restart from the snapshot leaves the box in a
 * frame of its own, and compare then reports a plausible wrong distance (#2005).
 *
 * A mesh whose snapshot slot holds no box LOSES its box rather than keeping the
 * aligned one: an unknown pre-alignment box is the engine's documented "no box"
 * state (compare degrades to a bare `moved`), whereas a kept one asserts a
 * position in the previous anchor's frame.
 */
export function restorePreAlignment(
  geometry: AlignableGeometry,
  snapshot: PreAlignmentSnapshot,
): void {
  const meshes = geometry.meshes;
  const restoreCount = Math.min(meshes.length, snapshot.positions.length);
  for (let i = 0; i < restoreCount; i += 1) {
    meshes[i].positions = new Float32Array(snapshot.positions[i]);
    const normals = snapshot.normals[i];
    if (normals) meshes[i].normals = new Float32Array(normals);
    // The origin the alignment folded in and zeroed. Absent stays absent: a
    // mesh that never had one must not gain a [0,0,0] the renderer would then
    // treat as a local frame.
    const origin = snapshot.origins[i];
    if (origin) meshes[i].origin = [...origin];
    else delete meshes[i].origin;
    const box = snapshot.geometryAabbs[i];
    if (box) meshes[i].geometryAabb = box;
    else delete meshes[i].geometryAabb;
  }
  // Copies out, for the mirror of the reason the capture copies in: hand the
  // geometry the snapshot's own objects and the next in-place edit of the live
  // frame rewrites the baseline the NEXT restore reads. The spread this
  // replaced looked deep enough and was not — it copied the two bounds objects
  // but left their `min`/`max` shared.
  geometry.coordinateInfo = structuredClone(snapshot.coordinateInfo);
  geometry.instancedGeometryAabbs = snapshot.instancedGeometryAabbs
    ? new Map(snapshot.instancedGeometryAabbs)
    : undefined;
}

/** How each model fared, for the caller's summary toast. */
export interface RealignCounts {
  aligned: number;
  reprojected: number;
  skipped: number;
  failed: number;
}

export interface RealignFederationParams<M extends RealignableModel> {
  /** Every model in the federation, `[modelId, model]`, anchor included. */
  models: ReadonlyArray<readonly [string, M]>;
  anchorModelId: string;
  /**
   * The anchor's georeference as the caller resolved it. Its `coordinateInfo`
   * is re-pointed at the anchor's restored frame before anything is aligned —
   * see {@link RealignFederationResult.anchorGeoref}.
   */
  anchorGeoref: ModelGeoref;
  /**
   * A non-anchor model's OWN georeference, or null when it has none (the model
   * is then left in its own frame and counted as skipped). Called after the
   * model has been restored, because the georef reads its `coordinateInfo`.
   */
  resolveGeoref: (modelId: string, model: M) => ModelGeoref | null;
  updateModel: (modelId: string, patch: Partial<RealignableModel>) => void;
}

export interface RealignFederationResult {
  counts: RealignCounts;
  /**
   * The georeference every non-anchor model was actually aligned to: the
   * caller's anchor georef with its `coordinateInfo` re-pointed at the anchor's
   * restored frame. Reported so the caller names the right CRS in its summary.
   */
  anchorGeoref: ModelGeoref;
  /**
   * Every model whose geometry this pass actually MOVED: the anchor when it was
   * restored, plus each non-anchor that was restored out of a previous anchor's
   * frame and/or re-baked into this one. A model that was only re-written with
   * the values it already had (never aligned, or an `identity`/`failed`
   * alignment) is not in here.
   *
   * Two things must be keyed on this rather than on the align counts, because a
   * model can move without being "aligned" — a restored anchor (#2007), or a
   * model restored and then skipped for having no georef:
   *
   *  - `bumpGeometryContentVersion`, or the GPU keeps the old vertex buffers.
   *  - the per-model spatial index (`IfcDataStore.spatialIndex`), a BVH of
   *    WORLD-space mesh bounds that backs `queryByBounds`/`raycast`/
   *    `queryFrustum`. Alignment has never rebuilt it — the loader builds it
   *    once, after load-time alignment — so re-aligning has always left it
   *    describing the previous frame: measured on the real
   *    `Building-Architecture.ifc` + `Infra-Bridge.ifc` federation, a re-align
   *    left the index finding 7 of 78 meshes inside the model's own bounds
   *    (#2013). The caller owns the rebuild because the index hangs off the
   *    data store, which this module deliberately knows nothing about.
   */
  movedModelIds: string[];
}

/**
 * Restore every model to its own frame and re-bake the non-anchors into the
 * anchor's. See the module header for the two ordering rules.
 */
export async function realignFederationModels<M extends RealignableModel>(
  params: RealignFederationParams<M>,
): Promise<RealignFederationResult> {
  const { models, anchorModelId, resolveGeoref, updateModel } = params;
  const counts: RealignCounts = { aligned: 0, reprojected: 0, skipped: 0, failed: 0 };
  const movedModelIds: string[] = [];

  // The anchor FIRST, and restored rather than skipped (#2007).
  const anchorModel = models.find(([modelId]) => modelId === anchorModelId)?.[1];
  const anchorGeometry = anchorModel?.geometryResult;
  if (anchorModel) {
    if (anchorGeometry) {
      const snapshot = anchorModel.preAlignment;
      if (snapshot) {
        restorePreAlignment(anchorGeometry, snapshot);
        movedModelIds.push(anchorModelId);
      }
    }
    // Snapshots CLEARED, not kept: a restored anchor is its own pre-alignment
    // state, so a surviving snapshot is a second, stale copy of it — which is
    // how every previous defect in this path started. Clearing also restores
    // the invariant the loader documents ("undefined for the anchor itself")
    // and drops the geometry-sized copies.
    updateModel(anchorModelId, {
      preAlignment: undefined,
      federationAlignmentStatus: 'anchor',
    });
  }

  // The frame the rest of the federation lands in is the anchor's
  // `coordinateInfo` as it stands AFTER the restore. Everything else in a
  // ModelGeoref — mapConversion, projectedCRS, lengthUnitScale — comes from the
  // data store and the user's georef edits, which a restore cannot touch
  // (`getEffectiveGeoreference` passes `coordinateInfo` straight through), so
  // re-pointing that one field is exactly what re-extracting would produce.
  const anchorGeoref: ModelGeoref = anchorGeometry
    ? { ...params.anchorGeoref, coordinateInfo: anchorGeometry.coordinateInfo }
    : params.anchorGeoref;

  for (const [modelId, model] of models) {
    if (modelId === anchorModelId) continue;
    const geometry = model.geometryResult;
    if (!geometry) {
      // Say so, rather than leaving the badge from the PREVIOUS anchor. A model
      // with no geometry cannot be aligned against anything, and a stale
      // `same-crs` here reads in the models panel and the basepoint overlay as
      // "aligned to the current anchor" — a claim nothing in this pass made.
      updateModel(modelId, { federationAlignmentStatus: 'none' });
      counts.skipped += 1;
      continue;
    }

    // Lazy-snapshot: a model that joined before federation existed (or as the
    // anchor of a previous federation) was never re-baked, so its current
    // vertices ARE its pre-alignment positions — and restoring one of those is
    // a no-op that moves nothing.
    const stored = model.preAlignment;
    const snapshot = stored ?? capturePreAlignment(geometry);
    restorePreAlignment(geometry, snapshot);
    const restoredFromSnapshot = stored !== undefined;

    // AFTER the restore: the model's georef reads its `coordinateInfo`, and the
    // one that matters is its own, not the frame it was last baked into.
    const georef = resolveGeoref(modelId, model);
    if (!georef) {
      updateModel(modelId, {
        preAlignment: snapshot,
        federationAlignmentStatus: 'none',
      });
      // Skipped by the ALIGNMENT, but the restore above still moved it out of
      // the previous anchor's frame.
      if (restoredFromSnapshot) movedModelIds.push(modelId);
      counts.skipped += 1;
      continue;
    }

    const status = await alignGeometryToReference(geometry, georef, anchorGeoref);
    updateModel(modelId, {
      preAlignment: snapshot,
      federationAlignmentStatus: status,
    });
    if (restoredFromSnapshot || status === 'same-crs' || status === 'reprojected') {
      movedModelIds.push(modelId);
    }
    if (status === 'reprojected') counts.reprojected += 1;
    else if (status === 'failed') counts.failed += 1;
    else counts.aligned += 1;
  }

  return { counts, anchorGeoref, movedModelIds };
}
