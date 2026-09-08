/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translate 2D drawing markup (issue #4153's "save into the model" option)
 * into IFC entities via the additive `StoreEditor` overlay — modelled on
 * `space.ts`'s `addSpaceToStore`.
 *
 * WRITE SIDE ONLY. This module has no UI wiring and does not import or edit
 * `apps/viewer/src/store/slices/drawing2DSlice.ts` — a "save into model"
 * action, and the read-side translator that recognises
 * `DRAWING_MARKUP_OBJECTTYPE` and rehydrates `Drawing2DState`, are both
 * future follow-ups. The param shapes below (`MarkupPoint2D`,
 * `MeasureMarkupParams`, …) intentionally mirror `Drawing2DState`'s arrays
 * structurally without importing `apps/viewer` — a published package
 * (`@ifc-lite/create`) cannot depend on the app.
 *
 * Geometry frame: every point is treated as already resolved into the
 * target `IfcGeometricRepresentationSubContext`'s 2D plane, in METRES —
 * the same "drawing units (typically meters)" `Drawing2DState`'s own
 * comments describe. Reprojecting a plan/section drawing's local 2D
 * coordinates into that frame (accounting for the `SectionConfig` cut
 * plane) is a UI/wiring concern for the future "save into model" action,
 * not this translation layer.
 *
 * Additive by construction, same guarantee `StoreEditor.addEntity` documents:
 * every call only APPENDS overlay entities (new `IfcAnnotation` +
 * geometry + property/quantity sets); nothing existing is read, mutated,
 * or renumbered.
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchorSchema } from './anchor.js';
import { toNativeLength } from './anchor.js';
import { emitLocalPlacement, ownerHistoryRef } from './_emit-helpers.js';
import {
  emitMarkupPolyline,
  emitMarkupPoint2DPlacement,
  emitMarkupSubContext,
  emitMarkupRepresentation,
} from './drawing-markup-geometry.js';
import { DRAWING_MARKUP_OBJECTTYPE, DRAWING_MARKUP_PSET_NAME, DRAWING_MARKUP_QSET_NAME } from './drawing-markup-tags.js';

export {
  DRAWING_MARKUP_OBJECTTYPE,
  DRAWING_MARKUP_PSET_NAME,
  DRAWING_MARKUP_QSET_NAME,
  type DrawingMarkupObjectType,
} from './drawing-markup-tags.js';

/** A 2D point in drawing space (metres). Structurally matches `Drawing2DState`'s `Point2D`. */
export interface MarkupPoint2D {
  x: number;
  y: number;
}

/**
 * Placement/unit context shared by every markup builder — the subset of
 * `SpatialAnchor` (`anchor.ts`) markup needs. Deliberately narrower than the
 * full `SpatialAnchor`: markup has no Body/Axis solid geometry, so it needs
 * no `bodyContextId`/`axisContextId`.
 */
export interface MarkupAnchor {
  /** IfcOwnerHistory expressId, or null when the model has none (see `SpatialAnchor`). */
  ownerHistoryId: number | null;
  /** The IfcLocalPlacement each markup annotation's own placement chains from
   *  (typically the target storey's placement, from `resolveSpatialAnchor`). */
  storeyPlacementId: number;
  /** Target schema; see `SpatialAnchor.schema`. Defaults to IFC4. */
  schema?: SpatialAnchorSchema;
  /** Model length-unit scale (metres per native unit); see `SpatialAnchor.lengthUnitScale`. */
  lengthUnitScale?: number;
  /** Optional seeded randomness for emitted GlobalIds; see `SpatialAnchor.guidRandom`. */
  guidRandom?: RandomSource;
}

export interface MeasureMarkupParams {
  start: MarkupPoint2D;
  end: MarkupPoint2D;
  /** Measured distance, metres — preserved verbatim so a reader restores it
   *  without recomputing from the (possibly re-projected) polyline. */
  distance: number;
  Name?: string;
}

export interface MeasureMarkupResult {
  annotationId: number;
  placementId: number;
  polylineId: number;
  shapeRepId: number;
  productShapeId: number;
}

export interface PolygonAreaMarkupParams {
  /** Closed polygon vertices, drawing coords (metres). */
  points: MarkupPoint2D[];
  area: number;
  perimeter: number;
  Name?: string;
}

export interface PolygonAreaMarkupResult {
  annotationId: number;
  placementId: number;
  polylineId: number;
  shapeRepId: number;
  productShapeId: number;
}

