/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The frame of a slab-like element's extrusion: the solid position's plan
 * transform the footprint is read through, and (#6233) whether the element
 * is a vertical extrusion of that plan outline at all.
 *
 * The slab chain reads a FOOTPRINT in plan: the element placement's origin
 * plus the solid position's plan transform (which may flip or turn the
 * profile about Z). A split re-authors pieces from that plan outline, so it
 * is only faithful when the element really is a vertical extrusion of that
 * outline:
 *   - the element placement is not rotated (the chain reads only its origin);
 *   - the solid position's Axis is vertical (a tilted roof slab is not a
 *     plan outline — AC20's `Dach-1` extrudes along (0, 0.5, 0.866));
 *   - the extrusion direction is vertical in the solid's frame.
 * Otherwise the element is refused, rather than cut into flat slabs.
 *
 * For an accepted element it also returns where the extrusion starts,
 * above the placement origin: AC20's `Bodenplatte` hangs 0.2 m below its
 * placement (solid Location z = -0.2), which a re-authored piece must keep.
 */

import { firstProjAxis } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { axis3d, type GeometryEntityReader } from '../host-geometry-frame.js';
import { asCoordinateTriple, asDirectionRatios, asExpressIdRef, readAttributes } from './placement-core.js';

const EPS = 1e-6;

type Read = (id: number | null) => unknown[] | null;

/** A unit-normalised direction, or `fallback` when the slot is `$`; null when unreadable. */
function direction(read: Read, id: unknown, fallback: [number, number, number]): [number, number, number] | null {
  if (id == null) return fallback;
  const d = asDirectionRatios(read(asExpressIdRef(id))?.[0]);
  const len = d ? Math.hypot(d[0], d[1], d[2]) : 0;
  return d && len > EPS ? [d[0] / len, d[1] / len, d[2] / len] : null;
}

/**
 * Null when the element is not a vertical extrusion of its plan outline;
 * otherwise the NATIVE-unit height of the extrusion's bottom above the
 * element placement's origin.
 */
export function slabExtrusionBase(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  elementAxisPlacementId: number,
  solidAttrs: readonly unknown[],
  depth: number,
): number | null {
  return slabExtrusionFrame(dataStore, view, editor, elementAxisPlacementId, solidAttrs, depth)?.base ?? null;
}

/**
 * {@link slabExtrusionBase} plus the direction the depth runs: `up` is true
 * when the extrusion grows upward from the solid's profile plane (the layout
 * the builders write and AC20's `Bodenplatte` has), false when the solid or
 * its extrusion direction is flipped so it grows downward from it. Push /
 * pull needs it: a bigger depth moves the top face in the first case and the
 * underside in the second (#6232 C4).
 */
export function slabExtrusionFrame(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  elementAxisPlacementId: number,
  solidAttrs: readonly unknown[],
  depth: number,
): { base: number; up: boolean } | null {
  const read: Read = (id) => (id === null ? null : readAttributes(dataStore, view, editor, id));
  const reader: GeometryEntityReader = {
    entity(id) {
      const attributes = read(id), type = editor.getEntityType(id);
      return attributes && type ? { type, attributes } : null;
    },
  };
  const placement = axis3d(reader, elementAxisPlacementId);
  // #6589: a cosine-only check admits rotations of order sqrt(EPS).
  // Compare the actual orthonormal frame components, including the small
  // transverse components that the origin-only plan reader cannot retain.
  if (!placement || Math.abs(placement.x[0] - 1) > EPS || Math.abs(placement.x[1]) > EPS
    || Math.abs(placement.x[2]) > EPS || Math.abs(placement.z[0]) > EPS
    || Math.abs(placement.z[1]) > EPS || Math.abs(placement.z[2] - 1) > EPS) return null;

  const position = axis3d(reader, solidAttrs[1]);
  if (!position || Math.abs(position.z[0]) > EPS || Math.abs(position.z[1]) > EPS
    || Math.abs(Math.abs(position.z[2]) - 1) > EPS) return null;
  const extrusion = direction(read, solidAttrs[2], [0, 0, 1]);
  if (!extrusion || Math.abs(extrusion[0]) > EPS || Math.abs(extrusion[1]) > EPS
    || Math.abs(Math.abs(extrusion[2]) - 1) > EPS) return null;

  // Upward (+1) or downward (-1) in the element frame.
  const up = Math.sign(position.z[2] * extrusion[2]);
  return { base: position.o[2] + Math.min(0, up * depth), up: up > 0 };
}

