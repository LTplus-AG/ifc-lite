/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Read side of "save 2D drawing markup into the IFC model" (issue #4153).
 *
 * The write side (`@ifc-lite/create`'s `drawing-markup.ts`, PR #4160) tags
 * an `IfcAnnotation.ObjectType` with `DRAWING_MARKUP_OBJECTTYPE.*` and
 * stores its derived values (distance/area/perimeter, a cloud's label) in
 * `Qto_IfcLiteMarkup` / `Pset_IfcLiteMarkup`. Without a reader that
 * recognises that tag, saved markup comes back through the generic
 * symbolic-annotation overlay as untyped polylines/text/fills — visible,
 * but no longer an editable `Measure2DResult`/`PolygonArea2DResult`/
 * `TextAnnotation2D`/`CloudAnnotation2D`.
 *
 * This module does NOT re-parse IFC geometry. It takes the `DrawingLine2D`/
 * `AnnotationText2D`/`AnnotationFill2D` primitives `symbolic-parse.ts`
 * already produced for an annotation (grouped by `ownerId`, the entity's
 * expressId) plus that entity's `ObjectType` and property/quantity-set
 * values, and reconstructs the typed markup object. Geometry from the
 * parse is already in metres — the WASM extractor multiplies every
 * coordinate by the model's unit scale as it tessellates
 * (`rust/processing/src/symbolic/*.rs`), so no unit conversion is needed
 * there. Only the DERIVED VALUES need one: the writer stored
 * distance/perimeter through `toNativeLength` (metres → native unit,
 * `packages/create/src/in-store/anchor.ts`), and a quantity-set read
 * returns the raw stored (native-unit) number unconverted — the same
 * asymmetry `fix(ids): scale Qto_ length quantities to base SI before an
 * IDS comparison (#3458)` fixed for IDS. This reader inverts it with
 * `fromNativeLength`, `anchor.ts`'s own counterpart to the writer's
 * `toNativeLength` — not a second implementation of the same rounding rule.
 *
 * Trust-vs-recompute: the stored quantity value is treated as the
 * authoritative distance/area/perimeter, not a re-derivation from the
 * tessellated points. Two reasons. First, `drawing-markup.ts`'s own doc
 * comments say why the writer preserves these verbatim rather than letting
 * a reader recompute them: the points a reader sees have been carried
 * through STEP export/import and (for a real "save into model" action, not
 * yet wired) a drawing-to-model reprojection, so a shoelace/hypot
 * recompute over them is not guaranteed to reproduce the value the user
 * actually measured on their own authored polygon. Second, `Area` is
 * DELIBERATELY stored unscaled (raw SI m²) while `Distance`/`Perimeter`
 * are native-length-scaled — an intentional asymmetry this reader must
 * mirror, not "fix" by recomputing one and not the other. Recomputing IS
 * cheap to check, though (geometry is already in hand), so every reader
 * below computes the geometric value too and warns on a mismatch beyond a
 * relative tolerance — evidence for the next person to inspect a
 * hand-edited or unit-changed file, without overriding the trusted value.
 * That trust has one floor: a stored `Distance`/`Area`/`Perimeter` of zero
 * or less can never be a real measurement, so it is never trusted — the
 * geometry-derived value is used instead (see
 * `drawing-markup-read-trust.ts`'s `resolveTrustedOrComputed`).
 *
 * Malformed input (missing geometry, a missing quantity/property set, or a
 * point count that cannot form the shape) makes a single reader return
 * `null`; the caller skips that entry and continues — mirrors
 * `annotationsSlice.ts`'s loader, never throws.
 */

import {
  DRAWING_MARKUP_OBJECTTYPE,
  fromNativeLength,
  type DrawingMarkupObjectType,
} from '@ifc-lite/create';
import type { DrawingLine2D } from '@ifc-lite/renderer';
import type { AnnotationFill2D, AnnotationText2D, ParseResult } from './symbolic-shapes.js';
import {
  polygonPointsFromFillRing,
  polygonPointsFromSegmentStarts,
  shoelaceArea,
  type MarkupPoint2D,
} from './drawing-markup-read-geometry.js';
import { resolveTrustedOrComputed } from './drawing-markup-read-trust.js';
import { toAuthoredPoint, type DrawingMarkupPlacementAnchor } from './drawing-markup-read-placement.js';

export type { DrawingMarkupPlacementAnchor } from './drawing-markup-read-placement.js';

export { warnOnDerivedValueMismatch, warnOnNonPositiveStoredValue } from './drawing-markup-read-trust.js';

export type { MarkupPoint2D };

export interface Measure2DResult {
  id: string;
  start: MarkupPoint2D;
  end: MarkupPoint2D;
  distance: number;
}

export interface PolygonArea2DResult {
  id: string;
  points: MarkupPoint2D[];
  area: number;
  perimeter: number;
}

/** Presentation fields IFC does not carry (issue #4153's write side left
 *  `fontSize`/colors as a future presentation-style follow-up) fall back to
 *  `Drawing2DState`'s own documented defaults (`drawing2DSlice.ts`:
 *  "Font size in screen px (default 14)" / colors `#000000`). */
export const TEXT_MARKUP_DEFAULT_FONT_SIZE = 14;
export const TEXT_MARKUP_DEFAULT_COLOR = '#000000';
export const TEXT_MARKUP_DEFAULT_BACKGROUND_COLOR = '#ffffff';
export const TEXT_MARKUP_DEFAULT_BORDER_COLOR = '#000000';
/** Cloud stroke-color default, mirroring `drawing2DSlice.ts`'s
 *  `completeCloudAnnotation2D` (`color: '#E53935'`) — a cloud's IFC
 *  representation (`IfcAnnotationFillArea`) carries no color attribute. */
export const CLOUD_MARKUP_DEFAULT_COLOR = '#E53935';

export interface TextAnnotation2D {
  id: string;
  position: MarkupPoint2D;
  text: string;
  fontSize: number;
  color: string;
  backgroundColor: string;
  borderColor: string;
}

export interface CloudAnnotation2D {
  id: string;
  points: [MarkupPoint2D, MarkupPoint2D];
  color: string;
  label: string;
}

/** Everything one `DrawingMarkupObjectType`-tagged `IfcAnnotation` needs to
 *  rehydrate: the geometry `symbolic-parse.ts` already produced for it
 *  (filtered to this entity's `ownerId`) plus its tag and property data. */
export interface DrawingMarkupAnnotationSource {
  expressId: number;
  /** `IfcAnnotation.ObjectType`. Anything other than a
   *  `DRAWING_MARKUP_OBJECTTYPE` value (including `null`/`undefined` — no
   *  `ObjectType`, or an annotation authored by another tool) is ignored:
   *  it keeps rendering through the generic symbolic overlay, unchanged. */
  objectType: string | null | undefined;
  lines: DrawingLine2D[];
  texts: AnnotationText2D[];
  fills: AnnotationFill2D[];
  /** `Qto_IfcLiteMarkup` quantity values, RAW as stored (native length
   *  unit for LENGTH quantities, unscaled SI for AREA — see the writer's
   *  own convention note above). Keyed by quantity `Name`. */
  quantities?: ReadonlyMap<string, number>;
  /** `Pset_IfcLiteMarkup` property values. Keyed by property `Name`. */
  properties?: ReadonlyMap<string, string>;
}

/**
 * Length-unit scale, plus (see `drawing-markup-read-placement.ts`) the
 * placement context {@link toAuthoredPoint} needs to undo the annotation's
 * `ObjectPlacement` chain and the symbolic parser's plan-Y negation.
 * `DrawingMarkupPlacementAnchor` moved to its own module so this one stays
 * under the ~400 line house limit; re-exported under its historical name so
 * existing callers/tests are unaffected.
 */
export type DrawingMarkupUnitAnchor = DrawingMarkupPlacementAnchor;

function readMeasure(
  source: DrawingMarkupAnnotationSource,
  anchor: DrawingMarkupUnitAnchor,
): Measure2DResult | null {
  if (source.lines.length !== 1) return null; // needs exactly one segment (2 points)
  const rawDistance = source.quantities?.get('Distance');
  if (typeof rawDistance !== 'number' || !Number.isFinite(rawDistance)) return null;

  const { start, end } = source.lines[0].line;
  const trustedDistance = fromNativeLength(anchor, rawDistance);
  const computed = Math.hypot(end.x - start.x, end.y - start.y);
  const distance = resolveTrustedOrComputed('measure', source.expressId, 'Distance', trustedDistance, computed);

  return {
    id: `ifc-measure-${source.expressId}`,
    start: toAuthoredPoint(source.expressId, anchor, { x: start.x, y: start.y }),
    end: toAuthoredPoint(source.expressId, anchor, { x: end.x, y: end.y }),
    distance,
  };
}

function readPolygonArea(
  source: DrawingMarkupAnnotationSource,
  anchor: DrawingMarkupUnitAnchor,
): PolygonArea2DResult | null {
  if (source.lines.length < 3) return null; // fewer than a triangle's worth of segments
  const rawArea = source.quantities?.get('Area');
  const rawPerimeter = source.quantities?.get('Perimeter');
  if (typeof rawArea !== 'number' || !Number.isFinite(rawArea)) return null;
  if (typeof rawPerimeter !== 'number' || !Number.isFinite(rawPerimeter)) return null;

  const points = polygonPointsFromSegmentStarts(source.lines);
  if (points.length < 3) return null;

  let computedPerimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    computedPerimeter += Math.hypot(b.x - a.x, b.y - a.y);
  }
  const computedArea = shoelaceArea(points);

  // Area is deliberately NOT unit-scaled (raw SI m², same convention
  // `space.ts` uses for `GrossFloorArea`) — do not run it through
  // `fromNativeLength`.
  const area = resolveTrustedOrComputed('polygon-area', source.expressId, 'Area', rawArea, computedArea);
  const trustedPerimeter = fromNativeLength(anchor, rawPerimeter);
  const perimeter = resolveTrustedOrComputed(
    'polygon-area', source.expressId, 'Perimeter', trustedPerimeter, computedPerimeter,
  );

  return {
    id: `ifc-polygon-${source.expressId}`,
    points: points.map((p) => toAuthoredPoint(source.expressId, anchor, p)),
    area,
    perimeter,
  };
}

function readText(
  source: DrawingMarkupAnnotationSource,
  anchor: DrawingMarkupUnitAnchor,
): TextAnnotation2D | null {
  if (source.texts.length === 0) return null;
  // A multi-line literal splits into one AnnotationText2D per line
  // (`symbolic-parse.ts`), each carrying `lineYOffset` (0, then
  // increasingly negative). Rejoin in that order to recover the original
  // `\n`-joined string; position is the shared anchor point every line
  // reports (`flat.textX[i]`/`flat.textY[i]` are identical across a
  // literal's split lines).
  const ordered = [...source.texts].sort((a, b) => (b.lineYOffset ?? 0) - (a.lineYOffset ?? 0));
  const text = ordered.map((t) => t.content).join('\n');
  const { x, y } = ordered[0];

  return {
    id: `ifc-text-${source.expressId}`,
    position: toAuthoredPoint(source.expressId, anchor, { x, y }),
    text,
    fontSize: TEXT_MARKUP_DEFAULT_FONT_SIZE,
    color: TEXT_MARKUP_DEFAULT_COLOR,
    backgroundColor: TEXT_MARKUP_DEFAULT_BACKGROUND_COLOR,
    borderColor: TEXT_MARKUP_DEFAULT_BORDER_COLOR,
  };
}

function readCloud(
  source: DrawingMarkupAnnotationSource,
  anchor: DrawingMarkupUnitAnchor,
): CloudAnnotation2D | null {
  if (source.fills.length !== 1) return null;
  const fill = source.fills[0];
  if (fill.holesOffsets.length > 0) return null; // a plain rectangle never has holes
  const label = source.properties?.get('Label');
  if (typeof label !== 'string') return null;

  const corners = polygonPointsFromFillRing(fill.points);
  if (corners.length !== 4) return null; // writer always emits a 4-corner rectangle

  return {
    id: `ifc-cloud-${source.expressId}`,
    points: [
      toAuthoredPoint(source.expressId, anchor, corners[0]),
      toAuthoredPoint(source.expressId, anchor, corners[2]),
    ],
    color: CLOUD_MARKUP_DEFAULT_COLOR,
    label,
  };
}

export interface DrawingMarkupReadResult {
  measure2DResults: Measure2DResult[];
  polygonArea2DResults: PolygonArea2DResult[];
  textAnnotations2D: TextAnnotation2D[];
  cloudAnnotations2D: CloudAnnotation2D[];
}

function emptyResult(): DrawingMarkupReadResult {
  return { measure2DResults: [], polygonArea2DResults: [], textAnnotations2D: [], cloudAnnotations2D: [] };
}

/**
 * Recognise one annotation's tag and rehydrate it. Returns `null` for an
 * untagged annotation (no `ObjectType`, or one not in
 * `DRAWING_MARKUP_OBJECTTYPE`) OR a tagged-but-malformed one — both cases
 * the caller should leave to the generic overlay / skip, never throw for.
 */
export function readDrawingMarkupAnnotation(
  source: DrawingMarkupAnnotationSource,
  anchor: DrawingMarkupUnitAnchor = {},
):
  | { kind: 'measure'; value: Measure2DResult }
  | { kind: 'polygon'; value: PolygonArea2DResult }
  | { kind: 'text'; value: TextAnnotation2D }
  | { kind: 'cloud'; value: CloudAnnotation2D }
  | null {
  const objectType = source.objectType as DrawingMarkupObjectType | null | undefined;
  switch (objectType) {
    case DRAWING_MARKUP_OBJECTTYPE.MEASURE: {
      const value = readMeasure(source, anchor);
      return value ? { kind: 'measure', value } : null;
    }
    case DRAWING_MARKUP_OBJECTTYPE.POLYGON_AREA: {
      const value = readPolygonArea(source, anchor);
      return value ? { kind: 'polygon', value } : null;
    }
    case DRAWING_MARKUP_OBJECTTYPE.TEXT: {
      const value = readText(source, anchor);
      return value ? { kind: 'text', value } : null;
    }
    case DRAWING_MARKUP_OBJECTTYPE.CLOUD: {
      const value = readCloud(source, anchor);
      return value ? { kind: 'cloud', value } : null;
    }
    default:
      return null; // untagged — not our concern, generic overlay handles it
  }
}

/** Per-entity `ObjectType` + property/quantity data, however the caller
 *  wants to source it (a `PropertyTable`, raw entity attributes, a test
 *  fixture, …) — this module has no opinion on that lookup's shape. */
export type DrawingMarkupMetaLookup = (expressId: number) => {
  objectType: string | null | undefined;
  quantities?: ReadonlyMap<string, number>;
  properties?: ReadonlyMap<string, string>;
} | undefined;

/**
 * Batch entry point: walk a `ParseResult`'s IfcAnnotation buckets (`byStorey`
 * + `loose` — never the parallel `gridByStorey`/`gridLoose` IfcGridAxis
 * buckets, since markup is never tagged on a grid axis), group each
 * primitive by `ownerId`, and rehydrate every tagged, well-formed entry.
 * Untagged / malformed entries are silently skipped — they are left for the
 * existing generic overlay renderer, which reads the same `ParseResult`
 * unchanged.
 */
export function readDrawingMarkupFromParseResult(
  parseResult: Pick<ParseResult, 'byStorey' | 'loose' | 'looseTexts' | 'looseFills'>,
  meta: DrawingMarkupMetaLookup,
  anchor: DrawingMarkupUnitAnchor = {},
): DrawingMarkupReadResult {
  const lines: DrawingLine2D[] = [...parseResult.loose];
  const texts: AnnotationText2D[] = [...parseResult.looseTexts];
  const fills: AnnotationFill2D[] = [...parseResult.looseFills];
  for (const bucket of parseResult.byStorey.values()) {
    lines.push(...bucket.lines);
    texts.push(...bucket.texts);
    fills.push(...bucket.fills);
  }

  const ownerIds = new Set<number>();
  for (const l of lines) if (l.ownerId !== undefined) ownerIds.add(l.ownerId);
  for (const t of texts) ownerIds.add(t.ownerId);
  for (const f of fills) ownerIds.add(f.ownerId);

  const result = emptyResult();
  for (const expressId of ownerIds) {
    const entry = meta(expressId);
    if (!entry) continue;
    const source: DrawingMarkupAnnotationSource = {
      expressId,
      objectType: entry.objectType,
      lines: lines.filter((l) => l.ownerId === expressId),
      texts: texts.filter((t) => t.ownerId === expressId),
      fills: fills.filter((f) => f.ownerId === expressId),
      quantities: entry.quantities,
      properties: entry.properties,
    };
    const read = readDrawingMarkupAnnotation(source, anchor);
    if (!read) continue;
    switch (read.kind) {
      case 'measure': result.measure2DResults.push(read.value); break;
      case 'polygon': result.polygonArea2DResults.push(read.value); break;
      case 'text': result.textAnnotations2D.push(read.value); break;
      case 'cloud': result.cloudAnnotations2D.push(read.value); break;
    }
  }
  return result;
}
