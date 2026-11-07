/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-shot handoff from a finished-scene snapshot to Scene sync. Adopted batches
 * were captured from the geometry this effect queued: filtered by type
 * visibility, wrapped by federation. So the effect hydrates them with what it
 * receives, and a filter that changed since shows up as a mismatch, which falls
 * back to an ordinary upload.
 */

import type { MutableRefObject } from 'react';
import type { Renderer, SceneContents } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds } from './streamingBounds.js';

/** The framing a snapshot was finalized under. */
export interface SnapshotCameraFit {
  fitBounds: Bounds;
  sceneBounds: Bounds;
  orbitAnchorBounds: Bounds | null;
}

let pending: { adoption: object; fit: SnapshotCameraFit | null; requeueShards: () => void } | null = null;
let finalFitBounds: Bounds | null = null;
let modelArrivalPending = false;

/**
 * What a snapshot's bytes depend on: the renderer's policy, and the type filter
 * that chose its pieces. A hit under another filter streams and replaces the
 * snapshot, so a changed setting costs one ordinary open.
 */
export function sceneSnapshotKey(policy: string, typeViewMode: string, typeVisibility: object): string {
  return `${policy}~${typeViewMode}~${JSON.stringify(typeVisibility)}`;
}

/** The box the camera last framed for a load. Not readable back: the camera keeps only the pose it produced. */
export function noteFinalFitBounds(bounds: Bounds): void {
  finalFitBounds = bounds;
}

export function lastFinalFitBounds(): Bounds | null {
  return finalFitBounds;
}

/** The next new geometry to sync belongs to this adoption; `requeueShards` hands its shards to the ordinary drain if refused. */
export function setPendingSceneSnapshot(adoption: object, requeueShards: () => void = () => {}, fit: SnapshotCameraFit | null = null): void {
  pending = { adoption, fit, requeueShards };
}

/** Frame the camera as the finished scene was, from a fresh pose. */
export function fitCameraToSnapshot(renderer: Pick<Renderer, 'getCamera' | 'getCanvas'>, fit: SnapshotCameraFit): void {
  const camera = renderer.getCamera();
  const canvas = renderer.getCanvas();
  const shortSide = Math.min(canvas?.clientHeight ?? 0, canvas?.clientWidth ?? 0);
  camera.fitBoundsAdaptive(fit.fitBounds, { viewportShortPx: shortSide > 0 ? shortSide : undefined });
  camera.setSceneBounds(fit.sceneBounds);
  camera.setOrbitAnchorBounds(fit.orbitAnchorBounds);
}

/** This adoption's load is over. A newer load's pending adoption stays. */
export function withdrawPendingSceneSnapshot(adoption: object): void {
  if (pending?.adoption === adoption) pending = null;
}

type SnapshotScene = Pick<SceneContents, 'isSceneSnapshotHydrating' | 'hydrateSceneSnapshot' | 'removeInstancedTemplatesForModel'>;

/**
 * Attach `geometry`, or fall back. A fallback's reshape runs before the model
 * registers and can drop the shards uploaded at adoption, so they move to the
 * ordinary drain, which runs after it, as on a streamed load.
 */
function settlePendingSnapshot(scene: SnapshotScene, geometry: readonly MeshData[]): boolean {
  const settling = pending;
  pending = null;
  if (!settling) return false;
  if (scene.hydrateSceneSnapshot(settling.adoption, geometry)) return true;
  scene.removeInstancedTemplatesForModel(0);
  settling.requeueShards();
  return false;
}

/**
 * Empty geometry during an adoption: true when the adopted batches keep the
 * scene because their meshes are still decoding. Once they are published, empty
 * means every type is now hidden, so the batches must go: nothing else ends them.
 */
export function adoptedSceneOutlivesEmptyGeometry(scene: SnapshotScene): boolean {
  if (!scene.isSceneSnapshotHydrating()) return false;
  if (!pending) return true;
  settlePendingSnapshot(scene, []);
  return false;
}

/**
 * The hydrated model registers after its geometry syncs. That is the snapshot's
 * own model, not one added to a federation, so it must not refit the camera:
 * no post-stream refit would follow to restore the final framing.
 */
export function takeSnapshotModelArrival(): boolean {
  const pending = modelArrivalPending;
  modelArrivalPending = false;
  return pending;
}

interface OwnershipRefs {
  lastGeometryLengthRef: MutableRefObject<number>;
  lastGeometryRef: MutableRefObject<MeshData[] | null>;
  cameraFittedRef: MutableRefObject<boolean>;
  finalBoundsRefittedRef: MutableRefObject<boolean>;
  geometryBoundsRef: MutableRefObject<Bounds>;
  cameraSnapshotRef: MutableRefObject<{ px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null>;
}

/** True when `geometry` hydrated the pending snapshot; the refs then describe it as already streamed and fitted. */
export function takeSceneSnapshotGeometry(geometry: MeshData[], modelCount: number, renderer: Renderer, refs: OwnershipRefs): boolean {
  const settling = pending;
  if (!settlePendingSnapshot(renderer.getScene(), geometry)) {
    // A fallback has no post-stream refit, so its upload would keep the sync's rough first fit.
    modelArrivalPending = settling !== null && modelCount === 0; // otherwise a superseded load's model never arrives
    if (settling?.fit) {
      const { fit } = settling;
      queueMicrotask(() => {
        fitCameraToSnapshot(renderer, fit);
        refs.geometryBoundsRef.current = fit.fitBounds;
        renderer.requestRender();
      });
    }
    return false;
  }
  modelArrivalPending = modelCount === 0;
  const camera = renderer.getCamera();
  refs.lastGeometryLengthRef.current = geometry.length;
  refs.lastGeometryRef.current = geometry;
  refs.cameraFittedRef.current = true;
  refs.finalBoundsRefittedRef.current = true;
  const bounds = camera.getOrbitAnchorBounds() ?? camera.getSceneBounds();
  if (bounds) refs.geometryBoundsRef.current = bounds;
  const position = camera.getPosition();
  const target = camera.getTarget();
  refs.cameraSnapshotRef.current = { px: position.x, py: position.y, pz: position.z, tx: target.x, ty: target.y, tz: target.z };
  renderer.requestRender();
  return true;
}
