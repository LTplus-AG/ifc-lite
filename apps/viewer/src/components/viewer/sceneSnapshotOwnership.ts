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
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type { Bounds } from './streamingBounds.js';

let pendingAdoption: object | null = null;
let finalFitBounds: Bounds | null = null;
let modelArrivalPending = false;

/** The box the camera last framed for a load. Not readable back: the camera keeps only the pose it produced. */
export function noteFinalFitBounds(bounds: Bounds): void {
  finalFitBounds = bounds;
}

export function lastFinalFitBounds(): Bounds | null {
  return finalFitBounds;
}

/** The next new geometry to sync belongs to this adoption; null withdraws it. */
export function setPendingSceneSnapshot(adoption: object | null): void {
  pendingAdoption = adoption;
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
  const adoption = pendingAdoption;
  pendingAdoption = null;
  if (!adoption || !renderer.getScene().hydrateSceneSnapshot(adoption, geometry)) return false;
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