export interface TextMarkupParams {
  /** Top-left corner, drawing coords (metres). */
  position: MarkupPoint2D;
  text: string;
  /** IfcPlanarExtent (SizeInX, SizeInY), metres. Defaults are a nominal box —
   *  a future "save into model" action should size this from the on-screen
   *  layout, since `fontSize` alone doesn't determine a world-space extent. */
  extent?: { sizeX: number; sizeY: number };
  boxAlignment?: string;
  Name?: string;
}

export interface TextMarkupResult {
  annotationId: number;
  placementId: number;
  textLiteralId: number;
  shapeRepId: number;
  productShapeId: number;
}

export interface CloudMarkupParams {
  /** Rectangle corners, drawing coords (metres): [topLeft, bottomRight]. */
  points: readonly [MarkupPoint2D, MarkupPoint2D];
  label: string;
  Name?: string;
}

export interface CloudMarkupResult {
  annotationId: number;
  placementId: number;
  polylineId: number;
  fillAreaId: number;
  shapeRepId: number;
  productShapeId: number;
}

/**
 * A drawing-space coordinate may legitimately be negative or zero — the
 * caller's own drawing origin, not this module's to constrain — so this only
 * rejects NaN/Infinity, never a sign check. Same split `spatial-zone.ts`'s
 * `validateZone` uses for its Footprint points, the closest analog: without
 * it, a NaN/Infinity coordinate reaches `IfcCartesianPoint` as the literal
 * `$` inside a mandatory-REAL attribute list — schema-invalid STEP written
 * with no error.
 */
function assertFinitePoint(functionName: string, label: string, p: MarkupPoint2D): void {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    throw new Error(`${functionName}: ${label} needs a finite point`);
  }
}

/**
 * Distance/area/perimeter/extent are derived measurements: never negative,
 * but legitimately zero (a degenerate measurement, e.g. a zero-length
 * measure). So this rejects NaN/Infinity and negative values, not `<= 0`
 * like `_emit-helpers.ts`'s `assertPositiveFinite` (which guards true
 * dimensions — Width, Height — that can never be zero). Without this, a NaN
 * silently becomes a zeroed quantity value on write (`toNativeLength(NaN)`
 * multiplies through to `NaN`, which the STEP writer would still need to
 * catch) rather than failing loudly here.
 */
function assertFiniteNonNegative(functionName: string, label: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${functionName}: ${label} must be finite and non-negative`);
  }
}

/** IfcAnnotation attribute order: GlobalId, OwnerHistory, Name, Description,
 *  ObjectType, ObjectPlacement, Representation — same 7-slot shape across
 *  IFC2X3/IFC4/IFC4X3 (schema-registry.ts `IfcAnnotation.allAttributes`). */
function emitAnnotation(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  name: string,
  objectType: string,
  placementId: number,
  productShapeId: number,
): number {
  return editor.addEntity('IfcAnnotation', [
    generateIfcGuid(anchor.guidRandom),
    ownerHistoryRef(anchor.ownerHistoryId),
    name,
    null,
    objectType,
    `#${placementId}`,
    `#${productShapeId}`,
  ]).expressId;
}

/** A polyline annotation for one `Measure2DResult`. Distance is preserved as
 *  a LENGTH quantity (native length unit, matching every other in-store
 *  builder's LENGTH convention — see `space.ts`'s `GrossPerimeter`) rather
 *  than recomputed from the two endpoints on read-back. */
export function addMeasureMarkupToStore(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  contextId: number,
  params: MeasureMarkupParams,
): MeasureMarkupResult {
  assertFinitePoint('addMeasureMarkupToStore', 'start', params.start);
  assertFinitePoint('addMeasureMarkupToStore', 'end', params.end);
  assertFiniteNonNegative('addMeasureMarkupToStore', 'distance', params.distance);
  const n = (metres: number) => toNativeLength(anchor, metres);
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, [0, 0, 0]);
  const polylineId = emitMarkupPolyline(
    editor,
    [[n(params.start.x), n(params.start.y)], [n(params.end.x), n(params.end.y)]],
    false,
  );
  const { shapeRepId, productShapeId } = emitMarkupRepresentation(editor, contextId, 'Curve2D', polylineId);
  const annotationId = emitAnnotation(
    editor, anchor, params.Name ?? 'Measurement', DRAWING_MARKUP_OBJECTTYPE.MEASURE, placementId, productShapeId,
  );
  editor.addQuantitySet(annotationId, DRAWING_MARKUP_QSET_NAME, [
    { name: 'Distance', value: n(params.distance), quantityType: 'LENGTH' },
  ]);
  return { annotationId, placementId, polylineId, shapeRepId, productShapeId };
}

