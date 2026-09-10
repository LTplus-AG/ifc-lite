/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Struct-of-arrays flattening of the WASM symbolic-representation collection.
 *
 * This is the worker half of the symbolic-annotation parse (#2183). The WASM
 * handles it walks cannot cross a `postMessage` boundary, so the worker
 * flattens them into transferable typed arrays here and the main thread
 * reassembles the `ParseResult` from those arrays (`buildParseResult` in
 * `symbolic-parse.ts`).
 *
 * Two rules keep the split honest:
 *
 *   1. **Verbatim.** Every field the main-side walk reads is carried across
 *      unchanged, in the same element type WASM produced it in (`f32` values
 *      into `Float32Array`, `u32` express ids into `Uint32Array` — never a
 *      `Float32Array`, ids exceed 2^24 on large models). Nothing is rounded,
 *      decoded, tessellated or reordered on this side. `hatchAngleSecondary`
 *      keeps its `NaN` "absent" sentinel; typed-array bytes survive the clone.
 *   2. **Filter early.** The `IfcAnnotation` / `IfcGridAxis` type filter that
 *      used to sit inside the main-side walk runs *here* instead, so only
 *      primitives the overlay can actually use pay for the transfer. On a
 *      342 MB model that is 10,222 polylines down to ~2. The predicate is the
 *      same one, applied at the same point (before anything else is read off
 *      the handle), so the surviving set is identical. The 2D drawing needs
 *      EVERY representation type instead, so the filter is a {@link
 *      SymbolicFilterMode} rather than a constant — `'overlay'` (the default,
 *      and what the annotation overlay asks for) keeps today's behaviour
 *      exactly.
 *
 * Deliberately NOT done here, so their existing coverage keeps applying to the
 * code that ships: circle/polyline tessellation (`circleToSegments` /
 * `polylineToSegments`) and the multi-line text split stay on the main
 * thread.
 */

import type { SymbolicRepresentationCollection } from '@ifc-lite/wasm';
import { isOverlayOwnerType } from './overlay-channels.js';

/**
 * Which owner types survive the flatten.
 *
 *   - `'overlay'` — `IfcAnnotation` / `IfcGridAxis` only, the two the
 *     annotation overlay renders (issue #862). The default, so every existing
 *     caller keeps its exact output.
 *   - `'all'` — no type filter. The 2D drawing draws the symbolic (Plan/Axis)
 *     representation of ANY product it can find one for, so it cannot use the
 *     overlay's filter.
 */
export type SymbolicFilterMode = 'overlay' | 'all';

import type { FlatSymbolic } from './symbolic-flat-types.js';
export type { FlatSymbolic } from './symbolic-flat-types.js';

/** An empty flatten — the shape a skipped or empty parse produces. */
export function createEmptyFlatSymbolic(): FlatSymbolic {
  return {
    typeNames: [],
    polyPoints: new Float32Array(0),
    polyStart: new Uint32Array(1),
    polyOwner: new Uint32Array(0),
    polyWorldY: new Float32Array(0),
    polyFlags: new Uint8Array(0),
    polyType: new Uint16Array(0),
    circleCenterX: new Float32Array(0),
    circleCenterY: new Float32Array(0),
    circleRadius: new Float32Array(0),
    circleStartAngle: new Float32Array(0),
    circleEndAngle: new Float32Array(0),
    circleOwner: new Uint32Array(0),
    circleWorldY: new Float32Array(0),
    circleFlags: new Uint8Array(0),
    circleType: new Uint16Array(0),
    textContent: [],
    textAlignment: [],
    textX: new Float32Array(0),
    textY: new Float32Array(0),
    textDirX: new Float32Array(0),
    textDirY: new Float32Array(0),
    textHeight: new Float32Array(0),
    textTargetPx: new Float32Array(0),
    textColor: new Float32Array(0),
    textOwner: new Uint32Array(0),
    textWorldY: new Float32Array(0),
    textType: new Uint16Array(0),
    fillPoints: new Float32Array(0),
    fillPointStart: new Uint32Array(1),
    fillHoles: new Uint32Array(0),
    fillHoleStart: new Uint32Array(1),
    fillColor: new Float32Array(0),
    fillHatch: new Float32Array(0),
    fillOwner: new Uint32Array(0),
    fillGeometryItem: new Uint32Array(0),
    fillWorldY: new Float32Array(0),
    fillFlags: new Uint8Array(0),
    fillType: new Uint16Array(0),
  };
}

/** Keep-predicate for a {@link SymbolicFilterMode}. The owner types the
 *  overlay renders are defined once, in `overlay-channels.ts`. */
function keepPredicate(mode: SymbolicFilterMode): (ifcType: string) => boolean {
  return mode === 'all' ? () => true : isOverlayOwnerType;
}

/** Intern an IFC type name into the shared table, returning its index. */
function intern(names: string[], index: Map<string, number>, name: string): number {
  const existing = index.get(name);
  if (existing !== undefined) return existing;
  const next = names.length;
  names.push(name);
  index.set(name, next);
  return next;
}

/**
 * Flatten a WASM symbolic collection into transferable arrays.
 *
 * Frees every per-item handle it takes (`getPolyline` / `getCircle` /
 * `getText` / `getFill`) in `try/finally`, so a mid-flatten throw cannot leak
 * WASM memory into the FinalizationRegistry (AGENTS.md §Geometry & WASM).
 * Ownership of `collection` itself stays with the caller.
 *
 * `mode` defaults to `'overlay'` so every pre-existing caller — including the
 * golden-digest reference path in `symbolic-parse.ts` — is byte-for-byte
 * unchanged.
 */
export function collectFlatSymbolic(
  collection: SymbolicRepresentationCollection,
  mode: SymbolicFilterMode = 'overlay',
): FlatSymbolic {
  const keep = keepPredicate(mode);
  const typeNames: string[] = [];
  const typeIndex = new Map<string, number>();

  const polyPoints: number[] = [];
  const polyStart: number[] = [0];
  const polyOwner: number[] = [];
  const polyWorldY: number[] = [];
  const polyFlags: number[] = [];
  const polyType: number[] = [];

  for (let i = 0; i < collection.polylineCount; i++) {
    const poly = collection.getPolyline(i);
    if (!poly) continue;
    try {
      const ifcType = poly.ifcType;
      if (!keep(ifcType)) continue;
      // `pointCount` is `points.len() / 2`, so `pointCount * 2` never reads
      // past the end even if the source vector had an odd length.
      const pointCount = poly.pointCount;
      const points = poly.points;
      for (let j = 0; j < pointCount * 2; j++) polyPoints.push(points[j]);
      polyStart.push(polyPoints.length / 2);
      polyOwner.push(poly.expressId);
      polyWorldY.push(poly.worldY);
      polyFlags.push(poly.isClosed ? 1 : 0);
      polyType.push(intern(typeNames, typeIndex, ifcType));
    } finally {
      poly.free();
    }
  }

  const circleCenterX: number[] = [];
  const circleCenterY: number[] = [];
  const circleRadius: number[] = [];
  const circleStartAngle: number[] = [];
  const circleEndAngle: number[] = [];
  const circleOwner: number[] = [];
  const circleWorldY: number[] = [];
  const circleFlags: number[] = [];
  const circleType: number[] = [];

  for (let i = 0; i < collection.circleCount; i++) {
    const circle = collection.getCircle(i);
    if (!circle) continue;
    try {
      const ifcType = circle.ifcType;
      if (!keep(ifcType)) continue;
      circleCenterX.push(circle.centerX);
      circleCenterY.push(circle.centerY);
      circleRadius.push(circle.radius);
      circleStartAngle.push(circle.startAngle);
      circleEndAngle.push(circle.endAngle);
      circleOwner.push(circle.expressId);
      circleWorldY.push(circle.worldY);
      circleFlags.push(circle.isFullCircle ? 1 : 0);
      circleType.push(intern(typeNames, typeIndex, ifcType));
    } finally {
      circle.free();
    }
  }

  const textContent: string[] = [];
  const textAlignment: string[] = [];
  const textX: number[] = [];
  const textY: number[] = [];
  const textDirX: number[] = [];
  const textDirY: number[] = [];
  const textHeight: number[] = [];
  const textTargetPx: number[] = [];
  const textColor: number[] = [];
  const textOwner: number[] = [];
  const textWorldY: number[] = [];
  const textType: number[] = [];

  for (let i = 0; i < collection.textCount; i++) {
    const text = collection.getText(i);
    if (!text) continue;
    try {
      const ifcType = text.ifcType;
      if (!keep(ifcType)) continue;
      // Content crosses verbatim. It is already decoded — the Rust extractor
      // decodes at the parse boundary (`AttributeValue::from_token`) — so the
      // main side only splits it into lines.
      textContent.push(text.content);
      textAlignment.push(text.alignment);
      textX.push(text.x);
      textY.push(text.y);
      textDirX.push(text.dirX);
      textDirY.push(text.dirY);
      textHeight.push(text.height);
      textTargetPx.push(text.targetPx);
      textColor.push(text.colorR, text.colorG, text.colorB, text.colorA);
      textOwner.push(text.expressId);
      textWorldY.push(text.worldY);
      textType.push(intern(typeNames, typeIndex, ifcType));
    } finally {
      text.free();
    }
  }

  const fillPoints: number[] = [];
  const fillPointStart: number[] = [0];
  const fillHoles: number[] = [];
  const fillHoleStart: number[] = [0];
  const fillColor: number[] = [];
  const fillHatch: number[] = [];
  const fillOwner: number[] = [];
  const fillGeometryItem: number[] = [];
  const fillWorldY: number[] = [];
  const fillFlags: number[] = [];
  const fillType: number[] = [];

  for (let i = 0; i < collection.fillCount; i++) {
    const fill = collection.getFill(i);
    if (!fill) continue;
    try {
      const ifcType = fill.ifcType;
      if (!keep(ifcType)) continue;
      // The degenerate-ring guard (`< 3` vertices) stays main-side, next to
      // the bucket it must not create; carry the ring across as authored.
      const points = fill.points;
      for (let j = 0; j < points.length; j++) fillPoints.push(points[j]);
      fillPointStart.push(fillPoints.length);
      const holes = fill.holesOffsets;
      for (let j = 0; j < holes.length; j++) fillHoles.push(holes[j]);
      fillHoleStart.push(fillHoles.length);
      fillColor.push(fill.fillR, fill.fillG, fill.fillB, fill.fillA);
      // `hatchAngleSecondary` keeps its NaN "absent" sentinel here; the main
      // side is what turns it into `null`.
      fillHatch.push(fill.hatchSpacing, fill.hatchAngle, fill.hatchAngleSecondary, fill.hatchLineWidth);
      fillOwner.push(fill.expressId);
      fillGeometryItem.push(fill.geometryItemId ?? 0);
      fillWorldY.push(fill.worldY);
      fillFlags.push(fill.hasHatching ? 1 : 0);
      fillType.push(intern(typeNames, typeIndex, ifcType));
    } finally {
      fill.free();
    }
  }

  return {
    typeNames,
    polyPoints: Float32Array.from(polyPoints),
    polyStart: Uint32Array.from(polyStart),
    polyOwner: Uint32Array.from(polyOwner),
    polyWorldY: Float32Array.from(polyWorldY),
    polyFlags: Uint8Array.from(polyFlags),
    polyType: Uint16Array.from(polyType),
    circleCenterX: Float32Array.from(circleCenterX),
    circleCenterY: Float32Array.from(circleCenterY),
    circleRadius: Float32Array.from(circleRadius),
    circleStartAngle: Float32Array.from(circleStartAngle),
    circleEndAngle: Float32Array.from(circleEndAngle),
    circleOwner: Uint32Array.from(circleOwner),
    circleWorldY: Float32Array.from(circleWorldY),
    circleFlags: Uint8Array.from(circleFlags),
    circleType: Uint16Array.from(circleType),
    textContent,
    textAlignment,
    textX: Float32Array.from(textX),
    textY: Float32Array.from(textY),
    textDirX: Float32Array.from(textDirX),
    textDirY: Float32Array.from(textDirY),
    textHeight: Float32Array.from(textHeight),
    textTargetPx: Float32Array.from(textTargetPx),
    textColor: Float32Array.from(textColor),
    textOwner: Uint32Array.from(textOwner),
    textWorldY: Float32Array.from(textWorldY),
    textType: Uint16Array.from(textType),
    fillPoints: Float32Array.from(fillPoints),
    fillPointStart: Uint32Array.from(fillPointStart),
    fillHoles: Uint32Array.from(fillHoles),
    fillHoleStart: Uint32Array.from(fillHoleStart),
    fillColor: Float32Array.from(fillColor),
    fillHatch: Float32Array.from(fillHatch),
    fillOwner: Uint32Array.from(fillOwner),
    fillGeometryItem: Uint32Array.from(fillGeometryItem),
    fillWorldY: Float32Array.from(fillWorldY),
    fillFlags: Uint8Array.from(fillFlags),
    fillType: Uint16Array.from(fillType),
  };
}
