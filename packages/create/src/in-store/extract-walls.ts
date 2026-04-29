/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pull every wall axis on a given storey from a parsed `IfcDataStore`
 * plus an optional overlay (`MutablePropertyView`-style new-entities
 * map). The resulting 2D segments feed `detectEnclosedAreas`.
 *
 * Two extraction strategies, tried in order:
 *
 *   1. **Axis representation** (preferred).
 *      `IfcShapeRepresentation` with `RepresentationIdentifier = 'Axis'`
 *      is the standard way authoring tools (Revit, ArchiCAD, etc.) ship
 *      a wall's centreline. Items are usually `IfcPolyline` (2 points →
 *      start, end) or `IfcTrimmedCurve` (treated as polyline endpoints).
 *      The endpoints are read in storey-local space, walked through the
 *      placement chain, and projected to the storey-floor plane.
 *
 *   2. **Body fallback — placement + IfcRectangleProfileDef.XDim**.
 *      Matches the convention emitted by `addWallToStore` /
 *      `IfcCreator.addIfcWall`: placement origin = wall Start,
 *      RefDirection = wall axis, profile XDim = wall length. Used for
 *      walls authored by the Add Element tool or anything else that
 *      mirrors that shape.
 *
 * Walls that match neither shape are skipped with a recorded reason —
 * `WallExtractionResult.skipped[]` carries `{ wallId, reason }` so
 * callers (and the viewer's Auto Spaces UI) can surface why a wall
 * didn't contribute to the planar graph.
 */

import {
  EntityExtractor,
  extractLengthUnitScale,
  type IfcDataStore,
  type IfcAttributeValue,
} from '@ifc-lite/parser';
import type { Segment, Vec2 } from './auto-space-detect.js';

/**
 * Optional overlay reader. If supplied, overlay walls (entities
 * created via `editor.addEntity('IfcWall', ...)` since the model was
 * parsed) are included alongside the source walls.
 */
export interface OverlayWallReader {
  /** Iterate every overlay-created entity. */
  getNewEntities(): Iterable<{ expressId: number; type: string; attributes: IfcAttributeValue[] }>;
  /** Resolve a positional attribute (with mutations applied). */
  getAttribute?(expressId: number, index: number): IfcAttributeValue | undefined;
}

export type WallSkipReason =
  | 'no-source-bytes'
  | 'wall-not-parsed'
  | 'no-placement'
  | 'no-representation'
  | 'placement-not-resolvable'
  | 'no-axis-or-rect-profile'
  | 'zero-length-axis'
  | 'sloped-axis';

export interface WallSkip {
  wallId: number;
  reason: WallSkipReason;
}

export interface WallExtractionResult {
  segments: Segment[];
  /** Wall expressIds that contributed an axis segment. */
  contributingWallIds: number[];
  /** Walls dropped by the extractor, with the reason. */
  skipped: WallSkip[];
  /** Best-effort total wall count visible on the storey (existing + overlay). */
  considered: number;
  /**
   * Length-unit scale that was applied to the extracted segments
   * (e.g. `0.001` for a millimetre model). Reported so callers can
   * scale their snap tolerance / min area to match.
   */
  lengthUnitScale: number;
}

export interface ExtractWallSegmentsOptions {
  /**
   * When true, the extractor emits `console.debug` messages for the
   * containment scan + per-wall extraction step. Useful for diagnosing
   * "no enclosed regions detected" in the Auto Spaces flow.
   */
  debug?: boolean;
  /**
   * Additional element types to treat as space dividers. Defaults to
   * the standard wall set; pass extras here to broaden coverage on
   * unusual models. Names are case-insensitive (`'IfcMember'` etc.).
   */
  extraDividerTypes?: string[];
}

/**
 * Element types treated as "wall-like" dividers by default. Extends
 * the obvious walls with curtain walls (often the only divider on a
 * storey full of glazing), virtual walls (used by IFC exports for
 * hypothetical room boundaries), and plates / members (used as
 * partition panels in some pre-fab workflows). Callers can extend
 * via `options.extraDividerTypes` for vendor-specific cases.
 */
const DEFAULT_DIVIDER_TYPES = new Set([
  'ifcwall',
  'ifcwallstandardcase',
  'ifcwallelementedcase',
  'ifccurtainwall',
  'ifcvirtualelement',
  'ifcplate',
  'ifcmember',
  'ifcrailing',
]);

const AXIS_EPS = 1e-6;

export function extractWallSegmentsForStorey(
  store: IfcDataStore,
  storeyExpressId: number,
  overlay?: OverlayWallReader,
  options: ExtractWallSegmentsOptions = {},
): WallExtractionResult {
  const segments: Segment[] = [];
  const contributing: number[] = [];
  const skipped: WallSkip[] = [];
  const debug = !!options.debug;
  const log = debug ? (...args: unknown[]) => console.debug('[extract-walls]', ...args) : () => {};

  // Resolve the model's length unit so the segments we hand to the
  // detector are always in METRES — without this a millimetre model
  // would produce coords like (31614, 23345) and the panel's
  // metre-based snap tolerance would be effectively zero.
  let lengthUnitScale = 1.0;
  if (store.source) {
    try {
      lengthUnitScale = extractLengthUnitScale(store.source, store.entityIndex);
      if (!Number.isFinite(lengthUnitScale) || lengthUnitScale <= 0) lengthUnitScale = 1.0;
    } catch {
      lengthUnitScale = 1.0;
    }
  }
  log(`length unit scale = ${lengthUnitScale} (raw → metres)`);

  if (!store.source) {
    log('no source bytes on data store — extraction cannot run');
    return { segments, contributingWallIds: contributing, skipped, considered: 0, lengthUnitScale };
  }

  const dividerTypes = new Set(DEFAULT_DIVIDER_TYPES);
  if (options.extraDividerTypes) {
    for (const t of options.extraDividerTypes) dividerTypes.add(t.toLowerCase());
  }

  const extractor = new EntityExtractor(store.source);
  const dividerIds = collectDividerIdsOnStorey(store, storeyExpressId, dividerTypes, log);
  log(`storey #${storeyExpressId}: ${dividerIds.length} contained divider element(s)`);

  for (const id of dividerIds) {
    const result = extractWallAxisFromSource(store, extractor, id, log);
    if (result.segment) {
      segments.push(scaleSegment(result.segment, lengthUnitScale));
      contributing.push(id);
    } else {
      skipped.push({ wallId: id, reason: result.reason ?? 'no-axis-or-rect-profile' });
    }
  }

  let overlayCount = 0;
  if (overlay) {
    for (const ent of overlay.getNewEntities()) {
      if (!dividerTypes.has(ent.type.toLowerCase())) continue;
      overlayCount++;
      const result = extractWallAxisFromOverlay(store, extractor, overlay, ent, log);
      if (result.segment) {
        // Overlay walls are authored via addWallToStore which emits
        // metre coords — don't double-scale.
        segments.push(result.segment);
        contributing.push(ent.expressId);
      } else {
        skipped.push({ wallId: ent.expressId, reason: result.reason ?? 'no-axis-or-rect-profile' });
      }
    }
    if (overlayCount > 0) log(`overlay walls considered: ${overlayCount}`);
  }

  if (debug) {
    log(`segments=${segments.length} contributing=${contributing.length} skipped=${skipped.length}`);
    if (skipped.length > 0) {
      const reasonCounts = skipped.reduce<Record<string, number>>((acc, s) => {
        acc[s.reason] = (acc[s.reason] ?? 0) + 1;
        return acc;
      }, {});
      log('skip reasons:', reasonCounts);
      log('first few skipped:', skipped.slice(0, 8));
    }
  }

  return {
    segments,
    contributingWallIds: contributing,
    skipped,
    considered: dividerIds.length + overlayCount,
    lengthUnitScale,
  };
}

function scaleSegment(seg: Segment, scale: number): Segment {
  if (scale === 1) return seg;
  return {
    a: [seg.a[0] * scale, seg.a[1] * scale],
    b: [seg.b[0] * scale, seg.b[1] * scale],
  };
}

function isDividerType(type: string, dividerTypes: Set<string>): boolean {
  return dividerTypes.has(type.toLowerCase());
}

type Logger = (...args: unknown[]) => void;

function collectDividerIdsOnStorey(
  store: IfcDataStore,
  storeyId: number,
  dividerTypes: Set<string>,
  log: Logger,
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  if (!store.source) return ids;
  const extractor = new EntityExtractor(store.source);

  const visitMember = (memberId: number) => {
    if (seen.has(memberId)) return;
    const memberType = store.entities.getTypeName(memberId);
    if (memberType && isDividerType(memberType, dividerTypes)) {
      seen.add(memberId);
      ids.push(memberId);
      return;
    }
    // Member is a sub-structure (IfcSpace, IfcBuildingPart, …);
    // descend through its IfcRelAggregates / contained children too.
    descendAggregate(memberId);
  };

  const descendAggregate = (parentId: number) => {
    // Avoid revisiting parents we've already walked (cycles are
    // theoretically possible in malformed IFC).
    if (seen.has(parentId)) return;
    seen.add(parentId);
    // Anything `IfcRelContainedInSpatialStructure`-anchored to this
    // sub-structure should still be reachable.
    walkContainmentInto(parentId);
    // And recurse through aggregation.
    const aggRels = store.entityIndex.byType.get('IFCRELAGGREGATES') ?? [];
    for (const relId of aggRels) {
      const ref = store.entityIndex.byId.get(relId);
      if (!ref) continue;
      const rel = extractor.extractEntity(ref);
      if (!rel) continue;
      const relating = rel.attributes[4];
      if (typeof relating !== 'number' || relating !== parentId) continue;
      const related = rel.attributes[5];
      if (!Array.isArray(related)) continue;
      for (const child of related) {
        if (typeof child !== 'number') continue;
        visitMember(child);
      }
    }
  };

  const walkContainmentInto = (parentId: number) => {
    const containedRels = store.entityIndex.byType.get('IFCRELCONTAINEDINSPATIALSTRUCTURE') ?? [];
    for (const relId of containedRels) {
      const ref = store.entityIndex.byId.get(relId);
      if (!ref) continue;
      const rel = extractor.extractEntity(ref);
      if (!rel) continue;
      const relating = rel.attributes[5];
      if (typeof relating !== 'number' || relating !== parentId) continue;
      const related = rel.attributes[4];
      if (!Array.isArray(related)) continue;
      for (const member of related) {
        if (typeof member !== 'number') continue;
        visitMember(member);
      }
    }
  };

  // Mark the storey itself as seen but DON'T push it (we want its
  // children, not the storey id).
  seen.add(storeyId);
  walkContainmentInto(storeyId);

  // Some authoring tools attach elements via IfcRelAggregates to the
  // storey instead of containment (or in addition). Walk both
  // unconditionally to keep coverage broad.
  const aggRels = store.entityIndex.byType.get('IFCRELAGGREGATES') ?? [];
  for (const relId of aggRels) {
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const rel = extractor.extractEntity(ref);
    if (!rel) continue;
    const relating = rel.attributes[4];
    if (typeof relating !== 'number' || relating !== storeyId) continue;
    const related = rel.attributes[5];
    if (!Array.isArray(related)) continue;
    for (const child of related) {
      if (typeof child !== 'number') continue;
      visitMember(child);
    }
  }

  log(`collected ${ids.length} divider candidate(s) — types: ${[...dividerTypes].join(', ')}`);
  return ids;
}

interface ExtractAttempt {
  segment: Segment | null;
  reason?: WallSkipReason;
}

function extractWallAxisFromSource(
  store: IfcDataStore,
  extractor: EntityExtractor,
  wallId: number,
  log: Logger,
): ExtractAttempt {
  const ref = store.entityIndex.byId.get(wallId);
  if (!ref) {
    log(`wall #${wallId}: missing entity ref`);
    return { segment: null, reason: 'no-source-bytes' };
  }
  const wall = extractor.extractEntity(ref);
  if (!wall) {
    log(`wall #${wallId}: extractor returned null`);
    return { segment: null, reason: 'wall-not-parsed' };
  }
  const placementId = numericAttr(wall.attributes[5]);
  const representationId = numericAttr(wall.attributes[6]);
  if (placementId === null) return { segment: null, reason: 'no-placement' };
  if (representationId === null) return { segment: null, reason: 'no-representation' };
  return computeWallSegment(store, extractor, placementId, representationId, undefined, wallId, log);
}

function extractWallAxisFromOverlay(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader,
  wall: { expressId: number; attributes: IfcAttributeValue[] },
  log: Logger,
): ExtractAttempt {
  const placementId = numericAttr(wall.attributes[5]);
  const representationId = numericAttr(wall.attributes[6]);
  if (placementId === null) return { segment: null, reason: 'no-placement' };
  if (representationId === null) return { segment: null, reason: 'no-representation' };
  return computeWallSegment(store, extractor, placementId, representationId, overlay, wall.expressId, log);
}

interface PlacementFrame {
  /** Placement origin in storey-local 2D (X, Y). */
  origin: Vec2;
  /** Local X axis (RefDirection) projected onto the ground plane. */
  axisX: Vec2;
}

function computeWallSegment(
  store: IfcDataStore,
  extractor: EntityExtractor,
  placementId: number,
  representationId: number,
  overlay: OverlayWallReader | undefined,
  wallId: number,
  log: Logger,
): ExtractAttempt {
  const frame = readPlacementFrame(store, extractor, overlay, placementId);
  if (!frame) {
    log(`wall #${wallId}: placement chain not resolvable (placement=#${placementId})`);
    return { segment: null, reason: 'placement-not-resolvable' };
  }

  // Strategy 1 — Axis representation (start, end of polyline). Walks
  // the wall's `Axis` representation and reads its first item if it's
  // a 2-vertex IfcPolyline. This matches the standard authoring-tool
  // convention so most imported IFC files succeed here.
  const axisEndpoints = readAxisRepresentationEndpoints(store, extractor, overlay, representationId);
  if (axisEndpoints) {
    const start = applyFrame(frame, axisEndpoints[0]);
    const end = applyFrame(frame, axisEndpoints[1]);
    return finaliseSegment(start, end, wallId, log, 'axis-rep');
  }

  // Strategy 2 — addWallToStore convention. Origin = Start, length =
  // IfcRectangleProfileDef.XDim, end = origin + axisX * length.
  const length = readWallLength(store, extractor, overlay, representationId);
  if (length !== null && length > AXIS_EPS) {
    const start: Vec2 = frame.origin;
    const end: Vec2 = [
      frame.origin[0] + frame.axisX[0] * length,
      frame.origin[1] + frame.axisX[1] * length,
    ];
    return finaliseSegment(start, end, wallId, log, 'rect-profile');
  }

  log(`wall #${wallId}: no Axis representation and no IfcRectangleProfileDef body — skipping`);
  return { segment: null, reason: 'no-axis-or-rect-profile' };
}

function finaliseSegment(start: Vec2, end: Vec2, wallId: number, log: Logger, source: string): ExtractAttempt {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len < AXIS_EPS) {
    log(`wall #${wallId}: degenerate axis length=${len.toExponential(2)} (source=${source})`);
    return { segment: null, reason: 'zero-length-axis' };
  }
  log(`wall #${wallId}: axis (${start[0].toFixed(3)},${start[1].toFixed(3)})→(${end[0].toFixed(3)},${end[1].toFixed(3)}) len=${len.toFixed(3)} source=${source}`);
  return { segment: { a: start, b: end } };
}

