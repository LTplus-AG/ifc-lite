/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A linear dimension (the 2D drawing panel's `Dimension2D`) as an
 * `IfcAnnotation`, beside the other markup builders in `drawing-markup.ts`.
 *
 * The caller passes the dimension's drawn graphics already laid out (the
 * viewer computes them once with its `dimensionGraphics`, the same function
 * its canvas and exports draw from), so a generic IFC viewer shows the
 * dimension as drawn without knowing the layout rules.
 *
 * Representation: one `Annotation` / `Annotation2D` `IfcShapeRepresentation`
 * whose items are, in order,
 *   1. an `IfcPolyline` a→b through the two measured points,
 *   2. one `IfcPolyline` per drawn line (dimension line, then extension lines),
 *   3. one `IfcPolyline` per tick,
 *   4. an `IfcTextLiteralWithExtent` holding the printed value.
 * The first polyline is what a reader recovers the measured points from; the
 * order is the contract. `Annotation2D`, not `Curve2D`: IFC restricts the items
 * of a `Curve2D` representation to curves, and this one also carries text.
 *
 * Values that are not geometry: `Qto_IfcLiteMarkup.Distance` (LENGTH, native
 * unit) and `Pset_IfcLiteMarkup` with `Offset` (REAL, native length unit),
 * `Orientation`, and, when present, `Text` (the override; `<>` stands for the
 * value), `RefA`/`RefB` (the snapped elements) and `Plane` (the cut it was
 * drawn on). `RefA`, `RefB` and `Plane` are written verbatim: their encoding
 * belongs to the caller, which is also the one that reads them back.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import { toNativeLength } from './anchor.js';
import { emitLocalPlacement } from './_emit-helpers.js';
import { emitMarkupPoint2DPlacement, emitMarkupPolyline, emitMarkupRepresentation } from './drawing-markup-geometry.js';
import { assertFiniteNonNegative, assertFinitePoint, emitAnnotation } from './drawing-markup-emit.js';
import { DRAWING_MARKUP_OBJECTTYPE, DRAWING_MARKUP_PSET_NAME, DRAWING_MARKUP_QSET_NAME } from './drawing-markup-tags.js';
import type { MarkupAnchor, MarkupPoint2D } from './drawing-markup.js';

export type DimensionMarkupOrientation = 'aligned' | 'horizontal' | 'vertical';

export const DIMENSION_MARKUP_ORIENTATIONS: readonly DimensionMarkupOrientation[] = ['aligned', 'horizontal', 'vertical'];

/** One straight drawn segment, drawing coords (metres). */
export type DimensionMarkupSegment = readonly [MarkupPoint2D, MarkupPoint2D];

export interface DimensionMarkupParams {
  /** The measured points, drawing coords (metres). */
  a: MarkupPoint2D;
  b: MarkupPoint2D;
  /** The measured value, metres. */
  distance: number;
  /** Signed distance from the measured points to the dimension line, metres. */
  offset: number;
  orientation: DimensionMarkupOrientation;
  /** Drawn lines: the dimension line first, then the extension lines. */
  lines: readonly DimensionMarkupSegment[];
  /** Drawn ticks, one per end of the dimension line. */
  ticks: readonly DimensionMarkupSegment[];
  /** The printed value: centre of the text, baseline angle (radians, drawing space) and text height (metres). */
  label: { position: MarkupPoint2D; value: string; angle: number; height: number };
  /** Text override; `<>` stands for the measured value. */
  text?: string;
  /** The elements the measured points were snapped to, in the caller's own encoding. */
  refA?: string;
  refB?: string;
  /** The drawing cut the dimension belongs to, in the caller's own encoding. */
  plane?: string;
  Name?: string;
}

export interface DimensionMarkupResult {
  annotationId: number;
  placementId: number;
  /** The a→b polyline, then one per drawn line and tick, in item order. */
  polylineIds: number[];
  textLiteralId: number;
  shapeRepId: number;
  productShapeId: number;
}

