/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Turning a zone set into `IfcSpatialZone` entities (issue #2508 item 3).
 *
 * The emission itself is `@ifc-lite/create`'s `addSpatialZonesToStore`, which
 * knows the schema and nothing about the viewer. This module owns the one thing
 * only the viewer can answer: WHICH FRAME the numbers are in.
 *
 * ## The frame chain, which is the part that goes wrong quietly
 *
 * A zone is authored against the rendered scene, so its coordinates are in the
 * render frame: Y-up, RTC-subtracted, unit-scaled to metres. An
 * `IfcSpatialZone` has to land in the file's own frame: Z-up, un-shifted, in
 * the file's declared length unit. Three separate conversions, and getting any
 * one wrong produces a zone that is plausible and in the wrong place:
 *
 * 1. **Un-shift** with {@link renderToWorldViewer}, which adds back both the
 *    wasm RTC offset and the coordinate handler's origin shift. Reusing
 *    #2199's helper rather than re-deriving it: the two offsets are recorded in
 *    DIFFERENT axes, and adding them in the same axes folds a model's north
 *    offset into its height.
 * 2. **Swap axes** with {@link viewerToIfcAxes} (Y-up to Z-up).
 * 3. **Scale to native units**, which the builder does from the anchor rather
 *    than this module, so there is one place that knows the file's unit.
 *
 * ## Why a re-based model is refused
 *
 * Federation alignment can re-base a model into the anchor file's frame
 * (`'same-crs'` / `'reprojected'`). Undoing the render shift then yields
 * coordinates in the ANCHOR's coordinate system, not in this model's own, so
 * writing them into this model's file would place the zone by someone else's
 * origin. That is the same condition the apportionment refuses as
 * `'rescaled-by-alignment'`, refused here for the same reason.
 */

import {
  addSpatialZonesToStore,
  spatialZonesSupported,
  resolveSpatialAnchor,
  type SpatialZoneInput,
} from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import {
  renderToWorldViewer,
  viewerToIfcAxes,
  type RenderFrameOffsets,
} from '@/components/viewer/tools/measure-modes/coordinates';
import type { Zone, ZoneSet } from './types.js';

/** One element's membership, as the assignment engine reports it. */
export interface ZoneMembership {
  /** Model-local expressId - the caller has already resolved the federated id. */
  expressId: number;
  /** Zone ids this element reaches, straddlers included. */
  touchedZoneIds: string[];
}

export type EmitRefusal =
  /** The file predates `IfcSpatialZone` (IFC2X3). */
  | 'schema-too-old'
  /** Federation alignment re-based this model, so the render frame is not
   *  invertible back into its own coordinates. */
  | 'rescaled-by-alignment'
  /** No zone in the set has any elements, so there is nothing to reference. */
  | 'no-members'
  /** The model has no storey, or no representation context, to anchor against.
   *  A zone still needs a body context for its shape even though it is placed
   *  absolutely and contained by nothing. */
  | 'no-anchor'
  /** A zone in the set has a zero or non-finite extent, which would emit a
   *  degenerate solid. Refused for the WHOLE set rather than per zone: the
   *  builder emits zone by zone, so stopping halfway would leave one takt area
   *  in the file and the rest not. */
  | 'degenerate-zone';

export interface EmitResult {
  zonesEmitted: number;
  elementsReferenced: number;
  /** Zones from an earlier run of this set that this one replaced. */
  zonesReplaced: number;
  refusal: EmitRefusal | null;
}

/** Why one model got no zones, as a sentence rather than a code. Kept beside
 *  the refusals so a new one cannot be added without a way to say it. */
export function emitRefusalText(refusal: EmitRefusal, modelName: string): string {
  switch (refusal) {
    case 'schema-too-old':
      return `${modelName} is IFC2X3, which has no IfcSpatialZone`;
    case 'rescaled-by-alignment':
      return `${modelName} was re-based to align with another model, so its own coordinates cannot be recovered`;
    case 'no-members':
      return `No element of ${modelName} is in a zone of this set`;
    case 'no-anchor':
      return `${modelName} has no storey or representation context to anchor zones against`;
    case 'degenerate-zone':
      return 'A zone in this set has a zero extent, so nothing was emitted. Give it a real size and try again.';
  }
}

/** Render-frame zone to IFC-world zone. Exported for the frame test: this is
 *  the conversion, and it is worth pinning apart from the emission. */
export function zoneToIfcWorld(zone: Zone, frame: RenderFrameOffsets): SpatialZoneInput {
  const base = renderToWorldViewer(
    { x: zone.center[0], y: zone.center[1] - zone.size[1] / 2, z: zone.center[2] },
    frame,
  );
  const ifcBase = viewerToIfcAxes(base);

  const footprint = zone.footprint?.map(([x, z]): [number, number] => {
    // A footprint point is a render-frame X/Z pair at no particular height, so
    // it rides through the same un-shift at the zone's own base height. Only
    // the horizontal components are kept: the extrusion supplies the rest.
    const p = viewerToIfcAxes(renderToWorldViewer({ x, y: zone.center[1], z }, frame));
    return [p.x, p.y];
  });

  // ONE predicate for both halves of the decision. Keying the rotation off "has
  // a footprint" and the shape off "has three points" would, for a footprint
  // too small to be a polygon, emit the box fallback with the rotation thrown
  // away - an axis-aligned zone where the user drew a turned one.
  const usePolygon = footprint !== undefined && footprint.length >= 3;

  return {
    Name: zone.name,
    // The base, not the centre: an extruded solid grows along +Z from its
    // placement, so handing it the centre would raise the zone by half its
    // height.
    Position: [ifcBase.x, ifcBase.y, ifcBase.z],
    Width: zone.size[0],
    Depth: zone.size[2],
    Height: zone.size[1],
    // The viewer rotates about its Y, the file about its Z, and the axis swap
    // above turns one into the other. The SIGN flips with it: viewer +Y and IFC
    // +Z point the same way, but the swap mirrors the horizontal plane. A
    // polygon needs none of this: its points are already world-aligned.
    RotationZ: usePolygon ? 0 : 0 - zone.rotationY,
    ...(usePolygon ? { Footprint: footprint } : {}),
  };
}

/**
 * Emit `zoneSet` into `store`'s overlay as `IfcSpatialZone` entities.
 *
 * Returns what it did, or which condition stopped it. Never throws for a
 * refusable condition: the panel turns each into a sentence.
 */
export function emitSpatialZones(
  editor: StoreEditor,
  store: IfcDataStore,
  zoneSet: ZoneSet,
  members: ZoneMembership[],
  frame: RenderFrameOffsets,
  options: { rebased?: boolean; storeyId?: number } = {},
): EmitResult {
  const empty = { zonesEmitted: 0, elementsReferenced: 0, zonesReplaced: 0 };
  if (options.rebased) return { ...empty, refusal: 'rescaled-by-alignment' };

  const storeyId = options.storeyId ?? firstStoreyId(store);
  if (storeyId === null) return { ...empty, refusal: 'no-anchor' };
  let anchor;
  try {
    anchor = resolveSpatialAnchor(store, storeyId);
  } catch {
    // Thrown for a model with no representation context or an unplaced storey.
    // A refusal the panel can put in a sentence beats an exception from a
    // button press.
    return { ...empty, refusal: 'no-anchor' };
  }
  if (!spatialZonesSupported(anchor.schema)) return { ...empty, refusal: 'schema-too-old' };

  // Checked for EVERY zone before the first is written. The builder refuses a
  // degenerate zone by throwing, and it emits zone by zone, so validating as it
  // goes would leave the file holding whichever takt areas came first. All
  // three extents, not just the height: a zero width emits a rectangle profile
  // no reader can use, and the run would report success.
  if (zoneSet.zones.some((zone) => zone.size.some((extent) => !(Number.isFinite(extent) && extent > 0)))) {
    return { ...empty, refusal: 'degenerate-zone' };
  }

  const referenced = zoneSet.zones.map((zone) =>
    members.filter((m) => m.touchedZoneIds.includes(zone.id)).map((m) => m.expressId));
  const total = referenced.reduce((sum, ids) => sum + ids.length, 0);
  if (total === 0) return { ...empty, refusal: 'no-members' };

  // Replace rather than accumulate. Pressing the button twice would otherwise
  // leave two `IfcSpatialZone` entities per zone in the same place, and the
  // second run's numbers would be indistinguishable from the first's in the
  // exported file. Same principle as the write-back's per-element sweep.
  const zonesReplaced = removeSpatialZones(editor, zoneSet.name);

  const result = addSpatialZonesToStore(editor, anchor, {
    LongName: zoneSet.name,
    zones: zoneSet.zones.map((zone) => zoneToIfcWorld(zone, frame)),
    RelatedElements: referenced,
  });

  return {
    zonesEmitted: result.zoneIds.length,
    elementsReferenced: total,
    zonesReplaced,
    refusal: null,
  };
}

/** Attribute index of `IfcSpatialZone.LongName`, which carries the zone SET's
 *  name and is what identifies one run's output. */
const LONG_NAME = 7;
/** `IfcRelReferencedInSpatialStructure.RelatingStructure`. */
const RELATING_STRUCTURE = 5;

/**
 * Remove the zones one earlier run of `longName` emitted, and everything only
 * those zones referred to.
 *
 * Overlay-only, by construction: `editor.removeEntity` tombstones an entity
 * that exists in the FILE, so restricting the walk to entities this session
 * created is what keeps a re-import of a previous export from being gutted by a
 * later run. Zones re-imported that way are left alone and would be duplicated;
 * that is the honest limit of an overlay with no persistent identity.
 *
 * The walk follows references OUT of a zone and no further, which is safe
 * because every entity the builder emits per zone belongs to that zone alone:
 * the anchor's context and owner history are file entities, so the walk stops
 * at them. The relationship's `RelatedElements` are deliberately NOT traversed
 * - they are the user's own elements, and one of them may itself be an overlay
 * entity the user authored this session.
 */
export function removeSpatialZones(editor: StoreEditor, longName: string): number {
  const overlay = new Map(editor.getNewEntities().map((e) => [e.expressId, e]));
  const zoneIds = new Set<number>();
  for (const entity of overlay.values()) {
    if (entity.type !== 'IfcSpatialZone') continue;
    if (entity.attributes[LONG_NAME] !== longName) continue;
    zoneIds.add(entity.expressId);
  }
  if (zoneIds.size === 0) return 0;

  const doomed = new Set<number>(zoneIds);
  const queue = [...zoneIds];
  while (queue.length > 0) {
    const entity = overlay.get(queue.pop() as number);
    if (!entity) continue;
    for (const ref of refsOf(entity.attributes)) {
      // Only overlay entities: a `#N` pointing into the file is an anchor
      // reference, and deleting it would tombstone part of the model.
      if (!overlay.has(ref) || doomed.has(ref)) continue;
      doomed.add(ref);
      queue.push(ref);
    }
  }

  for (const entity of overlay.values()) {
    if (entity.type !== 'IfcRelReferencedInSpatialStructure') continue;
    const structure = entity.attributes[RELATING_STRUCTURE];
    if (typeof structure === 'string' && zoneIds.has(Number(structure.slice(1)))) {
      doomed.add(entity.expressId);
    }
  }

  for (const id of doomed) editor.removeEntity(id);
  return zoneIds.size;
}

/** Every `#N` an attribute list points at, one level deep, flattening lists. */
function refsOf(attributes: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const attribute of attributes) {
    for (const value of Array.isArray(attribute) ? attribute : [attribute]) {
      if (typeof value !== 'string' || !value.startsWith('#')) continue;
      const id = Number(value.slice(1));
      if (Number.isInteger(id)) out.push(id);
    }
  }
  return out;
}

/** The anchor needs a storey for its owner history and body context; any storey
 *  serves, since the zones themselves are placed absolutely and referenced
 *  rather than contained. */
function firstStoreyId(store: IfcDataStore): number | null {
  const storeys = store.entityIndex.byType?.get('IFCBUILDINGSTOREY');
  return storeys && storeys.length > 0 ? storeys[0] : null;
}