/**
 * Walk IfcLocalPlacement → IfcAxis2Placement3D → CartesianPoint and
 * read the ground-plane origin + RefDirection. Returns null when any
 * link is missing.
 */
function readPlacementFrame(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  placementId: number,
): PlacementFrame | null {
  const placement = readEntity(store, extractor, overlay, placementId);
  if (!placement) return null;
  const axisPlacementId = numericAttr(placement.attributes[1]);
  if (axisPlacementId === null) return null;
  const axisPlacement = readEntity(store, extractor, overlay, axisPlacementId);
  if (!axisPlacement) return null;
  const locationId = numericAttr(axisPlacement.attributes[0]);
  const refDirId = numericAttr(axisPlacement.attributes[2]);
  if (locationId === null) return null;
  const locationEnt = readEntity(store, extractor, overlay, locationId);
  if (!locationEnt) return null;
  const origin = readVec3(locationEnt.attributes[0]);
  if (!origin) return null;

  let axisX: Vec2 = [1, 0];
  if (refDirId !== null) {
    const refDir = readEntity(store, extractor, overlay, refDirId);
    if (refDir) {
      const dir = readVec3(refDir.attributes[0]);
      if (dir) {
        const len = Math.hypot(dir[0], dir[1]);
        if (len > AXIS_EPS) axisX = [dir[0] / len, dir[1] / len];
      }
    }
  }
  return { origin: [origin[0], origin[1]], axisX };
}

