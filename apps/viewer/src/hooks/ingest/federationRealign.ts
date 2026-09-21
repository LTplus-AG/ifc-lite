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
import type { ModelSpatialReference } from '@ifc-lite/geometry';
import { alignGeometryToReference, type ModelSpatialPlacement } from './federationAlign.js';
import {
  capturePreAlignment,
  restorePreAlignment,
  type AlignableGeometry,
} from './federationPreAlignment.js';
import { canonicalRendererPlacement } from './federationCanonicalReference.js';
import {
  applyLandXmlRenderedLineUpdates,
  buildLandXmlRenderedLineUpdates,
  clearLandXmlRenderedLineUpdates,
  type LandXmlRenderedLineUpdate,
} from './landXmlSpatialLines.js';
import type { LandXmlTinDocument } from './landXmlSemantics.js';

export { capturePreAlignment, restorePreAlignment } from './federationPreAlignment.js';

/** The part of a federated model this module reads and writes. */
export interface RealignableModel {
  geometryResult?: AlignableGeometry | null;
  preAlignment?: PreAlignmentSnapshot;
  federationAlignmentStatus?: FederatedModel['federationAlignmentStatus'];
  spatialReference?: ModelSpatialReference;
  landXmlDocument?: LandXmlTinDocument;
}

/** How each model fared, for the caller's summary toast. */
export interface RealignCounts {
  aligned: number;
  reprojected: number;
  skipped: number;
  failed: number;
}

export interface RealignFederationParams<M extends RealignableModel> {
  models: ReadonlyArray<readonly [string, M]> | (() => ReadonlyArray<readonly [string, M]>);
  getModel?: (modelId: string) => M | undefined;
  anchorModelId: string;
  /**
   * The anchor record selected when this request was queued. A queued pass
   * must never adopt a replacement record for the same ID as its destination.
   */
  anchorModel: M;
  /**
   * The anchor's georeference as the caller resolved it. Its `coordinateInfo`
   * is re-pointed at the anchor's restored frame before anything is aligned —
   * see {@link RealignFederationResult.anchorGeoref}.
   */
  anchorGeoref: ModelSpatialPlacement;
  /**
   * A non-anchor model's OWN georeference, or null when it has none (the model
   * is then left in its own frame and counted as skipped). Called after the
   * model has been restored, because the georef reads its `coordinateInfo`.
   */
  resolveGeoref: (modelId: string, model: M) => ModelSpatialPlacement | null;
  updateModel: (modelId: string, patch: Partial<RealignableModel>) => void;
  /** A superseded UI request must leave no partial geometry or line frame behind. */
  isCurrent?: () => boolean;
}

export interface RealignFederationResult {
  counts: RealignCounts;
  /**
   * The georeference every non-anchor model was actually aligned to: the
   * caller's anchor georef with its `coordinateInfo` re-pointed at the anchor's
   * restored frame. Reported so the caller names the right CRS in its summary.
   */
  anchorGeoref: ModelSpatialPlacement;
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
  /** The call was superseded and every in-place edit was rolled back. */
  stale: boolean;
}

/** Record replacements may be ordinary immutable store patches. Ownership,
 * not wrapper identity, distinguishes those from a newly loaded model. */
function sameModelOwnership(
  current: RealignableModel,
  selected: RealignableModel,
): boolean {
  return current.geometryResult === selected.geometryResult
    && current.spatialReference === selected.spatialReference
    && current.landXmlDocument === selected.landXmlDocument;
}

/**
 * Restore every model to its own frame and re-bake the non-anchors into the
 * anchor's. See the module header for the two ordering rules.
 */
let realignmentTail: Promise<void> = Promise.resolve();

/**
 * Serialize complete transactions, including rollback. A stale pass owns its
 * snapshot, so allowing a newer pass to publish while the stale one awaits a
 * CRS operation lets that old snapshot overwrite new geometry on rollback.
 */
function serializeRealignment<T>(operation: () => Promise<T>): Promise<T> {
  const result = realignmentTail.then(operation, operation);
  realignmentTail = result.then(() => undefined, () => undefined);
  return result;
}

export function realignFederationModels<M extends RealignableModel>(
  params: RealignFederationParams<M>,
): Promise<RealignFederationResult> {
  return serializeRealignment(() => realignFederationModelsTransaction(params));
}

