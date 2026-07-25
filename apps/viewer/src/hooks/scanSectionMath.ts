/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point-cloud "scan" layer for the 2D section view (issue #1805).
 *
 * Selects the points within a configurable band/thickness around the active
 * section plane, projects them into the same 2D "drawing space" the section
 * cutter emits for `Drawing2D.lines` / `cutPolygons`, and decimates the
 * result to a sane render cap. Pure, store-free, and unit-tested — the
 * `useScanSectionLayer` hook wires it to the viewer store.
 *
 * ── Coordinate pipeline ──────────────────────────────────────────────────
 * Point-cloud positions arrive from `@ifc-lite/pointcloud` decoders in the
 * file's native Z-up frame, swapped to the renderer's Y-up convention by
 * `swapZupChunkToYup` (`hooks/ingest/pointCloudIngest.ts`) — but, unlike
 * mesh geometry, WITHOUT the RTC/origin-shift baked in: mesh vertices are
 * re-based near the origin by WASM before `GeometryResult.meshes` ships, so
 * `coordinateInfo.shiftedBounds` and the section plane's `position` already
 * live in that shifted "render frame". Point clouds need one more step to
 * land in the same frame.
 *
 * `pointCloudRenderFrameShift` derives that step from the exact relationship
 * `apps/viewer/src/lib/geo/reproject.ts` (`computeModelCenterInIfcMeters`)
 * documents as ground truth:
 *
 *   world_yup = render + originShift + rtc_as_yup,  rtc_as_yup = (rtc.x, rtc.z, -rtc.y)
 *
 * so `render = world_yup - originShift - rtc_as_yup`. Restricted to the plan
 * (x, z) pair this is IDENTICAL to `dxfWorldShift` in `hooks/dxfUnderlayMath.ts`
 * — the DXF-underlay precedent this module follows — which
 * `scanSectionMath.test.ts` cross-checks so the two can't silently drift.
 * This module is the 3D generalisation DXF underlays never needed (they're
 * plan-only); it doesn't replace `dxfWorldShift`, it extends the same
 * formula to the elevation axis for vertical (front/side) sections.
 *
 * Once in the render frame, projection reuses `projectTo2D` /
 * `projectTo2DBasis` from `@ifc-lite/drawing-2d` — the SAME functions
 * `section-cutter.ts` (CPU path) and the WASM GPU cutter's `projectTo2D`
 * (`gpu-section-cutter.ts`) use to produce `drawing.lines` / `cutPolygons`.
 * That means scan dots land directly in the drawing's native coordinate
 * space with no extra mirroring step — `Drawing2DCanvas` can draw them with
 * the exact same screen transform it already uses for the cut geometry.
 */

import {
  getAxisNormal,
  projectTo2D,
  projectTo2DBasis,
  signedDistanceToPlane,
  type Point2D,
  type Vec3,
} from '@ifc-lite/drawing-2d';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { isPointCloudClassVisible } from '@/store/slices/pointCloudSlice';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Default slab thickness (metres) around the section plane. */
export const DEFAULT_SCAN_SECTION_THICKNESS = 0.3;
/** Slider bounds (metres) for the thickness control. */
export const SCAN_SECTION_THICKNESS_MIN = 0.02;
export const SCAN_SECTION_THICKNESS_MAX = 2.0;
/** Default render decimation cap — points beyond this are strided out. */
export const DEFAULT_SCAN_RENDER_CAP = 500_000;
/** Hard cap for SVG export — keeps exported files a sane size. */
export const DEFAULT_SCAN_SVG_CAP = 20_000;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type ScanSectionAxis = 'x' | 'y' | 'z';

/** Face-picked custom cut plane, same shape `useDrawingGeneration` builds. */
export interface ScanCustomPlane {
  normal: readonly [number, number, number];
  distance: number;
  origin: readonly [number, number, number];
  tangent: readonly [number, number, number];
  bitangent: readonly [number, number, number];
}

/** The active section cut, reduced to what the scan layer needs. */
export interface ScanSectionPlane {
  axis: ScanSectionAxis;
  /** Cardinal plane position in shifted-render-frame metres (ignored when `custom` is set). */
  position: number;
  /** Mirrors the cutter's U-axis flip; irrelevant to band membership, only to projection. */
  flipped: boolean;
  custom?: ScanCustomPlane;
}

/** One point cloud's retained CPU-side sample, in raw (unshifted) Y-up frame. */
export interface ScanPointSample {
  /** [x0,y0,z0, x1,y1,z1, ...], length >= count*3. */
  positions: Float32Array;
  /** RGB per point — Uint8Array (0..255) or Float32Array (0..1); absent → no colour. */
  colors?: Uint8Array | Float32Array | null;
  /** Per-point LAS classification (0..255); absent → treated as always-visible. */
  classifications?: Uint8Array | null;
  count: number;
}

export interface ScanBandPoint {
  point: Point2D;
  /** RGB in 0..1, present only when the source sample carried colour. */
  color?: readonly [number, number, number];
}

export interface ScanBandSelection {
  points: ScanBandPoint[];
  /** Points passing the band + class-mask test, before decimation. */
  totalInBand: number;
  /** `points.length` — equals `totalInBand` when no decimation was needed. */
  renderedCount: number;
  /** Deterministic keep-every-Nth stride applied (1 = no decimation). */
  stride: number;
}

export interface SelectScanBandParams {
  sample: ScanPointSample;
  coordinateInfo: CoordinateInfo | undefined;
  plane: ScanSectionPlane;
  /** Full slab thickness in metres — band is `position ± thickness/2`. */
  thickness: number;
  /** 8-word LAS class-visibility mask (see `pointCloudSlice.ts`). Omitted = all visible. */
  classMask?: readonly number[];
  /** Cap on rendered (post-decimation) point count. */
  maxRendered?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// RENDER-FRAME SHIFT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The Y-up vector to SUBTRACT from a raw (Z-up-swapped-to-Y-up) point-cloud
 * position to land it in the render frame meshes/section planes use.
 *
 * Derived from `reproject.ts`'s `world_yup = render + originShift + rtc_as_yup`
 * (rtc_as_yup = (rtc.x, rtc.z, -rtc.y)): `render = world_yup - originShift - rtc_as_yup`,
 * i.e. the vector below is `originShift + rtc_as_yup` component-wise.
 *
 * Known limitation: this assumes the point cloud was authored in the SAME
 * IFC-world coordinate system as the model (the common case — a scan
 * registered to match the building). It does not independently re-register a
 * georeferenced scan; that already holds for the 3D viewport today (point
 * clouds get no RTC/origin-shift treatment on ingest — see
 * `hooks/ingest/pointCloudIngest.ts`), so the 2D scan layer is consistent
 * with 3D, not a regression.
 */
export function pointCloudRenderFrameShift(coordinateInfo: CoordinateInfo | undefined): Vec3 {
  const rtc = coordinateInfo?.wasmRtcOffset;
  const shift = coordinateInfo?.originShift;
  return {
    x: (rtc?.x ?? 0) + (shift?.x ?? 0),
    y: (rtc?.z ?? 0) + (shift?.y ?? 0),
    z: -(rtc?.y ?? 0) + (shift?.z ?? 0),
  };
}

/** Apply {@link pointCloudRenderFrameShift} to one point. */
export function toRenderFrame(p: Vec3, shift: Vec3): Vec3 {
  return { x: p.x - shift.x, y: p.y - shift.y, z: p.z - shift.z };
}

// ═══════════════════════════════════════════════════════════════════════════
// BAND TEST + PROJECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Signed distance from a render-frame point to the section plane.
 * Band membership doesn't care about `flipped` — flip only mirrors the U
 * axis of the projected 2D output, not which points are "in" the slab.
 */
export function signedBandDistance(p: Vec3, plane: ScanSectionPlane): number {
  if (plane.custom) {
    const n: Vec3 = { x: plane.custom.normal[0], y: plane.custom.normal[1], z: plane.custom.normal[2] };
    return signedDistanceToPlane(p, n, plane.custom.distance);
  }
  return signedDistanceToPlane(p, getAxisNormal(plane.axis, false), plane.position);
}

export function isPointInBand(p: Vec3, plane: ScanSectionPlane, thickness: number): boolean {
  return Math.abs(signedBandDistance(p, plane)) <= Math.max(thickness, 0) / 2;
}

/**
 * Project a render-frame point into 2D drawing space — the SAME function
 * (and, for cardinal axes, the same `flipped` U-mirror) `section-cutter.ts`
 * uses for the cut geometry itself, so the result composites directly with
 * `drawing.lines` / `cutPolygons` with no extra transform.
 */
export function projectScanPoint(p: Vec3, plane: ScanSectionPlane): Point2D {
  if (plane.custom) {
    const origin: Vec3 = { x: plane.custom.origin[0], y: plane.custom.origin[1], z: plane.custom.origin[2] };
    const tangent: Vec3 = { x: plane.custom.tangent[0], y: plane.custom.tangent[1], z: plane.custom.tangent[2] };
    const bitangent: Vec3 = { x: plane.custom.bitangent[0], y: plane.custom.bitangent[1], z: plane.custom.bitangent[2] };
    return projectTo2DBasis(p, origin, tangent, bitangent);
  }
  return projectTo2D(p, plane.axis, plane.flipped);
}

// ═══════════════════════════════════════════════════════════════════════════
// BAND SELECTION (band test + class-mask filter + deterministic decimation)
// ═══════════════════════════════════════════════════════════════════════════

function readColor(
  colors: Uint8Array | Float32Array | null | undefined,
  i: number,
): readonly [number, number, number] | undefined {
  if (!colors) return undefined;
  if (colors instanceof Float32Array) {
    return [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]];
  }
  return [colors[i * 3] / 255, colors[i * 3 + 1] / 255, colors[i * 3 + 2] / 255];
}

/**
 * Select the points of `sample` within the section band, honour the LAS
 * class-visibility mask, and decimate to `maxRendered` with a deterministic
 * "keep every Nth in-band point" stride — reproducible across calls and
 * independent of point order (a first pass counts matches before the
 * stride is chosen, so the same input always yields the same output).
 *
 * Two O(n) passes over `sample.positions` (count, then collect); cheap even
 * at a few million retained points and meant to run off the render hot path
 * (debounced on section-plane changes), not per frame.
 */
export function selectScanBand(params: SelectScanBandParams): ScanBandSelection {
  const { sample, coordinateInfo, plane, thickness, classMask, maxRendered = DEFAULT_SCAN_RENDER_CAP } = params;
  const { positions, colors, classifications, count } = sample;
  const shift = pointCloudRenderFrameShift(coordinateInfo);
  const halfThickness = Math.max(thickness, 0) / 2;

  const passesClassMask = (i: number): boolean => {
    if (!classMask || !classifications) return true;
    return isPointCloudClassVisible(classMask, classifications[i]);
  };
  const inBand = (i: number): boolean => {
    const p: Vec3 = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
    const rp = toRenderFrame(p, shift);
    return Math.abs(signedBandDistance(rp, plane)) <= halfThickness;
  };

  let totalInBand = 0;
  for (let i = 0; i < count; i++) {
    if (!passesClassMask(i)) continue;
    if (inBand(i)) totalInBand++;
  }

  const stride = totalInBand > maxRendered && maxRendered > 0
    ? Math.ceil(totalInBand / maxRendered)
    : 1;

  const points: ScanBandPoint[] = [];
  let matchIndex = -1;
  for (let i = 0; i < count; i++) {
    if (!passesClassMask(i)) continue;
    const p: Vec3 = { x: positions[i * 3], y: positions[i * 3 + 1], z: positions[i * 3 + 2] };
    const rp = toRenderFrame(p, shift);
    if (Math.abs(signedBandDistance(rp, plane)) > halfThickness) continue;
    matchIndex++;
    if (matchIndex % stride !== 0) continue;
    points.push({ point: projectScanPoint(rp, plane), color: readColor(colors, i) });
  }

  return { points, totalInBand, renderedCount: points.length, stride };
}

/**
 * Merge several assets' selections into one (used when >1 scan is loaded).
 * `stride` reports the largest per-asset stride applied, for the UI's
 * "showing N of M points" readout — each asset already decimated itself
 * independently, so this is informational only, not a re-appliable factor.
 */
export function mergeScanBandSelections(selections: readonly ScanBandSelection[]): ScanBandSelection {
  let totalInBand = 0;
  let renderedCount = 0;
  let maxStride = 1;
  const points: ScanBandPoint[] = [];
  for (const sel of selections) {
    totalInBand += sel.totalInBand;
    renderedCount += sel.renderedCount;
    if (sel.stride > maxStride) maxStride = sel.stride;
    points.push(...sel.points);
  }
  return { points, totalInBand, renderedCount, stride: maxStride };
}
