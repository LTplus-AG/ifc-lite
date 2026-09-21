/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ModelSpatialReference } from '@ifc-lite/geometry';
import type { PointCloudAlignmentTransform, PointCloudSourceUnit } from './pointCloudAlignment';
import { rebasePointCloudDecodeOrigin, nativePointCloudOriginMatrix } from './pointCloudDecodeOrigin';

interface RegisteredAlignment {
  enabled: boolean;
  handle: { id: number };
  transform?: PointCloudAlignmentTransform;
  origin?: readonly [number, number, number];
  sourceSpatialReference?: ModelSpatialReference;
  sourceUnit: PointCloudSourceUnit;
}

export interface PointCloudAlignmentRegistration {
  /** Source CRS retained for a later anchor arriving after this scan. */
  sourceSpatialReference?: ModelSpatialReference;
  /** LAS/LAZ coordinates are CRS-native; other scan formats are metre-native. */
  sourceUnit?: PointCloudSourceUnit;
}

/**
 * Every currently-streamed point-cloud asset that has an alignment
 * transform available, keyed by its renderer handle id. Each scan keeps its own decode origin and alignment matrix so a
 * source opened later or removed independently cannot move another scan.
 */
const registry = new Map<number, RegisteredAlignment>();

export function registerPointCloudAlignment(
  handle: { id: number },
  transform: PointCloudAlignmentTransform | undefined,
  enabled = true,
  registration: PointCloudAlignmentRegistration = {},
): void {
  registry.set(handle.id, {
    handle,
    transform,
    enabled,
    sourceSpatialReference: registration.sourceSpatialReference,
    sourceUnit: registration.sourceUnit ?? 'mapUnit',
  });
}

export function unregisterPointCloudAlignment(handleId: number): void {
  registry.delete(handleId);
}

export function hasRegisteredPointCloudAlignment(): boolean {
  return [...registry.values()].some((entry) => entry.transform !== undefined);
}

/** Renderer surface this module needs — matches `@ifc-lite/renderer`'s
 *  `Renderer.setPointCloudTransform`. Typed narrowly here so this module
 *  doesn't need to import the whole `Renderer` class. */
export interface PointCloudTransformTarget {
  setPointCloudTransform(handle: { id: number }, matrix: Float32Array | Float64Array | null): void;
}

function matrixFor(
  entry: RegisteredAlignment,
  transform = entry.transform,
): Float32Array | Float64Array | null {
  if (transform) return entry.enabled ? transform.alignedMatrix : transform.unalignedMatrix;
  return entry.origin ? nativePointCloudOriginMatrix(entry.origin) : null;
}

interface PlannedWrite {
  entry: RegisteredAlignment;
  previous: Float32Array | Float64Array | null;
  next: Float32Array | Float64Array | null;
}

/**
 * Commit renderer writes as one logical registry transition. Renderer calls
 * are imperative, so an error cannot be preflighted; instead restore every
 * successfully-written asset before rethrowing and mutate registry state only
 * after all target writes have succeeded.
 */
function writeTransaction(renderer: PointCloudTransformTarget, plans: PlannedWrite[]): void {
  const written: PlannedWrite[] = [];
  try {
    for (const plan of plans) {
      renderer.setPointCloudTransform(plan.entry.handle, plan.next);
      written.push(plan);
    }
  } catch (error) {
    for (const plan of written.reverse()) {
      try {
        renderer.setPointCloudTransform(plan.entry.handle, plan.previous);
      } catch (rollbackError) {
        // A second device failure cannot be hidden: retain the original
        // operation error while making the incomplete GPU rollback diagnosable.
        console.error('[pointcloud] failed to roll back transform transaction:', rollbackError);
      }
    }
    throw error;
  }
}

/**
 * Push either the aligned or unaligned matrix to every registered asset.
 * Called once at ingest time (default: aligned when a mapConversion is
 * available) and again whenever the UI toggle flips.
 */
export function applyPointCloudAlignmentToggle(
  renderer: PointCloudTransformTarget | null | undefined,
  enabled: boolean,
): void {
  if (!renderer) return;
  const entries = [...registry.values()];
  const plans = entries.map((entry) => ({
    entry,
    previous: matrixFor(entry),
    next: entry.transform
      ? enabled ? entry.transform.alignedMatrix : entry.transform.unalignedMatrix
      : matrixFor(entry),
  }));
  writeTransaction(renderer, plans);
  for (const entry of entries) entry.enabled = enabled;
}

/** Update the decode base before the first chunk. A toggle changed while the
 * source opened stays authoritative; don't reuse the ingest-time boolean. */
export function retargetPointCloudDecodeOrigin(renderer: PointCloudTransformTarget, handle: { id: number }, origin: readonly [number, number, number]): void {
  const entry = registry.get(handle.id);
  if (!entry) { renderer.setPointCloudTransform(handle, nativePointCloudOriginMatrix(origin)); return; }
  const transform = entry.transform && rebasePointCloudDecodeOrigin(entry.transform, origin);
  const next = transform
    ? entry.enabled ? transform.alignedMatrix : transform.unalignedMatrix
    : nativePointCloudOriginMatrix(origin);
  writeTransaction(renderer, [{ entry, previous: matrixFor(entry), next }]);
  entry.transform = transform;
  entry.origin = [...origin];
}

/**
 * Recompute every scan against a replacement federation anchor. This covers
 * scans that were opened before their compatible anchor: their native source
 * frame stays registered even while no alignment was available. The GPU and
 * registry commit together, so a single renderer failure never mixes anchors.
 */
export function realignRegisteredPointClouds(
  renderer: PointCloudTransformTarget | null | undefined,
  resolveTransform: (
    sourceSpatialReference: ModelSpatialReference | undefined,
    sourceUnit: PointCloudSourceUnit,
  ) => PointCloudAlignmentTransform | null,
): void {
  if (!renderer) return;
  const plans = [...registry.values()].map((entry) => {
    const base = resolveTransform(entry.sourceSpatialReference, entry.sourceUnit) ?? undefined;
    const transform = base && entry.origin
      ? rebasePointCloudDecodeOrigin(base, entry.origin)
      : base;
    const next = transform
      ? entry.enabled ? transform.alignedMatrix : transform.unalignedMatrix
      : entry.origin ? nativePointCloudOriginMatrix(entry.origin) : null;
    return { entry, previous: matrixFor(entry), next, transform };
  });
  writeTransaction(renderer, plans);
  for (const plan of plans) plan.entry.transform = plan.transform;
}