async function realignFederationModelsTransaction<M extends RealignableModel>(
  params: RealignFederationParams<M>,
): Promise<RealignFederationResult> {
  const models = typeof params.models === 'function' ? params.models() : params.models;
  const { anchorModelId, resolveGeoref, updateModel } = params;
  const isCurrent = params.isCurrent ?? (() => true);
  const counts: RealignCounts = { aligned: 0, reprojected: 0, skipped: 0, failed: 0 };
  const movedModelIds: string[] = [];
  // `updateModel` replaces Zustand records, while deliberately retaining the
  // mutable geometry object. Keep those two ownership questions separate:
  // record identity fences publication, but a stale transaction must still
  // restore geometry that an innocuous visibility/name patch continues to
  // share (#5048).
  const expectedModels = new Map(models);
  let transactionMutated = false;
  const currentModel = (modelId: string): M | undefined => params.getModel?.(modelId);
  const currentEntries = (): ReadonlyArray<readonly [string, M]> | undefined => (
    typeof params.models === 'function' ? params.models() : undefined
  );
  const isLive = (modelId: string): boolean => {
    if (!params.getModel) return true;
    return currentModel(modelId) === expectedModels.get(modelId);
  };
  const transactionIsLive = (): boolean => {
    if (!isCurrent()) return false;
    const entries = currentEntries();
    if (entries) {
      if (entries.length !== expectedModels.size) return false;
      for (const [modelId, model] of entries) {
        if (expectedModels.get(modelId) !== model) return false;
      }
    }
    for (const [modelId, expected] of expectedModels) {
      if (params.getModel && currentModel(modelId) !== expected) return false;
    }
    return true;
  };
  const commit = (modelId: string, patch: Partial<RealignableModel>): boolean => {
    if (!transactionIsLive() || !isLive(modelId)) return false;
    updateModel(modelId, patch);
    transactionMutated = true;
    // A normal Zustand patch makes the next expected record identity.
    if (params.getModel) {
      const updated = currentModel(modelId);
      if (!updated) return false;
      expectedModels.set(modelId, updated);
    }
    return true;
  };
  const before = new Map(models.map(([modelId, model]) => [modelId, {
    geometryOwner: model.geometryResult,
    geometry: model.geometryResult ? capturePreAlignment(model.geometryResult) : undefined,
    preAlignment: model.preAlignment,
    federationAlignmentStatus: model.federationAlignmentStatus,
  }]));
  const landXmlUpdates: LandXmlRenderedLineUpdate[][] = [];
  const rollback = () => {
    if (!transactionMutated) return;
    for (const [modelId] of models) {
      const saved = before.get(modelId);
      if (!saved) continue;
      const live = currentModel(modelId);
      // An immutable display-only update replaces the record but intentionally
      // shares its geometry. That geometry was mutated in place before the
      // stale fence fired, so restore it through the replacement record. A
      // true replacement owns another geometry object and must be untouched.
      if (params.getModel && live?.geometryResult !== saved.geometryOwner) continue;
      const geometry = live?.geometryResult ?? saved.geometryOwner;
      if (geometry && saved.geometry) restorePreAlignment(geometry, saved.geometry);
      if (params.getModel && !live) continue;
      // Do not use `commit`: a stale transaction is expected to fail its
      // record-identity fence. `updateModel` merges these lifecycle fields
      // into a harmless immutable replacement without overwriting its name,
      // visibility, or other caller-owned fields.
      updateModel(modelId, {
        preAlignment: saved.preAlignment,
        federationAlignmentStatus: saved.federationAlignmentStatus,
      });
    }
  };
  const stale = (): RealignFederationResult => {
    rollback();
    return { counts, anchorGeoref: params.anchorGeoref, movedModelIds: [], stale: true };
  };

  try {
    // The anchor FIRST, and restored rather than skipped (#2007).
    const anchorModel = models.find(([modelId]) => modelId === anchorModelId)?.[1];
    // `models` is intentionally read only after this pass owns the queue, so
    // a queued request sees prior passes' snapshots. Its anchor is different:
    // it was selected before queuing, and may since have been removed or
    // replaced. Never fall back to that request's old placement and mutate a
    // new federation against it (#5048).
    if (!anchorModel || !sameModelOwnership(anchorModel, params.anchorModel)) return stale();
    const anchorGeometry = anchorModel?.geometryResult;
    if (!transactionIsLive() || !isLive(anchorModelId)) return stale();
    if (anchorGeometry) {
      const snapshot = anchorModel.preAlignment;
      if (snapshot) {
        transactionMutated = true;
        restorePreAlignment(anchorGeometry, snapshot);
        movedModelIds.push(anchorModelId);
      }
    }
    // Snapshots CLEARED, not kept: a restored anchor is its own pre-alignment
    // state, so a surviving snapshot is a second, stale copy of it — which is
    // how every previous defect in this path started. Clearing also restores
    // the invariant the loader documents ("undefined for the anchor itself")
    // and drops the geometry-sized copies.
    if (!commit(anchorModelId, {
      preAlignment: undefined,
      federationAlignmentStatus: 'anchor',
    })) return stale();
    if (anchorModel.landXmlDocument) landXmlUpdates.push(clearLandXmlRenderedLineUpdates(anchorModel.landXmlDocument));

    // Re-extract AFTER restoring the anchor. This is not equivalent to replacing
    // just `coordinateInfo`: the IFC adapter's map-absolute guard derives its
    // local operation from that frame, so keeping the operation captured before
    // restore can align A→B→A through B's neutralised conversion.
    const rawAnchorGeoref = resolveGeoref(anchorModelId, anchorModel);
    if (!rawAnchorGeoref) {
      throw new Error('Cannot re-align federation: the restored anchor no longer has a valid spatial reference');
    }
    const anchorGeoref = canonicalRendererPlacement(rawAnchorGeoref);

    for (const [modelId, model] of models) {
      if (modelId === anchorModelId) continue;
      if (!transactionIsLive() || !isLive(modelId)) return stale();
      const geometry = model.geometryResult;
      if (!geometry) {
      // Say so, rather than leaving the badge from the PREVIOUS anchor. A model
      // with no geometry cannot be aligned against anything, and a stale
      // `same-crs` here reads in the models panel and the basepoint overlay as
      // "aligned to the current anchor" — a claim nothing in this pass made.
        if (!commit(modelId, { federationAlignmentStatus: 'none' })) return stale();
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
        if (!commit(modelId, {
          preAlignment: snapshot,
          federationAlignmentStatus: 'none',
        })) return stale();
      // Skipped by the ALIGNMENT, but the restore above still moved it out of
      // the previous anchor's frame.
        if (restoredFromSnapshot) movedModelIds.push(modelId);
        counts.skipped += 1;
        if (model.landXmlDocument) landXmlUpdates.push(clearLandXmlRenderedLineUpdates(model.landXmlDocument));
        if (!transactionIsLive()) return stale();
        continue;
      }

      const status = await alignGeometryToReference(geometry, georef, anchorGeoref);
      if (!transactionIsLive() || !isLive(modelId)) return stale();
      if (!commit(modelId, {
        preAlignment: snapshot,
        federationAlignmentStatus: status,
      })) return stale();
      if (restoredFromSnapshot || status === 'same-crs' || status === 'reprojected') {
        movedModelIds.push(modelId);
      }
      if (status === 'reprojected') counts.reprojected += 1;
      else if (status === 'failed') counts.failed += 1;
      else counts.aligned += 1;
      if (model.landXmlDocument && (status === 'same-crs' || status === 'reprojected' || status === 'identity')) {
        const source = model.spatialReference ?? georef.spatialReference;
        landXmlUpdates.push(await buildLandXmlRenderedLineUpdates(
          model.landXmlDocument, source, anchorGeoref.spatialReference, anchorGeoref.coordinateInfo,
        ));
        if (!transactionIsLive()) return stale();
      } else if (model.landXmlDocument) {
        landXmlUpdates.push(clearLandXmlRenderedLineUpdates(model.landXmlDocument));
      }
      if (!transactionIsLive()) return stale();
    }

    if (!transactionIsLive()) return stale();
    for (const updates of landXmlUpdates) applyLandXmlRenderedLineUpdates(updates);
    return { counts, anchorGeoref, movedModelIds, stale: false };
  } catch (error) {
    rollback();
    throw error;
  }
}