/**
 * A 2D rigid transform mapping a profile-coordinate point into the
 * solid's local plan (XY). Built from the `IfcExtrudedAreaSolid`'s
 * `Position` (an `IfcAxis2Placement3D`), it folds in the in-place
 * translation + rotation that real-world authoring tools bake there.
 * In-store-built slabs carry an identity Position, so the resolver
 * defaults to the identity transform for them.
 */
export type Xform2D = (p: [number, number]) => [number, number];

const IDENTITY_XFORM2D: Xform2D = (p) => [p[0], p[1]];

function readDirection(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  id: number | null,
): [number, number, number] | null {
  if (id === null) return null;
  const attrs = readAttributes(dataStore, view, editor, id);
  return attrs ? asDirectionRatios(attrs[0]) : null;
}

/**
 * Build the plan-space transform for an `IfcExtrudedAreaSolid.Position`.
 * The profile lives in the placement's local XY plane; we map a profile
 * point `(px, py)` to `origin + px·X + py·Y` and keep the XY components
 * (the footprint is the plan). X comes from RefDirection (orthonormalised
 * against the Axis/Z), Y = Z × X — matching the IFC placement convention,
 * including axis flips (e.g. Axis `(0,0,-1)`, RefDirection `(-1,0,0)`).
 * Returns identity when the placement is absent or degenerate.
 */
export function resolveSolidPositionXform(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  placementId: number | null,
): Xform2D {
  if (placementId === null) return IDENTITY_XFORM2D;
  const attrs = readAttributes(dataStore, view, editor, placementId);
  if (!attrs) return IDENTITY_XFORM2D;

  // IfcAxis2Placement3D: [0] Location · [1] Axis (Z) · [2] RefDirection (X).
  const locId = asExpressIdRef(attrs[0]);
  let ox = 0;
  let oy = 0;
  if (locId !== null) {
    const locAttrs = readAttributes(dataStore, view, editor, locId);
    const c = locAttrs ? asCoordinateTriple(locAttrs[0]) : null;
    if (c) {
      ox = c[0];
      oy = c[1];
    }
  }

  // IfcDirection ratios are NOT guaranteed unit length, so normalise Z
  // before using it as a basis vector — otherwise the Gram-Schmidt
  // projection (which assumes |Z|=1) and Y = Z × X both pick up |Z| as a
  // stray scale factor, skewing the footprint away from the rendered mesh
  // for files with e.g. Axis=(0,0,2). The Rust profile extractor
  // normalises the same placement.
  const rawZ = readDirection(dataStore, view, editor, asExpressIdRef(attrs[1])) ?? [0, 0, 1];
  const zlen = Math.hypot(rawZ[0], rawZ[1], rawZ[2]);
  if (zlen < 1e-9) return IDENTITY_XFORM2D;
  const z: [number, number, number] = [rawZ[0] / zlen, rawZ[1] / zlen, rawZ[2] / zlen];
  // A `$` RefDirection takes the renderer's fill, not world X as-is (#5922).
  const refX = readDirection(dataStore, view, editor, asExpressIdRef(attrs[2])) ?? firstProjAxis(z);

  // Orthonormalise X against the unit Z (Gram-Schmidt), then Y = Z × X.
  const dot = refX[0] * z[0] + refX[1] * z[1] + refX[2] * z[2];
  let xv: [number, number, number] = [
    refX[0] - dot * z[0],
    refX[1] - dot * z[1],
    refX[2] - dot * z[2],
  ];
  const xlen = Math.hypot(xv[0], xv[1], xv[2]);
  if (xlen < 1e-9) return IDENTITY_XFORM2D;
  xv = [xv[0] / xlen, xv[1] / xlen, xv[2] / xlen];
  // Z and X are now orthonormal, so Y = Z × X is already unit length.
  const yv: [number, number, number] = [
    z[1] * xv[2] - z[2] * xv[1],
    z[2] * xv[0] - z[0] * xv[2],
    z[0] * xv[1] - z[1] * xv[0],
  ];

  return (p) => [ox + p[0] * xv[0] + p[1] * yv[0], oy + p[0] * xv[1] + p[1] * yv[1]];
}
