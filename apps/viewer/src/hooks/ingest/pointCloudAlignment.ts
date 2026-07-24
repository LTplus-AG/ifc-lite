/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud ↔ IfcMapConversion alignment (issue #1804).
 *
 * .laz/.las point clouds carry ABSOLUTE map coordinates (eastings,
 * northings, orthogonal height) — the same "real world" frame an IFC
 * model's `IfcMapConversion` declares for its local engineering
 * coordinates. To render a scan aligned with the model, apply the
 * INVERSE map conversion (map → local) and land the result in the
 * viewer's render frame (RTC/origin-shifted, Y-up).
 *
 * Two layers:
 *   - `invertMapConversion` / `applyMapConversion` — the raw spec-level
 *     math (mirrors `rust/core/src/georef.rs` `map_to_local`/
 *     `local_to_map`), independent of any viewer/unit concerns. Directly
 *     unit-tested for round-trip identity, rotation, non-unit axis
 *     normalization, scale ≠ 1, and the degenerate a=b=0 case.
 *   - `computePointCloudAlignment` — composes that math with the SAME
 *     scale/offset resolution the viewer already uses for federated-model
 *     georef alignment (`getEffectiveHorizontalScale`, `resolveMapUnitToMetreScale`
 *     in `lib/geo/geo-scale.ts`, and `totalYupOffset` in `lib/geo/ifc-origin.ts`
 *     — the canonical wasmRtcOffset + originShift combination). This file
 *     does NOT fork new frame math: the map→local→Y-up→viewer-shift chain
 *     below is the same chain `hooks/ingest/federationAlign.ts`
 *     (`alignGeometryAcrossCrs`) already applies per-vertex when aligning a
 *     second model across CRSs — see that function's comments for the
 *     step-by-step frame diagram this mirrors.
 *
 * Precision (f32 vs f64): map coordinates run ~1e6-1e7 m. Subtracting
 * `Eastings`/`Northings`/`OrthogonalHeight` must happen in f64 BEFORE any
 * f32 narrowing, or the subtraction itself inherits the f32 quantisation
 * (~0.5-1 m at that magnitude) and defeats the whole feature. `las.ts`
 * decode narrows straight to f32 (`new Float32Array`), so
 * `decodeOriginOffset` here is threaded through the streaming pipeline
 * (`streamPointCloud` → the decode worker → `decodeLasPoints`) and
 * subtracted in f64 immediately before that narrowing. Only the residual
 * (small, already-local) rotation/scale/viewer-shift then needs to survive
 * in an f32 GPU uniform matrix — safe, since it's applied to already-small
 * per-vertex positions.
 */

import type { ModelGeoref } from './federationAlign.js';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from '../../lib/geo/geo-scale.js';
import { totalYupOffset } from '../../lib/geo/ifc-origin.js';

export interface MapConversionParams {
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  scale?: number;
}

/** Normalize the (possibly non-unit) XAxisAbscissa/XAxisOrdinate direction
 *  vector to unit length. Mirrors `GeoReference::normalize_axis` in
 *  `rust/core/src/georef.rs` — IfcMapConversion's axis attributes form a
 *  DIRECTION, and files may author non-unit components. Returns `null`
 *  when the direction is degenerate (both components ~0). */
function normalizeAxis(rawA: number, rawB: number): { a: number; b: number } | null {
  const len = Math.hypot(rawA, rawB);
  if (len < 1e-9) return null;
  return { a: rawA / len, b: rawB / len };
}

/**
 * Map local engineering coordinates → map (projected CRS) coordinates.
 * Mirrors `rust/core/src/georef.rs` `GeoReference::local_to_map`:
 *   E = Eastings + Scale*(a*x - b*y)
 *   N = Northings + Scale*(b*x + a*y)
 *   H = OrthogonalHeight + Scale*z
 * (a, b) = normalized (XAxisAbscissa, XAxisOrdinate); Scale applies to
 * all three axes uniformly per the IFC4x3 spec.
 */
export function applyMapConversion(
  params: MapConversionParams,
  x: number,
  y: number,
  z: number,
): { e: number; n: number; h: number } | null {
  const axis = normalizeAxis(params.xAxisAbscissa ?? 1, params.xAxisOrdinate ?? 0);
  if (!axis) return null;
  const scale = params.scale ?? 1;
  const { a, b } = axis;
  return {
    e: params.eastings + scale * (a * x - b * y),
    n: params.northings + scale * (b * x + a * y),
    h: params.orthogonalHeight + scale * z,
  };
}

/**
 * Map (projected CRS) coordinates → local engineering coordinates — the
 * inverse of {@link applyMapConversion}. Mirrors
 * `GeoReference::map_to_local`:
 *   x = ( a*(E-Eastings) + b*(N-Northings)) / Scale
 *   y = (-b*(E-Eastings) + a*(N-Northings)) / Scale
 *   z = (H - OrthogonalHeight) / Scale
 * Returns `null` when the axis direction is degenerate (a=b=0) or Scale
 * is ~0 — both indicate a malformed `IfcMapConversion` the caller should
 * treat as "alignment unavailable", not silently divide by zero.
 */
export function invertMapConversion(
  params: MapConversionParams,
  e: number,
  n: number,
  h: number,
): { x: number; y: number; z: number } | null {
  const axis = normalizeAxis(params.xAxisAbscissa ?? 1, params.xAxisOrdinate ?? 0);
  if (!axis) return null;
  const scale = params.scale ?? 1;
  if (Math.abs(scale) < 1e-12) return null;
  const { a, b } = axis;
  const dE = e - params.eastings;
  const dN = n - params.northings;
  const invScale = 1 / scale;
  return {
    x: invScale * (a * dE + b * dN),
    y: invScale * (-b * dE + a * dN),
    z: invScale * (h - params.orthogonalHeight),
  };
}

export interface PointCloudAlignmentTransform {
  /**
   * Native (Easting, Northing, OrthogonalHeight)-axis offset, in the point
   * cloud's own coordinate space (assumed metres — see module doc), to
   * subtract from raw decoded LAS/LAZ point coordinates BEFORE narrowing
   * to f32. Threaded through `streamPointCloud`'s `originOffset` option.
   */
  decodeOriginOffset: readonly [number, number, number];
  /**
   * Column-major 4x4 (16 floats, WebGPU/three.js convention: column i at
   * `[4*i .. 4*i+3]`) GPU model matrix mapping decode-shifted,
   * Z-up→Y-up-swapped local point positions into the viewer's render
   * frame. Applied when alignment is ON.
   */
  alignedMatrix: Float32Array;
  /**
   * Column-major 4x4 matrix reproducing the raw/unaligned placement:
   * undoes ONLY the decode-time offset (no rotation, no viewer shift).
   * Applied when the toggle is OFF — reproduces the pre-#1804 behaviour
   * (native absolute coordinates, narrowed to f32 at the same point they
   * always were), so disabling alignment is never a regression.
   */
  unalignedMatrix: Float32Array;
}

/**
 * Compute the point-cloud alignment transform for a model's georeference.
 *
 * `georef` is exactly the object `federationAlign.ts`'s
 * `findReferenceGeorefModel()` already resolves for the loaded model
 * (or federation anchor) — the same `ModelGeoref` used to align a second
 * federated IFC model into the reference frame. Returns `null` when the
 * conversion is unusable (degenerate axis direction or ~zero scale) so
 * the caller can hide/disable the alignment toggle.
 */
export function computePointCloudAlignment(georef: ModelGeoref): PointCloudAlignmentTransform | null {
  const conv = georef.mapConversion;
  const lengthUnitScale = georef.lengthUnitScale ?? 1;
  const mapUnitScale = resolveMapUnitToMetreScale(georef.projectedCRS.mapUnitScale, lengthUnitScale);
  const scale = getEffectiveHorizontalScale(conv.scale, mapUnitScale, lengthUnitScale);
  if (Math.abs(scale) < 1e-12) return null;

  const rawA = conv.xAxisAbscissa ?? 1;
  const rawB = conv.xAxisOrdinate ?? 0;
  const axis = normalizeAxis(rawA, rawB);
  if (!axis) return null;
  const { a, b } = axis;

  const eastingsM = conv.eastings * mapUnitScale;
  const northingsM = conv.northings * mapUnitScale;
  const heightM = conv.orthogonalHeight * mapUnitScale;

  const off = totalYupOffset(georef.coordinateInfo);
  const m = 1 / scale;

  // Aligned matrix operates on (px,py,pz) — the Z-up→Y-up-swapped,
  // decode-time-shifted local positions the ingest path uploads (see
  // `swapZupChunkToYup` in pointCloudIngest.ts: px=dE, py=dH, pz=-dN,
  // where dE/dN/dH = raw LAS (E,N,H) minus decodeOriginOffset).
  //
  // invertMapConversion gives: ifcX = m*(a*dE + b*dN), ifcY = m*(-b*dE +
  // a*dN), ifcZ = m*dH. Converting IFC Z-up → viewer Y-up and subtracting
  // the combined RTC/origin shift (totalYupOffset — the SAME wasmRtcOffset
  // + originShift combination `ifc-origin.ts`/`federationAlign.ts` use):
  //   viewer = (ifcX, ifcZ, -ifcY) - off
  // Substituting dE=px, dN=-pz, dH=py:
  //   viewerX = m*a*px - m*b*pz - off.x
  //   viewerY = m*py        - off.y
  //   viewerZ = m*b*px + m*a*pz - off.z
  const alignedMatrix = new Float32Array([
    m * a, 0, m * b, 0,
    0, m, 0, 0,
    -m * b, 0, m * a, 0,
    -off.x, -off.y, -off.z, 1,
  ]);

  // Unaligned matrix: undo ONLY the decode-time subtraction, in the same
  // swapped Y-up axes (swap(E,N,H) = (E,H,-N)) — no rotation, no viewer
  // shift. Reproduces the raw native placement (pre-#1804 behaviour).
  const unalignedMatrix = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    eastingsM, heightM, -northingsM, 1,
  ]);

  return {
    decodeOriginOffset: [eastingsM, northingsM, heightM],
    alignedMatrix,
    unalignedMatrix,
  };
}