/**
 * Apply a placement frame to a storey-local 2D point. The point's X is
 * along the wall's local axis; Y is perpendicular (perpendicular to
 * the wall direction in the ground plane).
 */
function applyFrame(frame: PlacementFrame, local: Vec2): Vec2 {
  const ax = frame.axisX[0];
  const ay = frame.axisX[1];
  // Perpendicular = rotate axisX 90° CCW around +Z.
  const px = -ay;
  const py = ax;
  return [
    frame.origin[0] + ax * local[0] + px * local[1],
    frame.origin[1] + ay * local[0] + py * local[1],
  ];
}

/**
 * Walk the wall's representations, looking for the standard `Axis`
 * representation. Returns the first two vertices of the first
 * `IfcPolyline` item found, in storey-local 2D. Most authoring tools
 * emit this as a 2-point polyline along the wall centreline.
 */
function readAxisRepresentationEndpoints(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  representationId: number,
): [Vec2, Vec2] | null {
  const productShape = readEntity(store, extractor, overlay, representationId);
  if (!productShape) return null;
  const reps = productShape.attributes[2];
  if (!Array.isArray(reps)) return null;
  for (const repRef of reps) {
    const repId = numericAttr(repRef);
    if (repId === null) continue;
    const rep = readEntity(store, extractor, overlay, repId);
    if (!rep) continue;
    // IfcShapeRepresentation: [ContextOfItems, RepresentationIdentifier, RepresentationType, Items]
    const identifier = stringAttr(rep.attributes[1]);
    if (!identifier || identifier.toLowerCase() !== 'axis') continue;
    const items = rep.attributes[3];
    if (!Array.isArray(items)) continue;
    for (const itemRef of items) {
      const itemId = numericAttr(itemRef);
      if (itemId === null) continue;
      const item = readEntity(store, extractor, overlay, itemId);
      if (!item) continue;
      const itemType = (store.entities.getTypeName(itemId) || item.type || '').toLowerCase();
      if (itemType !== 'ifcpolyline') continue;
      // IfcPolyline.Points = list of IfcCartesianPoint refs (attribute 0).
      const pointsRefs = item.attributes[0];
      if (!Array.isArray(pointsRefs) || pointsRefs.length < 2) continue;
      const a = readCartesianPoint2D(store, extractor, overlay, pointsRefs[0]);
      const b = readCartesianPoint2D(store, extractor, overlay, pointsRefs[pointsRefs.length - 1]);
      if (a && b) return [a, b];
    }
  }
  return null;
}

