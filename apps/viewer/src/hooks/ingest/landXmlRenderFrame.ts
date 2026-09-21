/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';

/**
 * f32 model translations retain roughly 6 cm precision at this distance. A
 * larger render-frame coordinate is refused rather than rendered inaccurately.
 */
export const MAX_RENDER_FRAME_ORIGIN_METRES = 1_000_000;

interface RenderFrameComponent {
  mesh: MeshData;
  bounds: Bounds3D;
}

/** Stable frame chosen during the cursor's geometry-free preflight pass. */
export interface LandXmlRenderFramePlan {
  originShift: { x: number; y: number; z: number };
  hasLargeCoordinates: boolean;
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/** Whether every extent of a source-space component fits after a frame shift. */
export function boundsFitRenderFrame(
  bounds: Bounds3D,
  originShift: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  return [
    bounds.min.x - originShift.x, bounds.min.y - originShift.y, bounds.min.z - originShift.z,
    bounds.max.x - originShift.x, bounds.max.y - originShift.y, bounds.max.z - originShift.z,
  ].every((coordinate) => Number.isFinite(coordinate) && Math.abs(coordinate) <= MAX_RENDER_FRAME_ORIGIN_METRES);
}

/** Place mesh components in one precise shared GPU frame, rejecting distant islands. */
export function deriveLandXmlRenderFrame<T extends RenderFrameComponent>(components: readonly T[]): LandXmlRenderFramePlan {
  const sourceBounds = createEmptyBounds();
  for (const component of components) mergeBounds(sourceBounds, component.bounds);
  const maxAbs = Math.max(
    Math.abs(sourceBounds.min.x), Math.abs(sourceBounds.min.y), Math.abs(sourceBounds.min.z),
    Math.abs(sourceBounds.max.x), Math.abs(sourceBounds.max.y), Math.abs(sourceBounds.max.z),
  );
  const hasLargeCoordinates = maxAbs > 10_000;
  if (!hasLargeCoordinates) {
    return { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates };
  }
  const dominant = components.reduce((best, component) => (
    component.mesh.indices.length > best.mesh.indices.length ? component : best
  ));
  return { originShift: {
    x: (dominant.bounds.min.x + dominant.bounds.max.x) / 2,
    y: (dominant.bounds.min.y + dominant.bounds.max.y) / 2,
    z: (dominant.bounds.min.z + dominant.bounds.max.z) / 2,
  }, hasLargeCoordinates };
}

/** Apply a frame selected by an earlier bounded preflight pass. */
export function placeComponentsInKnownRenderFrame<T extends RenderFrameComponent>(
  components: T[],
  frame: LandXmlRenderFramePlan,
  warnings: string[],
): { placed: T[]; dropped: T[]; bounds: Bounds3D; originShift: { x: number; y: number; z: number }; hasLargeCoordinates: boolean } {
  const originShift = frame.originShift;
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
    warnings.push(`Skipped ${dropped.length} surface component(s) whose full Y-up bounds exceed ${MAX_RENDER_FRAME_ORIGIN_METRES / 1000} km from the model render frame because they cannot be placed precisely`);
  }
  return { placed, dropped, bounds, originShift, hasLargeCoordinates: frame.hasLargeCoordinates };
}

/** Place components using the canonical dominant-component frame policy. */
export function placeComponentsInRenderFrame<T extends RenderFrameComponent>(
  components: T[],
  warnings: string[],
): { placed: T[]; dropped: T[]; bounds: Bounds3D; originShift: { x: number; y: number; z: number }; hasLargeCoordinates: boolean } {
  return placeComponentsInKnownRenderFrame(components, deriveLandXmlRenderFrame(components), warnings);
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
