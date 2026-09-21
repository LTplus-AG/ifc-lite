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
 *     in `lib/geo/geo-scale.ts`, and `totalYupOffset` in `lib/geo/coordinate-frame.ts`
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
 * (~0.5-1 m at that magnitude) and defeats the whole feature. Every
 * format decoder narrows straight to f32 (`new Float32Array`), so
 * `decodeOriginOffset` here is threaded through the streaming pipeline
 * (`streamPointCloud` → the decode worker → the format's decoder — LAS,
 * then extended to E57/PLY/PCD/PTS/XYZ) and subtracted in f64 immediately
 * before that narrowing.
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
 * Units (PR #2623 review): LAS/LAZ coordinates are in the projected CRS's
 * native unit (`IfcProjectedCRS.MapUnit`, resolved by
 * `resolveMapUnitToMetreScale`; metres unless the file explicitly says
 * otherwise) — that convention is LAS/LAZ-specific, not shared by any other
 * point-cloud format. Every OTHER format this module supports either
 * mandates metres (E57 cartesian coordinates, ASTM E2807) or has no unit
 * convention at all (PCD/PLY/PTS/XYZ; producing pipelines vary), and this
 * module assumes metres for that second group too — the common case, and
 * the same assumption a bare `raw - offset` with no conversion silently
 * made before this fix, just now stated instead of implied.
 *
 * `computePointCloudAlignment`'s `sourceUnit` parameter selects which of
 * the two conventions the CALLER's format uses, and both `decodeOriginOffset`
 * and the aligned matrix's linear factor `k` are derived consistently for
 * that unit:
 *   - `'mapUnit'` (LAS/LAZ): `decodeOriginOffset` is native-map-unit,
 *     `k = mapUnitScale / effectiveScale` converts native-unit residuals to
 *     viewer metres.
 *   - `'metre'` (E57/PCD/PLY/PTS/XYZ): `decodeOriginOffset` is metres
 *     directly, `k = 1 / effectiveScale` (no further unit conversion —
 *     the residual is already metres).
 * Picking the wrong `sourceUnit` for a format reproduces the exact defect
 * the review caught: a MapUnit-native offset subtracted from a metre-native
 * raw coordinate (or vice versa), landing the cloud thousands of km off for
 * any CRS whose MapUnit isn't already the metre.
 */

import {
  localViewerToProjected,
  projectedToLocalViewer,
  resolveSpatialPlacement,
  type ModelSpatialReference,
  type SpatialAffineTransform,
} from '@ifc-lite/geometry';
import type { ModelSpatialPlacement } from './federationAlign.js';
import { totalYupOffset } from '../../lib/geo/coordinate-frame.js';

export interface MapConversionParams {
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa?: number;
  xAxisOrdinate?: number;
  scale?: number;
  factorX?: number;
  factorY?: number;
  factorZ?: number;
}

/** Convert the legacy IFC-shaped test/input record to the one neutral maths home. */
function spatialReferenceFromMapConversion(params: MapConversionParams): ModelSpatialReference {
  const scale = params.scale ?? 1;
  return {
    source: { axes: ['east', 'up', 'south'], horizontalUnitToMetres: 1, verticalUnitToMetres: 1 },
    localToProjected: {
      kind: 'local-projected-affine',
      eastings: params.eastings,
      northings: params.northings,
      orthogonalHeight: params.orthogonalHeight,
      xAxisAbscissa: params.xAxisAbscissa ?? 1,
      xAxisOrdinate: params.xAxisOrdinate ?? 0,
      scaleX: scale * (params.factorX || 1),
      scaleY: scale * (params.factorY || 1),
      scaleZ: scale * (params.factorZ || 1),
    },
    confidence: 'declared',
  };
}

/** Normalize the (possibly non-unit) XAxisAbscissa/XAxisOrdinate direction
 *  vector to unit length, as `GeoReference::sanitize_transform` in
 *  `rust/core/src/georef.rs` does for a usable axis — IfcMapConversion's axis
 *  attributes form a DIRECTION, and files may author non-unit components.
 *  Returns `null` when the direction is degenerate (both components ~0),
 *  where Rust instead resets the axis to (1, 0). */
function normalizeAxis(rawA: number, rawB: number): { a: number; b: number } | null {
  const len = Math.hypot(rawA, rawB);
  if (len < 1e-9) return null;
  return { a: rawA / len, b: rawB / len };
}

/** A ~0 or non-finite axis scale collapses or poisons that axis. */
function usableScales(s: { x: number; y: number; z: number }): boolean {
  return [s.x, s.y, s.z].every((value) => Number.isFinite(value) && Math.abs(value) >= 1e-12);
}

/**
 * Map local engineering coordinates → map (projected CRS) coordinates.
 * Mirrors `rust/core/src/georef.rs` `GeoReference::local_to_map`:
 *   E = Eastings + a*sx*x - b*sy*y
 *   N = Northings + b*sx*x + a*sy*y
 *   H = OrthogonalHeight + sz*z
 * (a, b) = normalized (XAxisAbscissa, XAxisOrdinate); (sx, sy, sz) =
 * Scale x FactorX/Y/Z, applied before the rotation.
 */
export function applyMapConversion(
  params: MapConversionParams,
  x: number,
  y: number,
  z: number,
): { e: number; n: number; h: number } | null {
  const projected = localViewerToProjected(spatialReferenceFromMapConversion(params), [x, z, -y]);
  return projected ? { e: projected[0], n: projected[1], h: projected[2] } : null;
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
  const local = projectedToLocalViewer(spatialReferenceFromMapConversion(params), [e, n, h]);
  return local ? { x: local[0], y: -local[2], z: local[1] } : null;
}

/**
 * Which unit convention `computePointCloudAlignment`'s caller's point-cloud
 * FORMAT stores raw coordinates in — see the module doc's "Units" section.
 *   - `'mapUnit'`: LAS/LAZ only. Coordinates are in the projected CRS's
 *     native `IfcProjectedCRS.MapUnit`.
 *   - `'metre'`: every other supported format (E57 — spec-mandated; PCD,
 *     PLY, PTS, XYZ — no format convention, metres assumed and documented
 *     here rather than left implicit).
 */
export type PointCloudSourceUnit = 'mapUnit' | 'metre';

export interface PointCloudAlignmentTransform {
  /**
   * (Easting, Northing, OrthogonalHeight)-axis offset, subtracted from raw
   * decoded point coordinates BEFORE narrowing to f32. Threaded through
   * `streamPointCloud`'s `originOffset` option. This is the map-space image
   * of the viewer-frame origin (the map conversion's own offsets PLUS the
   * reference model's RTC/origin shift), so the aligned matrix needs no f32
   * translation at all.
   *
   * Expressed in the unit named by {@link decodeOriginOffsetUnit} — NOT
   * always the map CRS's native unit. See the module doc's "Units" section;
   * this is the exact value PR #2623's review flagged as MapUnit-native
   * regardless of caller format, which is wrong for every format except
   * LAS/LAZ.
   */
  decodeOriginOffset: readonly [number, number, number];
  /**
   * The unit {@link decodeOriginOffset} (and the residual positions the
   * aligned matrix's `k` factor consumes) are expressed in — whichever
   * `sourceUnit` the caller passed to `computePointCloudAlignment`. Carried
   * alongside the offset so a consumer can tell which convention a given
   * transform was computed for without re-deriving it from the caller's
   * format.
   */
  decodeOriginOffsetUnit: PointCloudSourceUnit;
  /**
   * Column-major 4x4 (16 floats, WebGPU/three.js convention: column i at
   * `[4*i .. 4*i+3]`) GPU model matrix mapping decode-shifted,
   * Z-up→Y-up-swapped local point positions into the viewer's render
   * frame. Applied when alignment is ON.
   */
  alignedMatrix: Float32Array | Float64Array;
  /**
   * Column-major 4x4 matrix reproducing the raw/unaligned placement:
   * undoes ONLY the decode-time offset (no rotation, no viewer shift).
   * Applied when the toggle is OFF. Retain the offset in f64 until manual
   * placement is composed; narrowing first would lose fine corrections.
   */
  unalignedMatrix: Float64Array;
}

/**
 * Compute the point-cloud alignment transform for a model's georeference.
 *
 * `georef` is exactly the object `federationAlign.ts`'s
 * `findReferenceSpatialModel()` already resolves for the loaded model
 * (or federation anchor) — the same neutral placement used to align a second
 * federated IFC model into the reference frame. Returns `null` when the
 * conversion is unusable (degenerate axis direction or ~zero scale) so
 * the caller can hide/disable the alignment toggle.
 *
 * `sourceUnit` (PR #2623 review) selects which unit convention the
 * CALLER's point-cloud format stores raw coordinates in — see
 * {@link PointCloudSourceUnit} and the module doc's "Units" section.
 * Defaults to `'mapUnit'` (LAS/LAZ's convention, and this function's
 * behaviour before #2623 threaded alignment to any other format) so every
 * existing single-argument call site keeps its prior numbers unchanged.
 * Callers that ingest E57/PCD/PLY/PTS/XYZ MUST pass `'metre'` explicitly.
 */
export function computePointCloudAlignment(
  placement: ModelSpatialPlacement,
  sourceUnit: PointCloudSourceUnit = 'mapUnit',
  sourceSpatialReference?: ModelSpatialReference,
): PointCloudAlignmentTransform | null {
  const spatialReference = placement.spatialReference;
  const operation = spatialReference.localToProjected;
  const mapUnitScale = typeof spatialReference.sourceMetadata?.mapUnitToMetres === 'number'
    ? spatialReference.sourceMetadata.mapUnitToMetres : 1;
  if (!(mapUnitScale > 0)) return null;
  if (!operation) return null;
  const effectiveScales = { x: operation.scaleX, y: operation.scaleY, z: operation.scaleZ };
  if (!usableScales(effectiveScales)) return null;
  const { x: scaleX, y: scaleY, z: scaleZ } = effectiveScales;
  const rawA = operation.xAxisAbscissa;
  const rawB = operation.xAxisOrdinate;
  const axis = normalizeAxis(rawA, rawB);
  if (!axis) return null;
  const { a, b } = axis;

  const off = totalYupOffset(placement.coordinateInfo);

  // A CRS-bearing scan has its own native axis order and independent
  // horizontal/vertical units. Resolve that native frame through the same
  // neutral f64 placement used by federated models instead of treating every
  // decoder tuple as metre East/North/Height. The target frame offset folds
  // the viewer origin into the decode offset, retaining a zero-translation
  // GPU matrix and therefore sub-centimetre precision at map magnitudes.
  if (sourceSpatialReference) {
    const resolved = resolveSpatialPlacement(sourceSpatialReference, spatialReference, {
      targetFrameOffset: off,
    });
    if (!resolved.ok) return null;
    const projectedOrigin = localViewerToProjected(spatialReference, [0, 0, 0], off);
    const decodeOriginOffset = projectedOrigin
      ? projectedToLocalViewer(sourceSpatialReference, projectedOrigin)
      : null;
    if (!decodeOriginOffset) return null;
    return {
      decodeOriginOffset,
      decodeOriginOffsetUnit: sourceUnit,
      alignedMatrix: matrixFromNativeScanTransform(resolved.placement.sourceToFederation),
      unalignedMatrix: new Float64Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        decodeOriginOffset[0], decodeOriginOffset[2], -decodeOriginOffset[1], 1,
      ]),
    };
  }

  // Fold the ENTIRE viewer shift into the decode-time offset (see module
  // doc, "Precision"): the decode offset is the map-space position of the
  // viewer-frame origin. The viewer origin sits at IFC-local (Z-up,
  // metres) p0 = (off.x, -off.z, off.y) — the Y-up→Z-up unswap of
  // `totalYupOffset` — and `applyMapConversion` (metre-space params,
  // effective scale) is the SAME forward map this module's inverse
  // mirrors, so decode-shifted residuals transform to viewer space with a
  // ZERO translation column. `originMap` is metres (applyMapConversion's
  // params above are metre-scaled). Convert to the CALLER's unit (see
  // module doc, "Units" / PR #2623 review): `'mapUnit'` (LAS/LAZ) divides
  // back to the map CRS's native unit because that's what LAS/LAZ
  // coordinates are stored in; `'metre'` (every other format) keeps it as
  // metres, since none of those formats share LAS/LAZ's MapUnit
  // convention.
  const originMap = localViewerToProjected(spatialReference, [off.x, off.y, off.z]);
  if (!originMap) return null; // conversion was validated above
  const decodeOriginOffset: readonly [number, number, number] = sourceUnit === 'mapUnit'
    ? [originMap[0] / mapUnitScale, originMap[1] / mapUnitScale, originMap[2] / mapUnitScale]
    : [originMap[0], originMap[1], originMap[2]];

  // Aligned matrix operates on (px,py,pz) — the Z-up→Y-up-swapped,
  // decode-time-shifted residual positions the ingest path uploads (see
  // `swapZupChunkToYup` in pointCloudIngest.ts: px=rE, py=rH, pz=-rN,
  // where rE/rN/rH = raw (E,N,H) minus decodeOriginOffset, in whichever
  // unit `sourceUnit` named — native map units for LAS/LAZ, metres for
  // every other format).
  //
  // Map→local in metres (mirrors `invertMapConversion`, with the residual
  // deltas already taken in f64 at decode time):
  //   ifcX = k*(a*rE + b*rN),  ifcY = k*(-b*rE + a*rN),  ifcZ = k*rH
  // where k converts the residual's unit straight to viewer metres:
  //   - 'mapUnit': k = mapUnitScale / effectiveScale (native-unit residual
  //     → metres, then effective scale).
  //   - 'metre': k = 1 / effectiveScale (residual is already metres — the
  //     mapUnitScale factor would double-convert it, reproducing the
  //     PR #2623 review's defect).
  // Converting IFC Z-up → viewer Y-up:
  //   viewer = (ifcX, ifcZ, -ifcY)   [translation ≡ 0 by the fold above]
  // Substituting rE=px, rN=-pz, rH=py:
  //   viewerX = k*a*px - k*b*pz
  //   viewerY = k*py
  //   viewerZ = k*b*px + k*a*pz
  const unitScale = sourceUnit === 'mapUnit' ? mapUnitScale : 1;
  const kx = unitScale / scaleX;
  const ky = unitScale / scaleY;
  const kz = unitScale / scaleZ;
  const alignedMatrix = new Float64Array([
    kx * a, 0, ky * b, 0,
    0, kz, 0, 0,
    -kx * b, 0, ky * a, 0,
    0, 0, 0, 1,
  ]);

  // Unaligned matrix: undo ONLY the decode-time subtraction, in the same
  // swapped Y-up axes (swap(E,N,H) = (E,H,-N)) — no rotation, no unit
  // scaling, no viewer shift. Reproduces the raw native placement
  // (native coordinates rendered 1:1 as viewer units). Compose manual
  // correction in double precision before the renderer narrows to f32.
  const unalignedMatrix = new Float64Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    decodeOriginOffset[0], decodeOriginOffset[2], -decodeOriginOffset[1], 1,
  ]);

  return {
    decodeOriginOffset,
    decodeOriginOffsetUnit: sourceUnit,
    alignedMatrix,
    unalignedMatrix,
  };
}

/** Pack a native XYZ affine for decoder output `(X, Z, -Y)`. */
function matrixFromNativeScanTransform(transform: SpatialAffineTransform): Float64Array {
  return new Float64Array([
    transform.m00, transform.m10, transform.m20, 0,
    transform.m02, transform.m12, transform.m22, 0,
    -transform.m01, -transform.m11, -transform.m21, 0,
    0, 0, 0, 1,
  ]);
}

// ─── per-asset registry (drives the global alignment toggle) ──────────────

export { registerPointCloudAlignment, unregisterPointCloudAlignment, hasRegisteredPointCloudAlignment,
  applyPointCloudAlignmentToggle, retargetPointCloudDecodeOrigin,
  realignRegisteredPointClouds,
  type PointCloudAlignmentRegistration, type PointCloudTransformTarget } from './pointCloudAlignmentRegistry';