function readCartesianPoint2D(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  ref: unknown,
): Vec2 | null {
  const id = numericAttr(ref as IfcAttributeValue);
  if (id === null) return null;
  const ent = readEntity(store, extractor, overlay, id);
  if (!ent) return null;
  const coords = readVec3(ent.attributes[0]);
  if (!coords) return null;
  return [coords[0], coords[1]];
}

function readWallLength(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  representationId: number,
): number | null {
  // IfcWall.Representation → IfcProductDefinitionShape.Representations[]
  // → IfcShapeRepresentation.Items[] → IfcExtrudedAreaSolid → SweptArea
  // → IfcRectangleProfileDef.XDim
  const productShape = readEntity(store, extractor, overlay, representationId);
  if (!productShape) return null;
  const reps = productShape.attributes[2];
  if (!Array.isArray(reps)) return null;
  for (const repRef of reps) {
    const repId = numericAttr(repRef);
    if (repId === null) continue;
    const rep = readEntity(store, extractor, overlay, repId);
    if (!rep) continue;
    const items = rep.attributes[3];
    if (!Array.isArray(items)) continue;
    for (const itemRef of items) {
      const itemId = numericAttr(itemRef);
      if (itemId === null) continue;
      const item = readEntity(store, extractor, overlay, itemId);
      if (!item) continue;
      // IfcExtrudedAreaSolid: attribute 0 = SweptArea (profile)
      const profileId = numericAttr(item.attributes[0]);
      if (profileId === null) continue;
      const profile = readEntity(store, extractor, overlay, profileId);
      if (!profile) continue;
      const profileType = profileTypeName(store, profile, profileId);
      if (profileType !== 'ifcrectangleprofiledef') continue;
      // IfcRectangleProfileDef.XDim = attribute index 3.
      const xdim = numericAttr(profile.attributes[3]);
      if (xdim !== null && xdim > 0) return xdim;
    }
  }
  return null;
}