/** A closed polyline annotation for one `PolygonArea2DResult`. Area/perimeter
 *  preserved so a reader doesn't recompute a shoelace sum from re-projected
 *  points (area is SI m², not unit-scaled — same split `space.ts` uses for
 *  AREA vs LENGTH quantities). */
export function addPolygonAreaMarkupToStore(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  contextId: number,
  params: PolygonAreaMarkupParams,
): PolygonAreaMarkupResult {
  if (params.points.length < 3) {
    throw new Error('addPolygonAreaMarkupToStore: needs at least 3 points');
  }
  for (const [i, point] of params.points.entries()) {
    assertFinitePoint('addPolygonAreaMarkupToStore', `points[${i}]`, point);
  }
  assertFiniteNonNegative('addPolygonAreaMarkupToStore', 'area', params.area);
  assertFiniteNonNegative('addPolygonAreaMarkupToStore', 'perimeter', params.perimeter);
  const n = (metres: number) => toNativeLength(anchor, metres);
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, [0, 0, 0]);
  const polylineId = emitMarkupPolyline(editor, params.points.map((p): [number, number] => [n(p.x), n(p.y)]), true);
  const { shapeRepId, productShapeId } = emitMarkupRepresentation(editor, contextId, 'Curve2D', polylineId);
  const annotationId = emitAnnotation(
    editor, anchor, params.Name ?? 'Area', DRAWING_MARKUP_OBJECTTYPE.POLYGON_AREA, placementId, productShapeId,
  );
  editor.addQuantitySet(annotationId, DRAWING_MARKUP_QSET_NAME, [
    { name: 'Area', value: params.area, quantityType: 'AREA' },
    { name: 'Perimeter', value: n(params.perimeter), quantityType: 'LENGTH' },
  ]);
  return { annotationId, placementId, polylineId, shapeRepId, productShapeId };
}

/** An `IfcTextLiteralWithExtent` annotation for one `TextAnnotation2D`. The
 *  literal string is the derived value here — it lives in `Literal` itself,
 *  the same field the read-side symbolic parser already consumes, so no
 *  separate property-set copy is needed (unlike distance/area/perimeter,
 *  which have nowhere else to live). `fontSize`/colors are display-only
 *  presentation state, not a derived value this issue asks to preserve, and
 *  are left for a future presentation-style follow-up. */
export function addTextMarkupToStore(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  contextId: number,
  params: TextMarkupParams,
): TextMarkupResult {
  assertFinitePoint('addTextMarkupToStore', 'position', params.position);
  const extent = params.extent ?? { sizeX: 1, sizeY: 0.25 };
  assertFiniteNonNegative('addTextMarkupToStore', 'extent.sizeX', extent.sizeX);
  assertFiniteNonNegative('addTextMarkupToStore', 'extent.sizeY', extent.sizeY);
  const n = (metres: number) => toNativeLength(anchor, metres);
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, [0, 0, 0]);
  const textPlacementId = emitMarkupPoint2DPlacement(editor, [n(params.position.x), n(params.position.y)]);
  const extentId = editor.addEntity('IfcPlanarExtent', [n(extent.sizeX), n(extent.sizeY)]).expressId;
  const textLiteralId = editor.addEntity('IfcTextLiteralWithExtent', [
    params.text,
    `#${textPlacementId}`,
    '.RIGHT.',
    `#${extentId}`,
    params.boxAlignment ?? 'top-left',
  ]).expressId;
  const { shapeRepId, productShapeId } = emitMarkupRepresentation(editor, contextId, 'Annotation2D', textLiteralId);
  const annotationId = emitAnnotation(
    editor, anchor, params.Name ?? 'Note', DRAWING_MARKUP_OBJECTTYPE.TEXT, placementId, productShapeId,
  );
  return { annotationId, placementId, textLiteralId, shapeRepId, productShapeId };
}

