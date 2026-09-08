/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turn the viewer's section-plane STATE into the half-space the CPU clip keeps
 * (#2042).
 *
 * DEFECT CLASS — keeping the half the screen throws away. The on-screen cut is
 * a fragment discard in `main.wgsl.ts`:
 *
 *   side = flipped ? -1 : 1
 *   discard when (dot(worldPos, normal) - distance) * side > 0
 *
 * i.e. the KEPT half is `dot(p, n) <= d` unflipped and `dot(p, n) >= d`
 * flipped. `clipMeshToHalfSpace` keeps `dot(p, normal) <= offset` and has no
 * flip concept, so the flipped case has to arrive as the NEGATED plane
 * (`-n`, `-d`). Get that sign wrong and the export is not subtly off: it prints
 * exactly the half the user cut away, while every number on the page is
 * dimensionally perfect. Nothing downstream can detect it — the drawing, the
 * layout and the scale are all self-consistent about the wrong geometry.
 *
 * The `normal`/`distance` derivation mirrors `resolveSectionPlaneFrame`
 * (`packages/renderer/src/render-section-plane.ts`) branch for branch: the
 * explicit face-picked plane used verbatim with a defensive renormalisation,
 * otherwise the cardinal axis rotated by the building rotation, with the plane
 * distance interpolated across the range the slider travels. The `dot`-over-
 * eight-corners range is that file's `projectedBoundsRange`, restated here
 * rather than imported because `@ifc-lite/renderer` publishes only its index
 * and widening a published package's surface for one internal consumer costs a
 * changeset plus an API-surface snapshot (#2447 documents why the range must be
 * measured along the CUTTING normal and not along the cardinal axis it came
 * from: on a rotated building an axis extent leaves an unreachable wedge at
 * each end of the slider).
 *
 * ACCEPTED RESIDUAL: the percentage resolves against the bounds the caller
 * supplies (`Camera.getSceneBounds()`, which mirrors `Renderer.modelBounds`)
 * rather than against the batched-mesh bounds recomputed inside the frame. The
 * two agree for any settled scene; they can differ mid-stream, in which case
 * the exported cut sits a fraction of the model off the on-screen one.
 */

import type { Vec3, WorldBounds3D } from '@ifc-lite/drawing-2d';

/** Semantic cut direction, as `SectionPlane.axis` stores it. */
export type ViewSectionAxis = 'down' | 'front' | 'side';

/** The part of the store's `sectionPlane` the clip actually needs. */
export interface ViewSectionPlaneState {
  axis: ViewSectionAxis;
  /** Slider position, 0-100 percent of the range along the cut normal. */
  position: number;
  /** Which half survives. See the module docblock. */
  flipped: boolean;
  /** Face-picked arbitrary plane (#243). Used verbatim when present. */
  custom?: { normal: [number, number, number]; distance: number };
}

export interface ViewSectionResolveInput {
  plane: ViewSectionPlaneState;
  /**
   * World AABB the slider percentage is expressed against
   * (`Camera.getSceneBounds()`).
   */
  sceneBounds: WorldBounds3D;
  /** `coordinateInfo.buildingRotation` (radians about world Y), if any. */
  buildingRotation?: number;
  /**
   * The UI's own slider range along the cardinal axis
   * (`coordinateInfo.shiftedBounds[axis]`), honoured under exactly the
   * renderer's guard: only while the resolved normal is still the positive
   * unit axis the override is expressed along, and only when it lies inside
   * the projected range. Anything else compares metres-along-an-axis with a
   * distance-along-a-tilted-normal (#2447).
   */
  uiRange?: { min: number; max: number } | null;
}

/** A half-space in `clipMeshToHalfSpace` terms: keep `dot(p, normal) <= offset`. */
export interface KeptHalfSpace {
  normal: Vec3;
  offset: number;
}

/** Plane in shader terms: discard where `dot(p, normal) > distance` (unflipped). */
interface ShaderPlane {
  normal: [number, number, number];
  distance: number;
}

/** Below this the plane is degenerate and the renderer falls back to world +Y. */
const MIN_NORMAL_LENGTH = 1e-6;
/** The renderer's own post-rotation renormalisation threshold. */
const MIN_ROTATED_LENGTH = 0.0001;

/**
 * The half-space the on-screen cut keeps, ready to hand to
 * `clipMeshToHalfSpace` / `clipMeshesToHalfSpace`.
 */
export function resolveKeptHalfSpace(input: ViewSectionResolveInput): KeptHalfSpace {
  const { normal, distance } = resolveShaderPlane(input);
  // The flip is applied to the PLANE, not to a comparison operator, because
  // the clip helper only knows one direction. Negating both sides of
  // `dot(p, n) >= d` gives `dot(p, -n) <= -d` — the same half, expressed the
  // one way the clip can consume.
  return input.plane.flipped
    ? { normal: { x: -normal[0], y: -normal[1], z: -normal[2] }, offset: -distance }
    : { normal: { x: normal[0], y: normal[1], z: normal[2] }, offset: distance };
}

function resolveShaderPlane(input: ViewSectionResolveInput): ShaderPlane {
  const custom = input.plane.custom;
  const hasExplicitPlane =
    custom !== undefined &&
    Number.isFinite(custom.distance) &&
    Number.isFinite(custom.normal[0]) &&
    Number.isFinite(custom.normal[1]) &&
    Number.isFinite(custom.normal[2]);

  if (hasExplicitPlane && custom) {
    const [nx, ny, nz] = custom.normal;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    // Finite components are not enough: 1e200 squares to Infinity, so `len`
    // can overflow while every component passed the check above (#2442). Both
    // the overflow and the near-zero vector take the renderer's documented
    // world-+Y fallback rather than emitting a NaN plane.
    if (Number.isFinite(len) && len > MIN_NORMAL_LENGTH) {
      return { normal: [nx / len, ny / len, nz / len], distance: custom.distance / len };
    }
    return { normal: [0, 1, 0], distance: custom.distance };
  }

  return resolveCardinalPlane(input);
}

function resolveCardinalPlane(input: ViewSectionResolveInput): ShaderPlane {
  const axisComponent = cardinalAxisComponent(input.plane.axis);
  const normal: [number, number, number] = [0, 0, 0];
  normal[axisComponent] = 1;

  // Building rotation is about world Y (IFC Z-up becomes WebGL Y-up), so it
  // moves X and Z and leaves the 'down' axis fixed. A non-finite angle
  // degrades to no rotation — the cardinal preset the axis already describes
  // (#2442: a malformed IfcDirection parses to `inf` and `atan2` returns NaN,
  // which no guard on the way here filters).
  const rotation = input.buildingRotation;
  if (rotation !== undefined && rotation !== 0 && Number.isFinite(rotation)) {
    const cosR = Math.cos(rotation);
    const sinR = Math.sin(rotation);
    const x = normal[0];
    const z = normal[2];
    normal[0] = x * cosR - z * sinR;
    normal[2] = x * sinR + z * cosR;
    const rlen = Math.sqrt(normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2);
    if (rlen > MIN_ROTATED_LENGTH) {
      normal[0] /= rlen;
      normal[1] /= rlen;
      normal[2] /= rlen;
    }
  }

  const projected = projectedBoundsRange(input.sceneBounds, normal);
  let minVal = projected.min;
  let maxVal = projected.max;

  const uiMin = input.uiRange?.min;
  const uiMax = input.uiRange?.max;
  if (
    overrideUnitsMatch(normal, axisComponent) &&
    uiMin !== undefined &&
    uiMax !== undefined &&
    Number.isFinite(uiMin) &&
    Number.isFinite(uiMax) &&
    uiMax - uiMin > 1e-6 &&
    uiMin >= minVal - 1e-3 &&
    uiMax <= maxVal + 1e-3
  ) {
    minVal = uiMin;
    maxVal = uiMax;
  }

  return { normal, distance: minVal + (input.plane.position / 100) * (maxVal - minVal) };
}

/** `side` -> X, `down` -> Y, `front` -> Z, exactly as the shader preset maps them. */
function cardinalAxisComponent(axis: ViewSectionAxis): 0 | 1 | 2 {
  if (axis === 'side') return 0;
  if (axis === 'down') return 1;
  return 2;
}

/** True while the resolved normal is still the positive unit axis the UI range is expressed along. */
function overrideUnitsMatch(normal: readonly number[], axisComponent: number): boolean {
  return (
    Math.abs(normal[axisComponent] - 1) <= 1e-6 &&
    Math.abs(normal[(axisComponent + 1) % 3]) <= 1e-6 &&
    Math.abs(normal[(axisComponent + 2) % 3]) <= 1e-6
  );
}

/**
 * Min/max of `dot(corner, normal)` over an AABB's eight corners — the distance
 * range the section slider travels over, because the plane is
 * `dot(worldPos, normal) = distance`.
 *
 * Collapses bit-for-bit to the axis extent when `normal` IS a unit axis
 * (`x * 1 + y * 0 + z * 0 === x` for finite inputs), so unrotated models get
 * the same numbers the simpler reading would have produced.
 */
function projectedBoundsRange(
  bounds: WorldBounds3D,
  normal: readonly [number, number, number],
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const d = x * normal[0] + y * normal[1] + z * normal[2];
        if (d < min) min = d;
        if (d > max) max = d;
      }
    }
  }
  return { min, max };
}
