/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF export coordinate mapping (issue #1861): recovers true IFC world (and,
 * when georeferenced, map/CRS) coordinates from `Drawing2D`'s render-frame
 * drawing space, for a plan ('down') section.
 *
 * `Drawing2D` arrives PRE-MIRRORED on a flipped section: both cutters apply
 * the same U-axis flip before this code ever sees a point — the CPU path via
 * `projectTo2D(point, axis, flipped)` in `math.ts` (`x: flipped ? -u : u`),
 * the GPU path via `gpu-section-cutter.ts`'s `flipU` uniform, which
 * multiplies the projected U coordinate by -1 in the shader before it's
 * written out (`createPlaneData`: `data[6] = config.flipped ? -1.0 : 1.0`).
 * So for a flipped section, `drawing_x = -u` where `u` is the point's true
 * (unflipped) render-frame X; for an unflipped section, `drawing_x = u`.
 *
 * `flipped` exists purely as a *display* convention (which way the plan
 * reads on screen) — it is not a change in where the model actually sits.
 * A georeferenced CAD export must therefore report the SAME world/map
 * coordinate for the same physical point regardless of how the user had the
 * viewer's flip toggle set when they hit "Download DXF". The `(flipped ?
 * -p.x : p.x)` term below is exactly `u = flipped ? -drawing_x :
 * drawing_x)` — it UNDOES the cutter's pre-mirror, not adds a new one. The
 * net effect, by design, is that `buildDxfExportTransform`'s output is
 * flip-invariant: flipped and unflipped exports of the same section produce
 * byte-identical DXF coordinates. (This looks like a bug in isolation — a
 * flip that appears to do nothing — until you know the input was already
 * mirrored; see `dxfExportGeoref.test.ts`'s invariance test.)
 *
 * The render-frame shift (`dxfWorldShift`, shared with the DXF-underlay
 * import path in `dxfUnderlayMath.ts`) is unrelated to the flip and is
 * always undone the same way:
 *
 *   world_x = (flipped ? -drawing_x : drawing_x) + shift.x
 *   world_y = shift.y - drawing_y     // IFC Y (north), metres
 *
 * When the model carries an `IfcMapConversion` (+ `IfcProjectedCRS`), the
 * world point is further projected to map (CRS) coordinates using the same
 * eastings/northings/rotation/scale formula `reproject.ts` uses for the
 * model centre (`computeProjectedCenter`), just evaluated per point instead
 * of once at the bounds centre.
 *
 * Only a plan ('down', non-custom-plane) section has a 2D CAD-meaningful
 * georeference; front/side/custom sections pass through unchanged (per
 * issue #1861: "vertical sections ... export in drawing coordinates").
 *
 * `buildDxfMapToWorldTransform` (issue #1929) is the INVERSE of the
 * georeferenced branch above: it maps map/CRS coordinates (as authored in a
 * surveyor's georeferenced DXF) back to IFC world coordinates, for the DXF
 * UNDERLAY import path (`dxfUnderlayMath.ts`). Because `IfcMapConversion`'s
 * axis vector is normalized to unit length, its rotation matrix is
 * orthonormal — its inverse is its transpose — so the inverse is a
 * closed-form transpose-and-translate, not a division-heavy general
 * inverse. Both directions share the same scale/axis/map-unit resolution
 * (`resolveGeorefLinearParams`) so the two transforms can never disagree
 * about e.g. the Scale=0 or degenerate-axis guards.
 */

/**
 * GUARD PHILOSOPHY, stated explicitly per PR #1965 review: this file
 * (issue #1929) and `hooks/ingest/pointCloudAlignment.ts` (issue #1804)
 * both implement the inverse of `rust/core/src/georef.rs`'s
 * `local_to_map`/`map_to_local` -- now THREE independent TS/Rust copies of
 * the same inverse (Rust, `pointCloudAlignment.ts`, and this file) -- but
 * they diverge on what a malformed `IfcMapConversion` does to the caller:
 *
 *   - `pointCloudAlignment.ts`'s `invertMapConversion` /
 *     `computePointCloudAlignment` return `null` on a degenerate axis or a
 *     ~zero Scale, and the caller hides/disables the alignment toggle
 *     entirely -- there is no un-alignable-but-still-on state.
 *   - This file instead falls back: Scale=0 (or NaN/negative) becomes 1,
 *     a degenerate axis becomes the no-rotation default (1, 0), and the
 *     DXF underlay's "aligned" toggle still seeds on. See
 *     `resolveGeorefLinearParams` below.
 *
 * Both are defensible for where they sit: a point cloud's alignment toggle
 * has an obvious "off" state (raw coordinates, exactly the pre-#1804
 * behaviour) so hiding it on failure costs nothing, whereas a DXF underlay
 * has no equivalently safe fallback transform to fall back TO -- the
 * points still need to land SOMEWHERE, and "some rotation" beats "no
 * rendering at all" for a reference drawing the user can still nudge with
 * the placement offset. This file and `pointCloudAlignment.ts` are each
 * aware the other exists and chose differently on purpose; if you're
 * touching either file's malformed-input handling, check the other one
 * too before assuming your choice generalizes.
 */

import type { Point2D } from '@ifc-lite/drawing-2d';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { dxfWorldShift } from './dxfUnderlayMath';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from '@/lib/geo/geo-scale';
import {
  selectAnchorGeoref,
  type SelectAnchorGeorefParams,
} from '@/lib/geo/useAnchorGeoreference';

/** The subset of `EffectiveGeoreference` the DXF export transform needs. */
export interface DxfExportGeoreference {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
  /** IFC project length-unit → metres (from `IfcUnitAssignment`). */
  lengthUnitScale: number;
}

/**
 * Resolve the georeference a DXF export should target: the federation
 * *anchor* model's effective georef — the file's IfcMapConversion /
 * IfcProjectedCRS merged with any user placement edits. Placement changes
 * applied in `CesiumPlacementEditor` land in the store's `georefMutations`
 * map (keyed by model id, `'__legacy__'` for the single-model store), NOT
 * in `ifcDataStore`, so reading the data store alone exports the original
 * file coordinates while the viewer displays the edited placement (PR
 * #1871 review, P1). Delegates to {@link selectAnchorGeoref} — the exact
 * pinned-anchor / earliest-loaded / legacy-fallback rule ViewportContainer's
 * Cesium georef memo and the measure readout use — so the exported DXF
 * always agrees with the placement the viewer shows, and a georef the user
 * ADDED entirely via the editor (no file georef) is exported too.
 */
export function resolveDxfExportGeoreference(
  params: SelectAnchorGeorefParams,
): DxfExportGeoreference | null {
  const selection = selectAnchorGeoref(params);
  if (!selection) return null;
  const { mapConversion, projectedCRS, lengthUnitScale } = selection.eff;
  return { mapConversion, projectedCRS, lengthUnitScale };
}

export interface DxfExportTransformParams {
  coordinateInfo: GeometryResult['coordinateInfo'] | undefined;
  sectionAxis: 'down' | 'front' | 'side';
  isCustomPlane: boolean;
  flipped: boolean;
  /** Present only when the model has a standard IfcMapConversion + IfcProjectedCRS. */
  georeference?: DxfExportGeoreference | null;
}

/**
 * Build the drawing-space → export-space point transform for DXF export.
 * Plan sections recover true IFC world coordinates (and, when available,
 * project them to map/CRS coordinates); every other section is the
 * identity function.
 */
export function buildDxfExportTransform(params: DxfExportTransformParams): (p: Point2D) => Point2D {
  const { coordinateInfo, sectionAxis, isCustomPlane, flipped, georeference } = params;
  if (sectionAxis !== 'down' || isCustomPlane) {
    return (p) => p;
  }

  const shift = dxfWorldShift(coordinateInfo);
  const toWorld = (p: Point2D): Point2D => ({
    x: (flipped ? -p.x : p.x) + shift.x,
    y: shift.y - p.y,
  });

  if (!georeference) return toWorld;

  const { mapConversion, mapUnitScale, scale, abscissa, ordinate } = resolveGeorefLinearParams(georeference);

  return (p) => {
    const world = toWorld(p);
    return {
      x: mapConversion.eastings * mapUnitScale + scale * (abscissa * world.x - ordinate * world.y),
      y: mapConversion.northings * mapUnitScale + scale * (ordinate * world.x + abscissa * world.y),
    };
  };
}

/**
 * `Number.isFinite(value) ? value : fallback` — the shape shared by the
 * axis-component and eastings/northings NaN/Infinity guards below (PR #1965
 * review). The *reason* each site needs guarding differs (a malformed
 * `XAxisAbscissa`/`XAxisOrdinate` pair vs. a `mergeMapConversion` `?? 0`
 * that stops most NaNs but not all) and stays documented at each call site;
 * this only removes the repeated `Number.isFinite(x) ? x : y` boilerplate.
 */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Shared scale/axis/map-unit resolution for both the forward
 * ({@link buildDxfExportTransform}) and inverse
 * ({@link buildDxfMapToWorldTransform}) georeference transforms — see the
 * module docstring. Keeping this in one place means the Scale=0 and
 * degenerate-axis guards can never drift between the two directions.
 */
function resolveGeorefLinearParams(georeference: DxfExportGeoreference): {
  mapConversion: MapConversion;
  mapUnitScale: number;
  scale: number;
  abscissa: number;
  ordinate: number;
} {
  const { mapConversion, projectedCRS, lengthUnitScale } = georeference;
  const mapUnitScale = resolveMapUnitToMetreScale(projectedCRS.mapUnitScale, lengthUnitScale);
  // Guard the pathological IfcMapConversion.Scale = 0 (or negative/NaN):
  // getEffectiveHorizontalScale passes an explicit 0 through, which would
  // collapse every exported point onto the eastings/northings origin (or,
  // inverted, make every map point resolve to the same world point).
  // Falling back to unscaled (1) keeps the geometry intact, which is
  // strictly less wrong than a single-point result.
  const rawEffectiveScale = getEffectiveHorizontalScale(mapConversion.scale, mapUnitScale, lengthUnitScale);
  const scale = Number.isFinite(rawEffectiveScale) && rawEffectiveScale > 0 ? rawEffectiveScale : 1;
  // IfcMapConversion.XAxisAbscissa/XAxisOrdinate form a direction vector, not
  // necessarily unit length — the IFC spec allows an authoring tool to write
  // any non-zero (cos, sin)-proportional pair. Used raw, a non-unit vector
  // scales the whole transform by its magnitude. Normalize like the Rust
  // source of truth (rust/core/src/georef.rs normalize_axis) for the
  // general and near-zero cases: a near-zero vector (both components ~0)
  // falls back to the no-rotation default (1, 0), matching that function's
  // guard. NOT exact parity for non-finite input, though -- see below.
  //
  // PR #1965 review: `axisLen < 1e-9` alone only catches the near-zero
  // MAGNITUDE case — `NaN < 1e-9` and `Infinity < 1e-9` are both `false`, so
  // a non-finite component used to fall through to the divide branch and
  // manufacture a NaN axis. `finiteOr` closes that before `Math.hypot` ever
  // sees the raw values, same as the eastings/northings guard below.
  //
  // This is a DELIBERATE divergence from `normalize_axis`, not an oversight
  // left over from the "exactly like Rust" framing above: `normalize_axis`
  // tests `len > f64::EPSILON` (also false for NaN) but then *skips*
  // normalization on the degenerate branch, leaving the raw (possibly NaN)
  // value in place -- `local_to_map` would still consume that NaN as
  // cos_r/sin_r. The TS side instead substitutes the no-rotation default
  // BEFORE computing `axisLen`, so a non-finite component here produces a
  // finite (1, 0) fallback rather than propagating NaN, consistent with
  // every other guard in this function (Scale, eastings, northings) always
  // preferring a finite fallback over an exact-parity NaN.
  const rawAbscissa = finiteOr(mapConversion.xAxisAbscissa ?? 1, 1);
  const rawOrdinate = finiteOr(mapConversion.xAxisOrdinate ?? 0, 0);
  const axisLen = Math.hypot(rawAbscissa, rawOrdinate);
  const abscissa = axisLen < 1e-9 ? 1 : rawAbscissa / axisLen;
  const ordinate = axisLen < 1e-9 ? 0 : rawOrdinate / axisLen;
  // Guard eastings/northings against NaN/Infinity the same way the Scale
  // and axis guards above already do (issue #1965 review): a malformed
  // IfcMapConversion's `?? 0` in `mergeMapConversion` (effective-georef.ts)
  // already stops most NaNs before they get here, but this function is the
  // single point both the forward (`buildDxfExportTransform`) and inverse
  // (`buildDxfMapToWorldTransform`) transforms read `mapConversion` through,
  // so guarding here closes the chain regardless of how `georeference` was
  // built. Left un-guarded, a NaN eastings makes every underlay point NaN,
  // which then makes `dxfUnderlayDrawingBounds` return NaN bounds instead of
  // null, which then writes NaN into the stored `placement` via
  // `handleCenterDxfUnderlay` -- a corruption that outlives the toggle.
  const eastings = finiteOr(mapConversion.eastings, 0);
  const northings = finiteOr(mapConversion.northings, 0);
  const safeMapConversion: MapConversion = (eastings === mapConversion.eastings && northings === mapConversion.northings)
    ? mapConversion
    : { ...mapConversion, eastings, northings };
  return { mapConversion: safeMapConversion, mapUnitScale, scale, abscissa, ordinate };
}

/**
 * Build the map/CRS-space → IFC-world-space point transform (issue #1929):
 * the inverse of {@link buildDxfExportTransform}'s georeferenced branch.
 * `null`/undefined `georeference` (no usable IfcMapConversion resolved for
 * the federation anchor) returns the identity function, so a DXF underlay
 * imported before any model with a map conversion loads passes through
 * unchanged — matching the "off" state of the per-underlay toggle.
 *
 * Because the rotation matrix built from (abscissa, ordinate) is
 * orthonormal, its inverse is its transpose:
 *   dE = E - Eastings*mapUnitScale, dN = N - Northings*mapUnitScale
 *   worldX = ( abscissa*dE + ordinate*dN) / scale
 *   worldY = (-ordinate*dE + abscissa*dN) / scale
 * — the exact algebraic inverse of `buildDxfExportTransform`'s
 *   easting  = Eastings*mapUnitScale + scale*(abscissa*worldX - ordinate*worldY)
 *   northing = Northings*mapUnitScale + scale*(ordinate*worldX + abscissa*worldY)
 */
export function buildDxfMapToWorldTransform(
  georeference: DxfExportGeoreference | null | undefined,
): (p: Point2D) => Point2D {
  if (!georeference) return (p) => p;

  const { mapConversion, mapUnitScale, scale, abscissa, ordinate } = resolveGeorefLinearParams(georeference);

  return (p) => {
    const dE = p.x - mapConversion.eastings * mapUnitScale;
    const dN = p.y - mapConversion.northings * mapUnitScale;
    return {
      x: (abscissa * dE + ordinate * dN) / scale,
      y: (-ordinate * dE + abscissa * dN) / scale,
    };
  };
}