/**
 * An `IfcAnnotationFillArea` annotation for one `CloudAnnotation2D`.
 *
 * Chose fill-area over a bare polyline because a revision cloud is
 * semantically a bounded REGION (its two stored points are a rectangle's
 * corners, not an open path), and `IfcAnnotationFillArea` is what the read
 * side's own symbolic parser already recognises as a fill (`AnnotationFill2D`
 * in `apps/viewer/src/lib/overlay-parse/symbolic-shapes.ts`) — a bare
 * polyline would render as an outline only, losing the "this is a cloud
 * region" distinction a reader needs to tell it apart from a measurement.
 */
export function addCloudMarkupToStore(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  contextId: number,
  params: CloudMarkupParams,
): CloudMarkupResult {
  const [topLeft, bottomRight] = params.points;
  assertFinitePoint('addCloudMarkupToStore', 'points[0]', topLeft);
  assertFinitePoint('addCloudMarkupToStore', 'points[1]', bottomRight);
  const n = (metres: number) => toNativeLength(anchor, metres);
  const corners: Array<[number, number]> = [
    [n(topLeft.x), n(topLeft.y)],
    [n(bottomRight.x), n(topLeft.y)],
    [n(bottomRight.x), n(bottomRight.y)],
    [n(topLeft.x), n(bottomRight.y)],
  ];
  const placementId = emitLocalPlacement(editor, anchor.storeyPlacementId, [0, 0, 0]);
  const polylineId = emitMarkupPolyline(editor, corners, true);
  const fillAreaId = editor.addEntity('IfcAnnotationFillArea', [`#${polylineId}`, null]).expressId;
  const { shapeRepId, productShapeId } = emitMarkupRepresentation(editor, contextId, 'Annotation2D', fillAreaId);
  const annotationId = emitAnnotation(
    editor, anchor, params.Name ?? 'Cloud', DRAWING_MARKUP_OBJECTTYPE.CLOUD, placementId, productShapeId,
  );
  editor.addPropertySet(annotationId, DRAWING_MARKUP_PSET_NAME, [
    { name: 'Label', value: params.label, type: 'TEXT' },
  ]);
  return { annotationId, placementId, polylineId, fillAreaId, shapeRepId, productShapeId };
}

/** Batch input mirroring the four markup arrays on `Drawing2DState`
 *  (`apps/viewer/src/store/slices/drawing2DSlice.ts`) structurally, without
 *  importing that module. `id` fields are accepted and ignored here — the
 *  overlay expressId IS the new stable identity; carrying the old
 *  browser-local id forward is a read-side/UI concern. */
export interface DrawingMarkupBatchInput {
  measure2DResults?: Array<{ id: string } & MeasureMarkupParams>;
  polygonArea2DResults?: Array<{ id: string } & PolygonAreaMarkupParams>;
  textAnnotations2D?: Array<{ id: string } & TextMarkupParams>;
  cloudAnnotations2D?: Array<{ id: string } & CloudMarkupParams>;
}

export interface DrawingMarkupBatchResult {
  subContextId: number;
  measures: MeasureMarkupResult[];
  polygons: PolygonAreaMarkupResult[];
  texts: TextMarkupResult[];
  clouds: CloudMarkupResult[];
}

/**
 * Translate a full `Drawing2DState` markup snapshot into the store overlay:
 * one shared `Annotation` `IfcGeometricRepresentationSubContext` (created
 * fresh under `rootContextId`, the model's root 3D
 * `IfcGeometricRepresentationContext`), then one `IfcAnnotation` per markup
 * item, tagged per {@link DRAWING_MARKUP_OBJECTTYPE}.
 */
export function addDrawingMarkupToStore(
  editor: StoreEditor,
  anchor: MarkupAnchor,
  rootContextId: number,
  input: DrawingMarkupBatchInput,
  targetView: 'PLAN_VIEW' | 'SECTION_VIEW' = 'PLAN_VIEW',
): DrawingMarkupBatchResult {
  const subContextId = emitMarkupSubContext(editor, rootContextId, targetView);
  const measures = (input.measure2DResults ?? []).map((m) => addMeasureMarkupToStore(editor, anchor, subContextId, m));
  const polygons = (input.polygonArea2DResults ?? []).map((p) => addPolygonAreaMarkupToStore(editor, anchor, subContextId, p));
  const texts = (input.textAnnotations2D ?? []).map((t) => addTextMarkupToStore(editor, anchor, subContextId, t));
  const clouds = (input.cloudAnnotations2D ?? []).map((c) => addCloudMarkupToStore(editor, anchor, subContextId, c));
  return { subContextId, measures, polygons, texts, clouds };
}
