/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read side of an embedded dimension (`@ifc-lite/create`'s
 * `addDimensionMarkupToStore`), split from `drawing-markup-read.ts` to keep
 * that module under the size limit.
 *
 * The writer's item order is the contract: the first segment is a→b through
 * the measured points, the second is the drawn dimension line. The measured
 * value is derived (`Dimension2D` never stores it), so `Qto.Distance` is only
 * checked against the restored points.
 *
 * Offset comes from the geometry, not from `Pset_IfcLiteMarkup.Offset`: the
 * dimension line's midpoint sits exactly `offset` from the midpoint of a and b
 * along the dimension's left normal (`dimension-graphics.ts`), and measuring it
 * in the same frame the points were restored in keeps the line on the side it
 * was drawn even when that frame differs from the authored one by a
 * reflection (the symbolic parser's plan-Y negation, when no store is given to
 * undo it). The stored `Offset` is the fallback when the line is missing.
 *
 * `RefA`/`RefB`/`Plane` use the encoding of `dimension-markup-codec.ts`. A
 * field that is present but malformed rejects the whole dimension, as the
 * localStorage loader does (`isDimension2D`): never guess at a reference or a cut.
 */

import { fromNativeLength } from '@ifc-lite/create';
import {
  DIMENSION_2D_ORIENTATIONS,
  isDimension2D,
  measuredDimensionValue,
  type Dimension2D,
  type Dimension2DOrientation,
} from '@/store/slices/drawing2DDimensions';
import { decodeDimensionPlane, decodeDimensionRef } from '@/lib/drawing2d-markup/dimension-markup-codec';
import type { DrawingMarkupAnnotationSource } from './drawing-markup-read.js';
import type { DrawingMarkupPlacementAnchor } from './drawing-markup-read-placement.js';
import { toAuthoredPoint } from './drawing-markup-read-placement.js';
import { warnOnDerivedValueMismatch } from './drawing-markup-read-trust.js';

function offsetFromDimensionLine(
  dim: Pick<Dimension2D, 'a' | 'b' | 'orientation'>,
  line: { start: { x: number; y: number }; end: { x: number; y: number } },
): number | null {
  const dir = dim.orientation === 'horizontal' ? { x: 1, y: 0 }
    : dim.orientation === 'vertical' ? { x: 0, y: 1 }
      : (() => {
        const dx = dim.b.x - dim.a.x;
        const dy = dim.b.y - dim.a.y;
        const len = Math.hypot(dx, dy);
        return len > 1e-12 ? { x: dx / len, y: dy / len } : null;
      })();
  if (!dir) return null;
  const mx = (line.start.x + line.end.x) / 2 - (dim.a.x + dim.b.x) / 2;
  const my = (line.start.y + line.end.y) / 2 - (dim.a.y + dim.b.y) / 2;
  const offset = -dir.y * mx + dir.x * my;
  return Number.isFinite(offset) ? offset : null;
}

export function readDimension(
  source: DrawingMarkupAnnotationSource,
  anchor: DrawingMarkupPlacementAnchor,
): Dimension2D | null {
  if (source.lines.length < 1) return null;
  const props = source.properties;
  const orientation = props?.get('Orientation');
  if (!orientation || !(DIMENSION_2D_ORIENTATIONS as readonly string[]).includes(orientation)) return null;
  const offsetValue = props?.get('Offset');
  // `Number('')` is 0, so a blank value has to be refused before converting.
  if (offsetValue === undefined || offsetValue.trim() === '') return null;
  const rawOffset = Number(offsetValue);
  if (!Number.isFinite(rawOffset)) return null;

  const author = (p: { x: number; y: number }) => toAuthoredPoint(source.expressId, anchor, { x: p.x, y: p.y });
  const a = author(source.lines[0].line.start);
  const b = author(source.lines[0].line.end);
  const base = { a, b, orientation: orientation as Dimension2DOrientation };
  const drawnLine = source.lines[1]?.line;
  const offset = (drawnLine && offsetFromDimensionLine(base, { start: author(drawnLine.start), end: author(drawnLine.end) }))
    ?? fromNativeLength(anchor, rawOffset);

  const candidate: Record<string, unknown> = { id: `ifc-dimension-${source.expressId}`, ...base, offset };
  const text = props?.get('Text');
  if (text !== undefined) candidate.text = text;
  const refA = props?.get('RefA');
  const refB = props?.get('RefB');
  if (refA !== undefined || refB !== undefined) {
    candidate.refs = {
      ...(refA !== undefined ? { a: decodeDimensionRef(refA) } : {}),
      ...(refB !== undefined ? { b: decodeDimensionRef(refB) } : {}),
    };
  }
  const plane = props?.get('Plane');
  if (plane !== undefined) candidate.plane = decodeDimensionPlane(plane);
  if (!isDimension2D(candidate)) return null;

  const rawDistance = source.quantities?.get('Distance');
  if (typeof rawDistance === 'number' && Number.isFinite(rawDistance)) {
    warnOnDerivedValueMismatch(
      'dimension', source.expressId, 'Distance', fromNativeLength(anchor, rawDistance), measuredDimensionValue(candidate),
    );
  }
  return candidate;
}
