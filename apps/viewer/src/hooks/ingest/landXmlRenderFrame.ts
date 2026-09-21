/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { createEmptyBounds, type Bounds3D } from '../../utils/localParsingUtils.js';

/**
 * A single LandXML mesh may only span this much in its local f32 vertex
 * buffer. The streaming geometry path partitions bounded mesh data below this
 * emergency envelope. A component must also remain within that envelope of
 * the shared frame origin. Its own span is deliberately not a federation
 * refusal: wide components are partitioned by the precision pipeline, and a
 * [-750 km, +750 km] component is valid relative to the shared frame.
 */
export const MAX_RENDER_FRAME_LOCAL_EXTENT_METRES = 1_000_000;
/** Current name retained by federation callers; see the local-extent note above. */
export const MAX_RENDER_FRAME_ORIGIN_METRES = MAX_RENDER_FRAME_LOCAL_EXTENT_METRES;

interface RenderFrameComponent {
  mesh: MeshData;
  bounds: Bounds3D;
  /** Components split from one connected surface must be accepted atomically. */
  frameGroup?: string;
}

function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

/** Whether a component lies inside the shared render-frame acceptance envelope. */
export function boundsFitRenderFrame(
  bounds: Bounds3D,
  originShift: Readonly<{ x: number; y: number; z: number }>,
): boolean {
  const coordinates = [
    bounds.min.x, bounds.min.y, bounds.min.z,
    bounds.max.x, bounds.max.y, bounds.max.z,
  ];
  if (!coordinates.every(Number.isFinite) || !Object.values(originShift).every(Number.isFinite)) return false;
  const frameFit = [
    bounds.min.x - originShift.x, bounds.min.y - originShift.y, bounds.min.z - originShift.z,
    bounds.max.x - originShift.x, bounds.max.y - originShift.y, bounds.max.z - originShift.z,
  ].every((coordinate) => Math.abs(coordinate) <= MAX_RENDER_FRAME_LOCAL_EXTENT_METRES);
  return frameFit;
}

/**
 * Parser components are one GPU mesh today, so an unpartitioned connected
 * component still needs a bounded local extent. This is deliberately separate
 * from `boundsFitRenderFrame`: a wide component may fit a shared frame once
 * the precision pipeline has partitioned it, but raw connected geometry cannot
 * be narrowed safely by merely changing its origin.
 */
function componentFitsPrecisionBatch(bounds: Bounds3D): boolean {
  const span = Math.max(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  return Number.isFinite(span) && span <= MAX_RENDER_FRAME_LOCAL_EXTENT_METRES;
}

/**
 * Place parsed mesh components in their model-local frame.
 *
 * Initial ingestion retains disconnected survey islands: their mesh origins
 * stay f64 until the renderer establishes a camera-relative draw frame. The
 * bounded shared-frame guard belongs to federation reframe
 * (`reframeLandXmlGeometry`), where a second model would otherwise silently
 * move an already-published frame. Keeping those responsibilities separate
 * preserves compact disconnected components without admitting a remote
 * federated model.
 */
export function placeComponentsInRenderFrame<T extends RenderFrameComponent>(
  components: T[],
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
  const rejectedGroups = new Set(components
    .filter((component) => !componentFitsPrecisionBatch(component.bounds))
    .map((component) => component.frameGroup)
    .filter((group): group is string => group !== undefined));
  for (const component of components) {
    if (!componentFitsPrecisionBatch(component.bounds)
      || (component.frameGroup !== undefined && rejectedGroups.has(component.frameGroup))) {
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