// ─── per-asset registry (drives the global alignment toggle) ──────────────

interface RegisteredAlignment {
  handle: { id: number };
  transform: PointCloudAlignmentTransform;
}

/**
 * Every currently-streamed point-cloud asset that has an alignment
 * transform available, keyed by its renderer handle id. All entries share
 * the same `transform` values when they were ingested against the same
 * reference model (IfcMapConversion doesn't vary per scan) — kept
 * per-handle only so the toggle can push each node's matrix individually
 * and so a removed asset can be dropped without affecting the others.
 */
const registry = new Map<number, RegisteredAlignment>();

export function registerPointCloudAlignment(
  handle: { id: number },
  transform: PointCloudAlignmentTransform,
): void {
  registry.set(handle.id, { handle, transform });
}

export function unregisterPointCloudAlignment(handleId: number): void {
  registry.delete(handleId);
}

export function hasRegisteredPointCloudAlignment(): boolean {
  return registry.size > 0;
}

/** Renderer surface this module needs — matches `@ifc-lite/renderer`'s
 *  `Renderer.setPointCloudTransform`. Typed narrowly here so this module
 *  doesn't need to import the whole `Renderer` class. */
export interface PointCloudTransformTarget {
  setPointCloudTransform(handle: { id: number }, matrix: Float32Array | null): void;
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
  for (const { handle, transform } of registry.values()) {
    renderer.setPointCloudTransform(handle, enabled ? transform.alignedMatrix : transform.unalignedMatrix);
  }
}
