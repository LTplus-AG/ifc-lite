/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point coordinates for the Measure tool — issue #2199 §5.
 *
 * The viewer already reports a picked point's GEOREFERENCED position
 * (Eastings / Northings / Height, #1674) but never its plain model position,
 * which is what most of §5 asks for. This module is the missing half: it maps
 * a picked render-frame point back to the model's own coordinate system.
 *
 * TWO transforms are involved and they are independent, which is why they are
 * separate exported functions rather than one lump:
 *
 * 1. **Frames.** Renderer positions are SHIFTED. The geometry pipeline moves
 *    the model towards the origin to keep f32 precision usable, in up to two
 *    stages — an RTC offset subtracted by the wasm mesh pass, then a further
 *    centroid shift by `CoordinateHandler`. `CoordinateInfo` records both, so
 *    adding them back recovers the file's own world coordinates.
 * 2. **Axes.** Renderer space is Y-up; IFC is Z-up. Reporting a picked point in
 *    renderer axes would put a building's height in the Y column, which
 *    silently disagrees with every other coordinate the viewer shows (the
 *    Properties panel, the georeferencing panel, the file itself).
 *
 * Units are metres throughout — geometry is unit-scaled to metres at import
 * (`RouterConfig.unit_scale`), and both recorded offsets are in that same
 * metre space. No unit conversion belongs here.
 *
 * The world-frame reconstruction deliberately mirrors the one already inlined
 * in `PropertiesPanel.tsx`'s `entityCoordinates` memo, and that call site now
 * routes through here, so the two can no longer drift apart.
 */

import type { Point3 } from './components';

/**
 * The offsets the geometry pipeline applied to get from the model's own
 * coordinates to the render frame. Both are optional because both are
 * genuinely absent for a small model authored near the origin — which is the
 * case where local and world coordinates coincide.
 */
export interface RenderFrameOffsets {
  /**
   * Centroid shift applied by `CoordinateHandler`, in RENDERER (Y-up) metres.
   * `CoordinateInfo.originShift`.
   */
  originShift?: Point3 | null;
  /**
   * RTC offset subtracted by the wasm mesh pass, in IFC (Z-up) metres.
   * `CoordinateInfo.wasmRtcOffset`. Recorded in IFC axes, unlike
   * `originShift` — hence the conversion below rather than a plain add.
   */
  wasmRtcOffsetIfc?: Point3 | null;
}

const ZERO: Point3 = { x: 0, y: 0, z: 0 };

/**
 * Convert a renderer-space (Y-up) point to IFC axes (Z-up).
 *
 * `IFC X = viewer X`, `IFC Y = -viewer Z`, `IFC Z = viewer Y`. The negation is
 * not optional bookkeeping: dropping it mirrors the model about its own north
 * axis, which reads as plausible numbers pointing the wrong way.
 */
export function viewerToIfcAxes(p: Point3): Point3 {
  // `0 - p.z` rather than `-p.z`: unary minus on 0 yields -0, which is not a
  // coordinate anybody authored and leaks into equality checks and serialised
  // output. Subtraction from zero normalises it while leaving every other
  // value — including NaN, which must stay NaN rather than becoming 0 —
  // untouched.
  return { x: p.x, y: 0 - p.z, z: p.y };
}

/**
 * Convert an IFC-axes (Z-up) point to renderer axes (Y-up). The exact inverse
 * of {@link viewerToIfcAxes}.
 */
export function ifcToViewerAxes(p: Point3): Point3 {
  // See the signed-zero note on `viewerToIfcAxes`.
  return { x: p.x, y: p.z, z: 0 - p.y };
}

/**
 * Undo the render-frame shift: renderer-space point -> the model's own world
 * position, still in renderer (Y-up) axes.
 *
 * Both offsets are ADDED back because both were subtracted on the way in.
 * `wasmRtcOffsetIfc` is converted to renderer axes first — it is recorded in
 * IFC axes while `originShift` is recorded in renderer axes, and adding them
 * in the same axes would fold the model's north offset into its height.
 */
export function renderToWorldViewer(p: Point3, frame: RenderFrameOffsets): Point3 {
  const shift = frame.originShift ?? ZERO;
  const rtcIfc = frame.wasmRtcOffsetIfc ?? ZERO;
  const rtcViewer = ifcToViewerAxes(rtcIfc);
  return {
    x: p.x + shift.x + rtcViewer.x,
    y: p.y + shift.y + rtcViewer.y,
    z: p.z + shift.z + rtcViewer.z,
  };
}

/** A picked point expressed in every frame the viewer can honestly offer. */
export interface PointCoordinates {
  /**
   * The render frame the picked point arrived in, converted to IFC axes.
   * Small numbers near the origin; what the renderer and the snap system work
   * in. Useful for reproducing a pick, not for talking to anyone else.
   */
  local: Point3;
  /**
   * The model's own coordinates — the render frame with every applied shift
   * added back, in IFC axes. This is what the IFC file's global coordinate
   * system says, and what matches the Properties panel's world readout.
   */
  world: Point3;
  /**
   * Whether the two above actually differ. False for a model authored near
   * the origin, where showing both would be two identical rows pretending to
   * be different information.
   */
  shifted: boolean;
}

/** Express a picked renderer-space point in local and world IFC coordinates. */
export function pointCoordinates(p: Point3, frame: RenderFrameOffsets): PointCoordinates {
  const worldViewer = renderToWorldViewer(p, frame);
  const shifted =
    worldViewer.x !== p.x || worldViewer.y !== p.y || worldViewer.z !== p.z;
  return {
    local: viewerToIfcAxes(p),
    world: viewerToIfcAxes(worldViewer),
    shifted,
  };
}

/** A point's offset from a user-set temporary reference point. */
export interface RelativeOffset {
  /** Signed per-axis deltas, point minus reference, in the given frame. */
  dx: number;
  dy: number;
  dz: number;
  /** Straight-line distance between the two. Never negative. */
  distance: number;
}

/**
 * Offset of `p` from a temporary reference point `ref` — issue #2199 §5's
 * "define a temporary reference point and display relative coordinate
 * offsets".
 *
 * Frame-agnostic: it subtracts whatever it is given, so passing two IFC-axes
 * points yields IFC-axes deltas and passing two renderer-space points yields
 * renderer deltas. Callers must not mix the two.
 */
export function relativeOffset(p: Point3, ref: Point3): RelativeOffset {
  const dx = p.x - ref.x;
  const dy = p.y - ref.y;
  const dz = p.z - ref.z;
  return { dx, dy, dz, distance: Math.hypot(dx, dy, dz) };
}

/** Fixed-precision X/Y/Z triple, e.g. `X 12.500  Y -3.250  Z 0.000`. */
export function formatCoordinateTriple(p: Point3, fractionDigits = 3): string {
  return `X ${p.x.toFixed(fractionDigits)}  Y ${p.y.toFixed(fractionDigits)}  Z ${p.z.toFixed(fractionDigits)}`;
}
