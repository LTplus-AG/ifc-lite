/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where every section plane is in the scene (#7545), for the UI to mark it.
 *
 * The renderer resolves a cardinal plane's slider percentage into a world plane
 * (its own bounds, the building rotation); nothing outside it can do that
 * exactly. So the viewer's name tags, outlines and drag handle ask for the
 * planes' world-space frames, resolved the way the last frame resolved them.
 * Pure: it holds no GPU object.
 */

import { planeBasis } from './section-plane-basis.js';
import { resolveSectionPlaneGeometry } from './section-plane-resolve.js';
import type { SectionPlane } from './types.js';

type Xyz = { x: number; y: number; z: number };

/** One section plane in world space. */
export interface SectionPlaneFrame {
  /** The plane's `id`, when it has one (the primary plane's too). */
  id: string | null;
  /** True for `RenderOptions.sectionPlane`; false for an entry of `extraSectionPlanes`. */
  primary: boolean;
  enabled: boolean;
  flipped: boolean;
  /** Unit normal, and `dot(p, normal) = distance` on the plane. */
  normal: [number, number, number];
  distance: number;
  /** The model's centre projected onto the plane: where a handle sits. */
  anchor: [number, number, number];
  /**
   * A square on the plane the clip uses (centred on `anchor`, sized from the model bounds), in winding
   * order. It lies in the clipping plane exactly; the drawn preview quad of a rotated cardinal plane
   * is axis-aligned instead, so place marks from `anchor` and the plane, not by matching that quad.
   */
  corners: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
}

/** The inputs a frame was resolved from, kept by the renderer for the next query. */
export interface SectionFrameInput {
  primary: SectionPlane | null;
  extras: readonly SectionPlane[];
  bounds: { min: Xyz; max: Xyz };
  buildingRotation: number | undefined;
}

/** The anchor and quad of `dot(p, normal) = distance` across `bounds`, matching the preview quad's size. */
export function planeFrameGeometry(
  normal: readonly [number, number, number],
  distance: number,
  bounds: { min: Xyz; max: Xyz },
): { anchor: [number, number, number]; corners: SectionPlaneFrame['corners'] } {
  const [nx, ny, nz] = normal;
  const { min, max } = bounds;
  const cx = (min.x + max.x) / 2;
  const cy = (min.y + max.y) / 2;
  const cz = (min.z + max.z) / 2;
  const k = distance - (cx * nx + cy * ny + cz * nz);
  const anchor: [number, number, number] = [cx + nx * k, cy + ny * k, cz + nz * k];
  const { tangent: t, bitangent: b } = planeBasis([nx, ny, nz]);
  const half = 0.55 * Math.hypot(max.x - min.x, max.y - min.y, max.z - min.z);
  const corner = (st: number, sb: number): [number, number, number] => [
    anchor[0] + t[0] * half * st + b[0] * half * sb,
    anchor[1] + t[1] * half * st + b[1] * half * sb,
    anchor[2] + t[2] * half * st + b[2] * half * sb,
  ];
  return { anchor, corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] };
}

/** Every plane of `input`, enabled or not, primary first. Seven extras at most, as the renderer clips. */
export function resolveSectionPlaneFrames(input: SectionFrameInput): SectionPlaneFrame[] {
  const frames: SectionPlaneFrame[] = [];
  const add = (plane: SectionPlane, primary: boolean): void => {
    const { normal, distance } = resolveSectionPlaneGeometry(plane, input.bounds.min, input.bounds.max, input.buildingRotation);
    frames.push({
      id: plane.id ?? null, primary, enabled: plane.enabled, flipped: plane.flipped === true,
      normal, distance, ...planeFrameGeometry(normal, distance, input.bounds),
    });
  };
  if (input.primary) add(input.primary, true);
  for (const plane of input.extras.slice(0, 7)) add(plane, false);
  return frames;
}
