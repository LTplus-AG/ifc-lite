/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round-trip tag values for 2D drawing markup translated into IFC by
 * `drawing-markup.ts`. Stamped into `IfcAnnotation.ObjectType` — the same
 * spot `generate-spaces.ts`'s `GENERATED_SPACE_OBJECTTYPE` uses to mark a
 * baked `IfcSpace` as tool-generated.
 *
 * Without this, saved markup reads back through the generic symbolic-overlay
 * parser as plain polylines/text/fills — visible, but no longer the typed
 * `Measure2DResult` / `PolygonArea2DResult` / `TextAnnotation2D` /
 * `CloudAnnotation2D` it started as, and no longer editable as one.
 *
 * Exported from this ONE place so a future read-side translator (issue
 * #4153's read-back follow-up — not implemented here) imports these instead
 * of re-declaring the string literals. Two independently-typed copies of the
 * same tag is exactly the failure mode this exists to prevent: the writer
 * tags with one spelling, the reader checks for another, and every saved
 * annotation silently falls back to untyped overlay geometry.
 */
export const DRAWING_MARKUP_OBJECTTYPE = {
  MEASURE: 'IfcLite:Markup:Measure',
  POLYGON_AREA: 'IfcLite:Markup:PolygonArea',
  TEXT: 'IfcLite:Markup:Text',
  CLOUD: 'IfcLite:Markup:Cloud',
} as const;

export type DrawingMarkupObjectType =
  (typeof DRAWING_MARKUP_OBJECTTYPE)[keyof typeof DRAWING_MARKUP_OBJECTTYPE];

/** The derived-value quantity/property set names markup entities carry. */
export const DRAWING_MARKUP_QSET_NAME = 'Qto_IfcLiteMarkup';
export const DRAWING_MARKUP_PSET_NAME = 'Pset_IfcLiteMarkup';