/** Text box width per character, as a fraction of the text height: a nominal extent, since no font is known here. */
const CHAR_WIDTH_RATIO = 0.6;

function assertFiniteSegments(label: string, segments: readonly DimensionMarkupSegment[]): void {
  for (const [i, [p, q]] of segments.entries()) {
    assertFinitePoint('addDimensionMarkupToStore', `${label}[${i}][0]`, p);
    assertFinitePoint('addDimensionMarkupToStore', `${label}[${i}][1]`, q);
  }
}

export function addDimensionMarkupToStore(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  contextId: number,
  params: DimensionMarkupParams,
): DimensionMarkupResult {
  const fn = 'addDimensionMarkupToStore';
  assertFinitePoint(fn, 'a', params.a);
  assertFinitePoint(fn, 'b', params.b);
  assertFiniteNonNegative(fn, 'distance', params.distance);
  if (!Number.isFinite(params.offset)) throw new Error(`${fn}: offset must be finite`);
  if (!DIMENSION_MARKUP_ORIENTATIONS.includes(params.orientation)) {
    throw new Error(`${fn}: orientation must be one of ${DIMENSION_MARKUP_ORIENTATIONS.join(', ')}`);
  }
  assertFiniteSegments('lines', params.lines);
  assertFiniteSegments('ticks', params.ticks);
  assertFinitePoint(fn, 'label.position', params.label.position);
  if (!Number.isFinite(params.label.angle)) throw new Error(`${fn}: label.angle must be finite`);
  assertFiniteNonNegative(fn, 'label.height', params.label.height);

  const n = (metres: number) => toNativeLength(anchor, metres);
  const pt = (p: MarkupPoint2D): [number, number] => [n(p.x), n(p.y)];
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, [0, 0, 0]);

  const polylineIds = [
    emitMarkupPolyline(editor, [pt(params.a), pt(params.b)], false),
    ...[...params.lines, ...params.ticks].map(([p, q]) => emitMarkupPolyline(editor, [pt(p), pt(q)], false)),
  ];

  const { label } = params;
  const textPlacementId = emitMarkupPoint2DPlacement(
    editor, pt(label.position), [Math.cos(label.angle), Math.sin(label.angle)],
  );
  const extentId = editor.addEntity('IfcPlanarExtent', [
    n(label.value.length * CHAR_WIDTH_RATIO * label.height),
    n(label.height),
  ]).expressId;
  const textLiteralId = editor.addEntity('IfcTextLiteralWithExtent', [
    label.value,
    `#${textPlacementId}`,
    '.RIGHT.',
    `#${extentId}`,
    'center',
  ]).expressId;

  const { shapeRepId, productShapeId } = emitMarkupRepresentation(
    editor, contextId, 'Annotation2D', [...polylineIds, textLiteralId],
  );
  const annotationId = emitAnnotation(
    editor, anchor, params.Name ?? 'Dimension', DRAWING_MARKUP_OBJECTTYPE.DIMENSION, placementId, productShapeId,
  );
  editor.addQuantitySet(annotationId, DRAWING_MARKUP_QSET_NAME, [
    { name: 'Distance', value: n(params.distance), quantityType: 'LENGTH' },
  ]);
  const optional = (name: string, value: string | undefined) =>
    value === undefined ? [] : [{ name, value, type: 'TEXT' as const }];
  editor.addPropertySet(annotationId, DRAWING_MARKUP_PSET_NAME, [
    { name: 'Offset', value: n(params.offset), type: 'REAL' },
    { name: 'Orientation', value: params.orientation, type: 'LABEL' },
    ...optional('Text', params.text),
    ...optional('RefA', params.refA),
    ...optional('RefB', params.refB),
    ...optional('Plane', params.plane),
  ]);
  return { annotationId, placementId, polylineIds, textLiteralId, shapeRepId, productShapeId };
}