function profileTypeName(
  store: IfcDataStore,
  profile: { type?: string },
  profileId: number,
): string {
  const fromTable = store.entities.getTypeName(profileId);
  const name = (fromTable && fromTable !== 'Unknown' ? fromTable : profile.type) ?? '';
  return name.toLowerCase();
}

function readEntity(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  expressId: number,
): { type?: string; attributes: IfcAttributeValue[] } | null {
  const ref = store.entityIndex.byId.get(expressId);
  if (ref && ref.byteLength > 0 && ref.byteOffset >= 0) {
    return extractor.extractEntity(ref);
  }
  // Overlay-only entity: fall back to the overlay reader.
  if (overlay) {
    for (const ent of overlay.getNewEntities()) {
      if (ent.expressId === expressId) {
        return { type: ent.type, attributes: ent.attributes };
      }
    }
  }
  return null;
}

function numericAttr(v: IfcAttributeValue | undefined): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    if (v.startsWith('#')) {
      const n = Number(v.slice(1));
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringAttr(v: IfcAttributeValue | undefined): string | null {
  if (typeof v === 'string') {
    // Strip STEP single quotes if present (parser sometimes returns them, sometimes not).
    if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
    return v;
  }
  return null;
}

function readVec3(v: IfcAttributeValue | undefined): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = numericAttr(v[0]);
  const y = numericAttr(v[1]);
  const z = v.length >= 3 ? numericAttr(v[2]) : 0;
  if (x === null || y === null || z === null) return null;
  return [x, y, z];
}
