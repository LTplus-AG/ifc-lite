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
 * GUARD PHILOSOPHY (PR #1965 review): `../dxfExportGeoref.ts` (issue #1929)
 * implements the SAME inverse map conversion for DXF underlays -- a third
 * copy alongside this file and `rust/core/src/georef.rs` -- but chooses
 * differently on malformed input. `invertMapConversion` /
 * `computePointCloudAlignment` below return `null` on a degenerate axis or
 * ~zero Scale and the caller hides the alignment toggle entirely; DXF
 * export instead falls back to safe defaults (Scale=0→1, degenerate
 * axis→(1,0)) and keeps its toggle available. Both are deliberate for
 * where they sit -- see `dxfExportGeoref.ts`'s "GUARD PHILOSOPHY" comment
 * for the reasoning -- not an inconsistency to fix.
 *
 * Precision (f32 vs f64): map coordinates run ~1e6-1e7 m. Subtracting
 * `Eastings`/`Northings`/`OrthogonalHeight` must happen in f64 BEFORE any
 * f32 narrowing, or the subtraction itself inherits the f32 quantisation
 * (~0.5-1 m at that magnitude) and defeats the whole feature. `las.ts`
 * decode narrows straight to f32 (`new Float32Array`), so
 * `decodeOriginOffset` here is threaded through the streaming pipeline
 * (`streamPointCloud` → the decode worker → `decodeLasPoints`) and
 * subtracted in f64 immediately before that narrowing.
 *
 * The GPU uniform matrix is f32, so its TRANSLATION column must stay small
 * too: a reference model whose IfcMapConversion pairs with large local
 * coordinates (e.g. a file authored directly at Swiss LV95 eastings
 * ~2.6e6 m, where the wasm RTC offset absorbs the magnitude) would put
 * ~1e6-scale values in a `-totalYupOffset` translation, quantising to
 * ~0.25 m and defeating the feature for exactly the files that need it
 * most. So `computePointCloudAlignment` folds the ENTIRE viewer shift into
 * `decodeOriginOffset` — the decode offset is the map-space image
 * (`applyMapConversion`) of the viewer-frame origin, making the aligned
 * matrix's translation column exactly zero. The f32 matrix then carries
 * only rotation + scale, applied to already-small residual positions.
 *
 * Units: LAS/LAZ coordinates are in the projected CRS's native unit
 * (`IfcProjectedCRS.MapUnit`, resolved by `resolveMapUnitToMetreScale`;
 * metres unless the file explicitly says otherwise). `decodeOriginOffset`
 * is therefore expressed in that SAME native unit, and the matrix's
 * linear factor `k = mapUnitScale / effectiveScale` converts residual
 * native units → viewer metres in one multiply.
 */

import type { ModelGeoref } from './federationAlign.js';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from '../../lib/geo/geo-scale.js';
import { effectiveMapConversionForGeometry } from '../../lib/geo/map-absolute.js';
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
  // Reject a ~0 Scale the same way the inverse does. Without this the
  // forward map stays "successful" while collapsing every local point onto
  // (Eastings, Northings, OrthogonalHeight) — a whole cloud silently
  // stacked on one spot reads as a placement bug, where a null reads as
  // the malformed IfcMapConversion it actually is.
  if (Math.abs(scale) < 1e-12) return null;
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
   * (Easting, Northing, OrthogonalHeight)-axis offset in the map CRS's
   * NATIVE unit (the unit LAS/LAZ coordinates are stored in — see module
   * doc), subtracted from raw decoded point coordinates BEFORE narrowing
   * to f32. Threaded through `streamPointCloud`'s `originOffset` option.
   * This is the map-space image of the viewer-frame origin (the map
   * conversion's own offsets PLUS the reference model's RTC/origin
   * shift), so the aligned matrix needs no f32 translation at all.
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
  const lengthUnitScale = georef.lengthUnitScale ?? 1;
  const mapUnitScale = resolveMapUnitToMetreScale(georef.projectedCRS.mapUnitScale, lengthUnitScale);
  if (!(mapUnitScale > 0)) return null;
  // Map-absolute geometry (#2526): a reference model whose geometry already
  // sits at the declared anchor lives in the SAME absolute frame as the scan,
  // so the alignment reduces to the viewer shift alone — inverting the
  // authored conversion would subtract the anchor twice and rotate the cloud
  // off the model it was scanned against.
  const conv = effectiveMapConversionForGeometry(
    georef.mapConversion,
    mapUnitScale,
    georef.coordinateInfo,
  );
  const scale = getEffectiveHorizontalScale(conv.scale, mapUnitScale, lengthUnitScale);
  if (Math.abs(scale) < 1e-12) return null;

  const rawA = conv.xAxisAbscissa ?? 1;
  const rawB = conv.xAxisOrdinate ?? 0;
  const axis = normalizeAxis(rawA, rawB);
  if (!axis) return null;
  const { a, b } = axis;

  const off = totalYupOffset(georef.coordinateInfo);

  // Fold the ENTIRE viewer shift into the decode-time offset (see module
  // doc, "Precision"): the decode offset is the map-space position of the
  // viewer-frame origin. The viewer origin sits at IFC-local (Z-up,
  // metres) p0 = (off.x, -off.z, off.y) — the Y-up→Z-up unswap of
  // `totalYupOffset` — and `applyMapConversion` (metre-space params,
  // effective scale) is the SAME forward map this module's inverse
  // mirrors, so decode-shifted residuals transform to viewer space with a
  // ZERO translation column. Convert the result back to the map CRS's
  // native unit because that's what LAS/LAZ coordinates are stored in.
  const originMap = applyMapConversion(
    {
      eastings: conv.eastings * mapUnitScale,
      northings: conv.northings * mapUnitScale,
      orthogonalHeight: conv.orthogonalHeight * mapUnitScale,
      xAxisAbscissa: a,
      xAxisOrdinate: b,
      scale,
    },
    off.x,
    -off.z,
    off.y,
  );
  if (!originMap) return null; // unreachable: axis validated above
  const decodeOriginOffset: readonly [number, number, number] = [
    originMap.e / mapUnitScale,
    originMap.n / mapUnitScale,
    originMap.h / mapUnitScale,
  ];

  // Aligned matrix operates on (px,py,pz) — the Z-up→Y-up-swapped,
  // decode-time-shifted residual positions the ingest path uploads (see
  // `swapZupChunkToYup` in pointCloudIngest.ts: px=rE, py=rH, pz=-rN,
  // where rE/rN/rH = raw LAS (E,N,H) minus decodeOriginOffset, in native
  // map units).
  //
  // Map→local in metres (mirrors `invertMapConversion`, with the residual
  // deltas already taken in f64 at decode time):
  //   ifcX = k*(a*rE + b*rN),  ifcY = k*(-b*rE + a*rN),  ifcZ = k*rH
  // where k = mapUnitScale / effectiveScale converts native-unit residuals
  // straight to viewer metres. Converting IFC Z-up → viewer Y-up:
  //   viewer = (ifcX, ifcZ, -ifcY)   [translation ≡ 0 by the fold above]
  // Substituting rE=px, rN=-pz, rH=py:
  //   viewerX = k*a*px - k*b*pz
  //   viewerY = k*py
  //   viewerZ = k*b*px + k*a*pz
  const k = mapUnitScale / scale;
  const alignedMatrix = new Float32Array([
    k * a, 0, k * b, 0,
    0, k, 0, 0,
    -k * b, 0, k * a, 0,
    0, 0, 0, 1,
  ]);

  // Unaligned matrix: undo ONLY the decode-time subtraction, in the same
  // swapped Y-up axes (swap(E,N,H) = (E,H,-N)) — no rotation, no unit
  // scaling, no viewer shift. Reproduces the raw native placement
  // (pre-#1804 behaviour: native coordinates rendered 1:1 as viewer
  // units, f32-quantised at map magnitude — bug-compatible by design).
  const unalignedMatrix = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    decodeOriginOffset[0], decodeOriginOffset[2], -decodeOriginOffset[1], 1,
  ]);

  return {
    decodeOriginOffset,
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

/**
 * The transform currently applied to `handleId` on the GPU, or undefined
 * when that asset has no alignment registered.
 *
 * `enabled` must be the live `pointCloudAlignmentEnabled` store flag — the
 * registry deliberately does not cache it, since
 * `applyPointCloudAlignmentToggle` is the single writer that pushes the
 * choice to the renderer.
 *
 * Exists so CPU-side consumers of raw cached scan points (the 2D section
 * scan layer, #1805) can place them where the GPU actually draws them.
 * Without it those consumers read pre-alignment coordinates while the 3D
 * view shows aligned ones.
 *
 * **`outputsRenderFrame` is the part callers get wrong.** The two matrices
 * do not land in the same space:
 *
 * - `alignedMatrix` consumes decode-shifted residuals and, because the
 *   whole viewer shift was folded into `decodeOriginOffset` (zero
 *   translation column), lands DIRECTLY in the viewer render frame. A
 *   caller that then also applies the render-frame shift subtracts it
 *   twice and displaces the result by the model's full RTC/origin offset.
 * - `unalignedMatrix` restores the raw native placement instead, so its
 *   output is absolute and still needs the usual world -> render-frame
 *   shift.
 */
export interface AppliedPointCloudTransform {
  matrix: Float32Array;
  /** True when `matrix` already lands in the viewer render frame, so no
   *  further render-frame shift may be applied. */
  outputsRenderFrame: boolean;
}

export function getPointCloudAlignmentMatrix(
  handleId: number,
  enabled: boolean,
): AppliedPointCloudTransform | undefined {
  const entry = registry.get(handleId);
  if (!entry) return undefined;
  return enabled
    ? { matrix: entry.transform.alignedMatrix, outputsRenderFrame: true }
    : { matrix: entry.transform.unalignedMatrix, outputsRenderFrame: false };
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
