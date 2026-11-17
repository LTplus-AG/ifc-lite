/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure per-frame helpers of the Gaussian layer (#8564). */

import type { GaussianEncodeCamera, GaussianEncodeTarget, GaussianRowFilter, GaussianSortColumns } from './gaussian-backend.js';
import type { GaussianSplatBounds, GaussianSplatState, GaussianSplatStats } from './gaussian-types.js';
import type { GaussianCompositionReport } from './gaussian-composition.js';
import type { PackedScene } from './gaussian-pack.js';
import { clipIsActive, pointClipped } from '../scene-raycaster.js';
import type { PickClipState } from '../pick-types.js';
import type { RelativeToEyeFrame } from '../relative-to-eye.js';

/**
 * The viewer's translation-free RTE view-projection composed with the anchor's
 * camera-relative offset, formed in float64 like every RTE drawable delta.
 */
export function anchoredCamera(frame: RelativeToEyeFrame, anchor: readonly [number, number, number]): GaussianEncodeCamera {
  const viewProjection = frame.getViewProjection().m;
  const eye = frame.getCameraWorld();
  const delta = [anchor[0] - eye[0], anchor[1] - eye[1], anchor[2] - eye[2]];
  const modelViewProjection = Float64Array.from(viewProjection);
  for (let row = 0; row < 4; row++) {
    modelViewProjection[12 + row] = viewProjection[row] * delta[0] + viewProjection[4 + row] * delta[1] + viewProjection[8 + row] * delta[2] + viewProjection[12 + row];
  }
  return { modelViewProjection, cameraPosition: [-delta[0], -delta[1], -delta[2]] };
}

/** Identity of the clip state that changes the centre filter; 'none' when nothing clips. */
export function clipKey(clip: PickClipState | null): string {
  return clipIsActive(clip) && clip ? JSON.stringify([clip.sectionPlane, clip.extraPlanes, clip.clipBox]) : 'none';
}

/**
 * Centre clipping: a whole Gaussian is kept or removed by its centre, using the
 * renderer's CPU mirror of the mesh fragment discard. Its footprint is not clipped.
 */
export function centreClipFilter(clip: PickClipState | null, source: Pick<GaussianSortColumns, 'positions'> | undefined, anchor: readonly [number, number, number] | null): GaussianRowFilter | null {
  if (!clipIsActive(clip) || !clip || !source || !anchor) return null;
  const { positions } = source;
  return (_slot, row) => !pointClipped(clip, anchor[0] + positions[row * 3], anchor[1] + positions[row * 3 + 1], anchor[2] + positions[row * 3 + 2]);
}

/** Keep the frame's MSAA resolve when there is nothing to draw. */
export function encodeResolveOnly(target: Pick<GaussianEncodeTarget, 'encoder' | 'colorView' | 'resolveTarget'>): void {
  target.encoder.beginRenderPass({
    label: 'ifc-lite-gaussian-resolve',
    colorAttachments: [{ view: target.colorView, resolveTarget: target.resolveTarget, loadOp: 'load', storeOp: target.resolveTarget ? 'discard' : 'store' }],
  }).end();
}

export function unionBounds(bounds: readonly GaussianSplatBounds[]): GaussianSplatBounds | null {
  if (bounds.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of bounds) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis], box.min[axis]);
    max[axis] = Math.max(max[axis], box.max[axis]);
  }
  return { min, max };
}

/** CPU bytes the layer retains for the drawn data: the sort columns only (#9018). */
export function packedCpuBytes(packed: Pick<PackedScene, 'sort'> | null | undefined): number {
  if (!packed) return 0;
  return packed.sort.positions.byteLength + packed.sort.opacities.byteLength + packed.sort.semanticIds.byteLength;
}

/** Diagnostics; cpuBytes counts every CPU byte the layer retains for its assets. */
export function layerStats(
  live: readonly { visible: boolean; count: number }[],
  packed: Pick<PackedScene, 'sort' | 'slices'> | null | undefined, gpuBytes: number, drawnFrames: number, lastEncodeMs: number,
  composition: GaussianCompositionReport,
): GaussianSplatStats {
  return {
    assets: live.length, splats: packed ? [...packed.slices.values()].reduce((sum, slice) => sum + slice.rows, 0) : 0,
    visibleAssetSplats: live.filter((r) => r.visible).reduce((sum, r) => sum + r.count, 0),
    cpuBytes: packedCpuBytes(packed),
    gpuBytes, drawnFrames, lastEncodeMs, composition: composition.composition, compositionReport: composition, clipping: 'centre',
  };
}

export const STATES = Object.freeze({
  invalid: Object.freeze({ state: 'invalid' }) as GaussianSplatState,
  pending: Object.freeze({ state: 'pending' }) as GaussianSplatState,
  resident: Object.freeze({ state: 'resident' }) as GaussianSplatState,
});

export const sameTranslation = (a?: readonly number[], b?: readonly number[]): boolean =>
  (a ?? [0, 0, 0]).every((value, axis) => value === (b ?? [0, 0, 0])[axis]);

/** Null when the visible centre union is unchanged, else the new union (possibly null). */
export function boundsChange(previous: GaussianSplatBounds | null, next: GaussianSplatBounds | null): { next: GaussianSplatBounds | null } | null {
  const same = (a: GaussianSplatBounds, b: GaussianSplatBounds) => [0, 1, 2].every((i) => a.min[i] === b.min[i] && a.max[i] === b.max[i]);
  if (previous === next || (previous && next && same(previous, next))) return null;
  return { next };
}
