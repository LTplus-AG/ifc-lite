/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';

/**
 * A single LandXML mesh may only span this much in its local f32 vertex
 * buffer. The streaming geometry path partitions bounded mesh data below this
 * emergency envelope. Until every consumer has passed the hardware RTE
 * acceptance witness, a component must also remain within that envelope of
 * the shared frame origin: accepting a compact but arbitrarily remote island
 * would still feed an absolute-f32 consumer elsewhere in the workflow.
 */
export const MAX_RENDER_FRAME_LOCAL_EXTENT_METRES = 1_000_000;

interface RenderFrameComponent {
  mesh: MeshData;
  bounds: Bounds3D;
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/** Whether a component fits one precision-safe local vertex batch and frame. */
export function boundsFitRenderFrame(
  bounds: Bounds3D,
  originShift: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  const coordinates = [
    bounds.min.x, bounds.min.y, bounds.min.z,
    bounds.max.x, bounds.max.y, bounds.max.z,
  ];
  if (!coordinates.every(Number.isFinite) || !Object.values(originShift).every(Number.isFinite)) return false;
  const extentsFit = [
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  ].every((extent) => extent <= MAX_RENDER_FRAME_LOCAL_EXTENT_METRES);
  const frameFit = [
    bounds.min.x - originShift.x, bounds.min.y - originShift.y, bounds.min.z - originShift.z,
    bounds.max.x - originShift.x, bounds.max.y - originShift.y, bounds.max.z - originShift.z,
  ].every((coordinate) => Math.abs(coordinate) <= MAX_RENDER_FRAME_LOCAL_EXTENT_METRES);
  return extentsFit && frameFit;
}

/** Place mesh components in one precise shared GPU frame, rejecting only over-wide local batches. */
export function placeComponentsInRenderFrame<T extends RenderFrameComponent>(
  components: T[],
  warnings: string[],
): { placed: T[]; dropped: T[]; bounds: Bounds3D; originShift: { x: number; y: number; z: number }; hasLargeCoordinates: boolean } {
  const sourceBounds = createEmptyBounds();
  for (const component of components) mergeBounds(sourceBounds, component.bounds);
  const maxAbs = Math.max(
    Math.abs(sourceBounds.min.x), Math.abs(sourceBounds.min.y), Math.abs(sourceBounds.min.z),
    Math.abs(sourceBounds.max.x), Math.abs(sourceBounds.max.y), Math.abs(sourceBounds.max.z),
  );
  const hasLargeCoordinates = maxAbs > 10_000;
  if (!hasLargeCoordinates) {
    return { placed: components, dropped: [], bounds: sourceBounds, originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates };
  }
  const dominant = components.reduce((best, component) => (
    component.mesh.indices.length > best.mesh.indices.length ? component : best
  ));
  const originShift = {
    x: (dominant.bounds.min.x + dominant.bounds.max.x) / 2,
    y: (dominant.bounds.min.y + dominant.bounds.max.y) / 2,
    z: (dominant.bounds.min.z + dominant.bounds.max.z) / 2,
  };
  const placed: T[] = [];
  const dropped: T[] = [];
  const bounds = createEmptyBounds();
  for (const component of components) {
    if (!boundsFitRenderFrame(component.bounds, originShift)) {
      dropped.push(component);
      continue;
    }
    const origin = component.mesh.origin ?? [0, 0, 0];
    component.mesh.origin = [
      origin[0] - originShift.x,
      origin[1] - originShift.y,
      origin[2] - originShift.z,
    ];
    placed.push(component);
    mergeBounds(bounds, component.bounds);
  }
  if (dropped.length > 0) {
    warnings.push(`Skipped ${dropped.length} surface component(s) whose local extent exceeds ${MAX_RENDER_FRAME_LOCAL_EXTENT_METRES / 1000} km; split it into precision-safe render batches`);
  }
  return { placed, dropped, bounds, originShift, hasLargeCoordinates };
}

/** Return one mesh's complete bounds in its current render frame. */
export function meshRenderFrameBounds(mesh: MeshData): Bounds3D | null {
  const origin = mesh.origin ?? [0, 0, 0];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let index = 0; index < mesh.positions.length; index += 3) {
    const x = mesh.positions[index] + origin[0];
    const y = mesh.positions[index + 1] + origin[1];
    const z = mesh.positions[index + 2] + origin[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
  }
  return Number.isFinite(minX)
    ? { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
    : null;
}

/** Whether a mesh's complete render-frame extent remains safe for f32 upload. */
export function meshFitsRenderFrame(mesh: MeshData): boolean {
  const bounds = meshRenderFrameBounds(mesh);
  return bounds !== null && boundsFitRenderFrame(bounds, { x: 0, y: 0, z: 0 });
}
