/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store/spatial-index wiring for `convergeGeometryOntoRtcAnchor`
 * (`@ifc-lite/geometry/rtc-rebase`), split out of `useIfcFederation.ts` for
 * module size, same reason `federationRealign.ts` was (#4897).
 *
 * Call {@link convergeFederationRtcFrame} after EVERY federated load settles,
 * whether or not that load is still the newest session. It reads the store as
 * it is then, not a snapshot taken before the load: federated loads can
 * overlap, and two loads that both started with no anchor would otherwise each
 * see "no peer" and leave one model raw beside another's anchor. Recomputing
 * on the final set means the last load to settle always converges everything
 * that has settled, in either completion order.
 */

import {
  carriesGpuInstancedGeometry,
  convergeGeometryOntoRtcAnchor,
  isOnRtcAnchor,
  rebaseCoordinateInfoOntoRtcAnchor,
  rebaseOriginByRtcDelta,
  rtcRebaseDeltaFor,
} from '@ifc-lite/geometry/rtc-rebase';
import { chooseSharedRtcOffset, federationFrameInfo } from '@ifc-lite/geometry/world-frame';
import type { Vec3 } from '@ifc-lite/geometry';
import { toast } from '@/components/ui/toast';
import { useViewerStore, type FederatedModel } from '../../store/index.js';
import type { PreAlignmentSnapshot } from '../../store/index.js';
import { invalidateSpatialIndex } from '../../utils/loadingUtils.js';
import { hasInstancedShards } from '../../store/instancedShardModels.js';
import { modelRotationBaker } from '../../lib/model-placement/rotation-bake.js';
import { isLandXmlSchema } from './landXmlSemantics.js';

/**
 * A model whose geometry is final. A model still streaming keeps receiving
 * batches meshed against the frame it started with, so moving what it has so
 * far would split it; it is converged when its own load settles.
 */
function hasSettledGeometry(model: FederatedModel): boolean {
  return model.geometryResult != null
    && model.loadState !== 'pending'
    && model.loadState !== 'streaming-geometry'
    && model.loadState !== 'error';
}

/**
 * The pre-alignment snapshot is the model's own frame that a later re-align
 * restores to. It must follow the model onto the anchor, or a restore (and a
 * model then skipped for having no georeference) drops it back into the raw
 * frame beside anchored models.
 */
function convergeSnapshot(snapshot: PreAlignmentSnapshot, anchor: Readonly<Vec3>): boolean {
  if (isOnRtcAnchor(snapshot.coordinateInfo, anchor)) return false;
  const delta = rtcRebaseDeltaFor(snapshot.coordinateInfo, anchor);
  snapshot.origins = snapshot.origins.map((origin) => rebaseOriginByRtcDelta(origin, delta));
  snapshot.coordinateInfo = rebaseCoordinateInfoOntoRtcAnchor(snapshot.coordinateInfo, anchor);
  return true;
}

let lastRefusalKey = '';

/**
 * A geometry-free LandXML document still renders authored boundary, breakline
 * and contour overlays. Those overlays are absolute survey coordinates, so
 * their sole render-frame input is `coordinateInfo`; unlike a mesh there is
 * no origin to translate. Copy the settled mesh-bearing model's full frame
 * instead of relying on an RTC offset, because native adapters may establish
 * a frame with `originShift` alone.
 */
function adoptMeshlessLandXmlFrame(
  settled: ReadonlyArray<readonly [string, FederatedModel]>,
): string[] {
  const meshBearing = settled.filter(([, model]) => (model.geometryResult?.meshes.length ?? 0) > 0);
  const frame = federationFrameInfo(meshBearing.map(([, model]) => model));
  if (!frame) return [];
  const adopted: string[] = [];
  for (const [modelId, model] of settled) {
    const geometry = model.geometryResult;
    if (!model.sourceSchema || !isLandXmlSchema(model.sourceSchema) || !geometry || geometry.meshes.length !== 0) continue;
    geometry.coordinateInfo = structuredClone(frame);
    adopted.push(modelId);
  }
  return adopted;
}

/**
 * Converge every settled federated model onto the federation's RTC anchor
 * (the earliest-loaded settled model with a `wasmRtcOffset`). A no-op while
 * no settled model has one.
 *
 * GPU-instanced models cannot be moved (see `carriesGpuInstancedGeometry`);
 * they are named in a warning and a toast, and every other model still
 * converges, so at most those models render apart.
 */
export function convergeFederationRtcFrame(): void {
  const models = useViewerStore.getState().models;
  const settled = [...models].filter(
    (entry): entry is [string, FederatedModel] => hasSettledGeometry(entry[1] as FederatedModel),
  );
  const adoptedIds = adoptMeshlessLandXmlFrame(settled);
  const anchor = chooseSharedRtcOffset(settled.map(([, model]) => model));
  if (!anchor) {
    for (const modelId of adoptedIds) useViewerStore.getState().updateModel(modelId, {});
    return;
  }

  // Refuse up front per model, so the spatial index of a model that will
  // not move is never withdrawn.
  const instancedIds = new Set(settled.filter(([id]) => hasInstancedShards(id)).map(([, model]) => model.geometryResult!));
  const movable = settled.filter(([, model]) => {
    const geometry = model.geometryResult!;
    return !isOnRtcAnchor(geometry.coordinateInfo, anchor) && !carriesGpuInstancedGeometry(geometry) && !instancedIds.has(geometry);
  });
  // Captured BEFORE the move, while each model's `CoordinateInfo` still
  // records the frame it is leaving: everything recorded in that frame outside
  // the geometry has to be shifted by the same vector.
  const deltas = new Map(movable.map(([modelId, model]) =>
    [modelId, rtcRebaseDeltaFor(model.geometryResult!.coordinateInfo, anchor)] as const));
  // Withdraw each index BEFORE the geometry moves: the rebuild below is
  // async, and until it lands raycasts and bounds queries would be answered
  // from the previous frame's boxes.
  for (const [, model] of movable) {
    if (model.ifcDataStore) invalidateSpatialIndex(model.ifcDataStore);
  }

  const { moved, refused } = convergeGeometryOntoRtcAnchor(
    settled.map(([, model]) => model.geometryResult!),
    anchor,
    (geometry) => instancedIds.has(geometry),
  );

  // A snapshot follows its model only once the live geometry is on the anchor:
  // restoring an anchor-framed snapshot onto a refused model or a point cloud
  // would mix two frames in one model.
  for (const [, model] of settled) {
    if (model.preAlignment && isOnRtcAnchor(model.geometryResult!.coordinateInfo, anchor)) {
      convergeSnapshot(model.preAlignment, anchor);
    }
  }

  if (refused.length > 0) {
    const names = settled.filter(([, model]) => refused.includes(model.geometryResult!)).map(([, model]) => model.name);
    const key = `${names.join(', ')}|${anchor.x},${anchor.y},${anchor.z}`;
    const message = `${names.join(', ')} use GPU-instanced geometry and cannot be moved into the federation's shared coordinate frame, so they render apart from the other models. `
      + 'Load the georeferenced model first to place the whole federation in one frame.';
    console.warn(`[ifc-lite] Federation RTC re-base refused (#4897): ${message}`);
    if (key !== lastRefusalKey) toast.info(message);
    lastRefusalKey = key;
  }
  if (moved.length === 0) {
    for (const modelId of adoptedIds) useViewerStore.getState().updateModel(modelId, {});
    return;
  }

  // A model's HEADING rides the move for free — a yaw and a pure translation
  // commute, so the already-baked vertices are still correct. What does not is
  // the render-frame state the rotation feature records ALONGSIDE the geometry:
  // the pristine baseline a later heading edit restores, and the stored pivot
  // that edit turns about (`rotation-bake.ts`, contract 3). Both move here,
  // BEFORE the `updateModel` calls below republish `models` and wake the
  // rotation sync, so no bake can ever observe a half-converged frame.
  const movedIds = settled.filter(([, model]) => moved.includes(model.geometryResult!)).map(([modelId]) => modelId);
  for (const modelId of movedIds) {
    const delta = deltas.get(modelId);
    if (delta) modelRotationBaker.rebaseFrame(modelId, delta);
  }
  useViewerStore.getState().rebasePlacementFrame(new Map(
    movedIds.flatMap((modelId) => { const delta = deltas.get(modelId); return delta ? [[modelId, delta] as const] : []; }),
  ));

  // Origins and coordinateInfo changed in place: bump the content version so
  // the merged-mesh cache and GPU buffers rebuild from them.
  useViewerStore.getState().bumpGeometryContentVersion();
  for (const [modelId, model] of settled) {
    if (!moved.includes(model.geometryResult!) && !adoptedIds.includes(modelId)) continue;
    // Re-wrap the entry so subscribers keyed on `models` see the change.
    useViewerStore.getState().updateModel(modelId, {});
  }
}
