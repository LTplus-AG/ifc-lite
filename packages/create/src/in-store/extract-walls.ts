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
  extractMaterialsOnDemand,
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
  /**
   * Per-segment wall thickness in metres (parallel to `segments` /
   * `contributingWallIds`), from the wall's material layer set; `undefined`
   * when the wall carries no resolvable layer thickness. Used to inset the
   * centreline footprint to a net (inner-face) area.
   */
  wallThicknesses: (number | undefined)[];
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
  const wallThicknesses: (number | undefined)[] = [];
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
    return { segments, contributingWallIds: contributing, wallThicknesses, skipped, considered: 0, lengthUnitScale };
  }

  const dividerTypes = new Set(DEFAULT_DIVIDER_TYPES);
  if (options.extraDividerTypes) {
    for (const t of options.extraDividerTypes) dividerTypes.add(t.toLowerCase());
  }

  const extractor = new EntityExtractor(store.source);
  const dividerIds = collectDividerIdsOnStorey(store, extractor, storeyExpressId, dividerTypes, log);
  log(`storey #${storeyExpressId}: ${dividerIds.length} contained divider element(s)`);

  for (const id of dividerIds) {
    const result = extractWallAxisFromSource(store, extractor, id, log);
    if (result.segment) {
      segments.push(scaleSegment(result.segment, lengthUnitScale));
      contributing.push(id);
      wallThicknesses.push(wallThicknessFromMaterial(store, id));
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
        wallThicknesses.push(undefined); // overlay walls carry no material yet
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
    wallThicknesses,
    skipped,
    considered: dividerIds.length + overlayCount,
    lengthUnitScale,
  };
}

/**
 * Total thickness (metres) of a wall's material layer set, or `undefined` when
 * the wall has no resolvable layers. The material resolver already scales layer
 * thicknesses to metres, so no further unit conversion is applied.
 */
function wallThicknessFromMaterial(store: IfcDataStore, wallId: number): number | undefined {
  const info = extractMaterialsOnDemand(store, wallId);
  const layers = info?.layers;
  if (!layers || layers.length === 0) return undefined;
  let total = 0;
  for (const layer of layers) total += layer.thickness ?? 0;
  return total > 0 ? total : undefined;
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
  extractor: EntityExtractor,
  storeyId: number,
  dividerTypes: Set<string>,
  log: Logger,
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  if (!store.source) return ids;

  // Build relating → related-children indices ONCE, then walk in O(1) per
  // parent. Previously each `descendAggregate` / `walkContainmentInto`
  // call walked every IfcRelAggregates / IfcRelContainedInSpatialStructure
  // entity in the file looking for one with the right relating id —
  // O(R·N) total in the number of rels and parents visited.
  const aggregateChildren = buildRelatingChildrenIndex(
    store, extractor, 'IFCRELAGGREGATES', 4, 5,
  );
  const containmentChildren = buildRelatingChildrenIndex(
    store, extractor, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 5, 4,
  );

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
    const contained = containmentChildren.get(parentId);
    if (contained) for (const m of contained) visitMember(m);
    // And recurse through aggregation.
    const agg = aggregateChildren.get(parentId);
    if (agg) for (const c of agg) visitMember(c);
  };

  // Mark the storey itself as seen but DON'T push it (we want its
  // children, not the storey id).
  seen.add(storeyId);
  const storeyContained = containmentChildren.get(storeyId);
  if (storeyContained) for (const m of storeyContained) visitMember(m);

  // Some authoring tools attach elements via IfcRelAggregates to the
  // storey instead of containment (or in addition). Walk both
  // unconditionally to keep coverage broad.
  const storeyAgg = aggregateChildren.get(storeyId);
  if (storeyAgg) for (const c of storeyAgg) visitMember(c);

  log(`collected ${ids.length} divider candidate(s) — types: ${[...dividerTypes].join(', ')}`);
  return ids;
}

/**
 * Footprint polygons (model-local metres, same frame as the extracted wall
 * segments) of existing `IfcSpace` per storey — so generation can skip *only*
 * the new rooms that overlap an already-present space (per-space dedup), while
 * still adding rooms an empty part of the floor lacks. Keyed by storey
 * expressId; storeys with no resolvable space footprints are omitted.
 */
export function existingSpaceFootprintsByStorey(store: IfcDataStore): Map<number, Vec2[][]> {
  const out = new Map<number, Vec2[][]>();
  if (!store.source) return out;
  const extractor = new EntityExtractor(store.source);
  const scale = extractLengthUnitScale(store.source, store.entityIndex) ?? 1;
  const aggregated = buildRelatingChildrenIndex(store, extractor, 'IFCRELAGGREGATES', 4, 5);
  const contained = buildRelatingChildrenIndex(store, extractor, 'IFCRELCONTAINEDINSPATIALSTRUCTURE', 5, 4);
  for (const st of store.getEntitiesByType('IfcBuildingStorey')) {
    const kids = [...(aggregated.get(st.expressId) ?? []), ...(contained.get(st.expressId) ?? [])];
    const footprints: Vec2[][] = [];
    for (const id of kids) {
      if ((store.entities.getTypeName(id) ?? '').toUpperCase() !== 'IFCSPACE') continue;
      const ref = store.entityIndex.byId.get(id);
      if (!ref) continue;
      const ent = extractor.extractEntity(ref);
      if (!ent) continue;
      const placementId = numericAttr(ent.attributes[5]);   // ObjectPlacement
      const representationId = numericAttr(ent.attributes[6]); // Representation
      if (placementId === null || representationId === null) continue;
      const frame = readPlacementFrame(store, extractor, undefined, placementId);
      const localPts = gatherBodyFootprintPoints(store, extractor, undefined, representationId);
      if (!frame || !localPts || localPts.length < 3) continue;
      footprints.push(localPts.map((p) => {
        const w = applyFrame(frame, p);
        return [w[0] * scale, w[1] * scale] as Vec2;
      }));
    }
    if (footprints.length) out.set(st.expressId, footprints);
  }
  return out;
}

/**
 * Index every relationship of `relType` by its "relating" attribute, so a
 * lookup of "what's anchored to id X" becomes O(1) instead of an O(R)
 * scan of every relationship.
 */
function buildRelatingChildrenIndex(
  store: IfcDataStore,
  extractor: EntityExtractor,
  relType: string,
  relatingIdx: number,
  relatedIdx: number,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const relIds = store.entityIndex.byType.get(relType);
  if (!relIds) return out;
  for (const relId of relIds) {
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const rel = extractor.extractEntity(ref);
    if (!rel) continue;
    const relating = rel.attributes[relatingIdx];
    if (typeof relating !== 'number') continue;
    const related = rel.attributes[relatedIdx];
    if (!Array.isArray(related)) continue;
    let bucket = out.get(relating);
    if (!bucket) {
      bucket = [];
      out.set(relating, bucket);
    }
    for (const child of related) {
      if (typeof child === 'number') bucket.push(child);
    }
  }
  return out;
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

  // Strategy 3 — body-footprint centreline. For walls with only a meshed
  // body (IfcTriangulatedFaceSet / IfcPolygonalFaceSet) and no Axis/rect
  // profile, project the body vertices to the local ground plane (drop the
  // local vertical Z) and take the principal axis of that footprint as the
  // wall centreline. Covers tessellated exports that the two shape-specific
  // strategies miss.
  const footprint = gatherBodyFootprintPoints(store, extractor, overlay, representationId);
  if (footprint && footprint.length >= 3) {
    const centreline = principalAxisCentreline(footprint);
    if (centreline) {
      const start = applyFrame(frame, centreline[0]);
      const end = applyFrame(frame, centreline[1]);
      return finaliseSegment(start, end, wallId, log, 'body-footprint');
    }
  }

  log(`wall #${wallId}: no Axis representation, no IfcRectangleProfileDef body, no meshed footprint — skipping`);
  return { segment: null, reason: 'no-axis-or-rect-profile' };
}

/**
 * Gather the wall body's ground-plane footprint points (local frame, raw
 * units) from a meshed representation. Reads the vertex list of every
 * `IfcTriangulatedFaceSet` / `IfcPolygonalFaceSet` item in a non-`Axis`
 * representation and drops the local vertical (Z), which is up in the
 * wall-local frame before placement. Returns null when there's no mesh body.
 */
function gatherBodyFootprintPoints(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  representationId: number,
): Vec2[] | null {
  const productShape = readEntity(store, extractor, overlay, representationId);
  if (!productShape) return null;
  const reps = productShape.attributes[2];
  if (!Array.isArray(reps)) return null;

  const pts: Vec2[] = [];
  for (const repRef of reps) {
    const repId = numericAttr(repRef);
    if (repId === null) continue;
    const rep = readEntity(store, extractor, overlay, repId);
    if (!rep) continue;
    const identifier = stringAttr(rep.attributes[1]);
    if (identifier && identifier.toLowerCase() === 'axis') continue; // handled by Strategy 1
    const items = rep.attributes[3];
    if (!Array.isArray(items)) continue;
    for (const itemRef of items) {
      const itemId = numericAttr(itemRef);
      if (itemId === null) continue;
      const item = readEntity(store, extractor, overlay, itemId);
      if (!item) continue;
      const itemType = resolveEntityTypeName(store, item, itemId);
      if (itemType === 'ifctriangulatedfaceset' || itemType === 'ifcpolygonalfaceset') {
        // Vertices live in an IfcCartesianPointList3D at attribute 0; its
        // attribute 0 is the flat list of [x, y, z] triples (rep frame).
        const coordId = numericAttr(item.attributes[0]);
        if (coordId === null) continue;
        const coordList = readEntity(store, extractor, overlay, coordId);
        if (!coordList || !Array.isArray(coordList.attributes[0])) continue;
        for (const p of coordList.attributes[0] as IfcAttributeValue[]) {
          const v = readVec3(p);
          if (v) pts.push([v[0], v[1]]);
        }
      } else if (itemType === 'ifcextrudedareasolid') {
        gatherExtrudedFootprint(store, extractor, overlay, item, pts);
      } else if (itemType === 'ifcfacetedbrep') {
        gatherBrepFootprint(store, extractor, overlay, item, pts);
      }
    }
  }
  return pts.length >= 3 ? pts : null;
}

/** 2D affine frame (XY of an IfcAxis2Placement2D/3D). */
interface Frame2 { o: Vec2; x: Vec2; y: Vec2 }
const IDENTITY2: Frame2 = { o: [0, 0], x: [1, 0], y: [0, 1] };
const apply2 = (f: Frame2, p: Vec2): Vec2 => [
  f.o[0] + f.x[0] * p[0] + f.y[0] * p[1],
  f.o[1] + f.x[1] * p[0] + f.y[1] * p[1],
];

/** Read an IfcAxis2Placement2D/3D into its XY affine frame (Z ignored). */
function readPlacement2(
  store: IfcDataStore, extractor: EntityExtractor, overlay: OverlayWallReader | undefined, ref: unknown,
): Frame2 {
  const id = numericAttr(ref as IfcAttributeValue);
  if (id === null) return IDENTITY2;
  const ent = readEntity(store, extractor, overlay, id);
  if (!ent) return IDENTITY2;
  const o = readCartesianPoint2D(store, extractor, overlay, ent.attributes[0]) ?? [0, 0];
  // RefDirection: attr 1 on the 2D placement, attr 2 on the 3D placement.
  const is3d = resolveEntityTypeName(store, ent, id) === 'ifcaxis2placement3d';
  const refDir = readCartesianPoint2D(store, extractor, overlay, ent.attributes[is3d ? 2 : 1]);
  let xx = 1, xy = 0;
  if (refDir) { const l = Math.hypot(refDir[0], refDir[1]) || 1; xx = refDir[0] / l; xy = refDir[1] / l; }
  return { o, x: [xx, xy], y: [-xy, xx] };
}

/**
 * Footprint of a vertically-extruded solid = its swept profile placed into the
 * rep frame. Handles rectangle and arbitrary-(polyline-)closed profiles; skips
 * non-vertical extrusions (the profile wouldn't be a plan footprint then).
 */
function gatherExtrudedFootprint(
  store: IfcDataStore, extractor: EntityExtractor, overlay: OverlayWallReader | undefined,
  solid: { type?: string; attributes: IfcAttributeValue[] }, out: Vec2[],
): void {
  // IfcExtrudedAreaSolid = SweptArea(0), Position(1), ExtrudedDirection(2), Depth(3).
  // The swept profile is a *plan* footprint only when the extrusion ends up
  // world-vertical: ExtrudedDirection must be the solid's local Z AND the
  // solid's Position must keep that Z world-up. Multi-layer walls (e.g. #218)
  // extrude along their thickness via a Position rotated to a horizontal axis —
  // their profile is an elevation, not a footprint, so skip rather than emit a
  // bogus centreline.
  const dirId = numericAttr(solid.attributes[2]);
  if (dirId !== null) {
    const d = readVec3(readEntity(store, extractor, overlay, dirId)?.attributes[0]);
    if (d && Math.abs(d[2]) < 0.9) return;
  }
  const posId = numericAttr(solid.attributes[1]);
  if (posId !== null) {
    const posEnt = readEntity(store, extractor, overlay, posId);
    const axisId = posEnt ? numericAttr(posEnt.attributes[1]) : null;
    if (axisId !== null) {
      const az = readVec3(readEntity(store, extractor, overlay, axisId)?.attributes[0]);
      if (az && Math.abs(az[2]) < 0.9) return; // solid's local Z isn't world-up
    }
  }
  const solidPos = readPlacement2(store, extractor, overlay, solid.attributes[1]);
  const profileId = numericAttr(solid.attributes[0]);
  if (profileId === null) return;
  const profile = readEntity(store, extractor, overlay, profileId);
  if (!profile) return;
  const ptype = resolveEntityTypeName(store, profile, profileId);
  if (ptype === 'ifcrectangleprofiledef') {
    const ppos = readPlacement2(store, extractor, overlay, profile.attributes[2]);
    const xd = numericAttr(profile.attributes[3]) ?? 0;
    const yd = numericAttr(profile.attributes[4]) ?? 0;
    if (xd <= 0 || yd <= 0) return;
    const corners: Vec2[] = [[-xd / 2, -yd / 2], [xd / 2, -yd / 2], [xd / 2, yd / 2], [-xd / 2, yd / 2]];
    for (const c of corners) out.push(apply2(solidPos, apply2(ppos, c)));
  } else if (ptype === 'ifcarbitraryclosedprofiledef' || ptype === 'ifcarbitraryprofiledefwithvoids') {
    // OuterCurve at attr 2 for both; read its points as the footprint cloud
    // (PCA only needs the cloud, not edge order). Polyline or IndexedPolyCurve.
    const ocId = numericAttr(profile.attributes[2]);
    if (ocId === null) return;
    const oc = readEntity(store, extractor, overlay, ocId);
    if (!oc) return;
    const octype = resolveEntityTypeName(store, oc, ocId);
    if (octype === 'ifcpolyline' && Array.isArray(oc.attributes[0])) {
      for (const ptRef of oc.attributes[0]) {
        const v = readCartesianPoint2D(store, extractor, overlay, ptRef);
        if (v) out.push(apply2(solidPos, v));
      }
    } else if (octype === 'ifcindexedpolycurve') {
      // IfcIndexedPolyCurve.Points → IfcCartesianPointList2D (flat [x,y] list).
      const listId = numericAttr(oc.attributes[0]);
      if (listId === null) return;
      const list = readEntity(store, extractor, overlay, listId);
      if (!list || !Array.isArray(list.attributes[0])) return;
      for (const p of list.attributes[0] as IfcAttributeValue[]) {
        const v = readVec3(p);
        if (v) out.push(apply2(solidPos, [v[0], v[1]]));
      }
    }
  }
}

/**
 * Footprint of an IfcFacetedBrep = all its shell vertices projected to XY.
 * Walks Outer (IfcClosedShell) → faces → bounds → IfcPolyLoop → points. The
 * vertices are already in the rep frame, so no extra placement is needed.
 */
function gatherBrepFootprint(
  store: IfcDataStore, extractor: EntityExtractor, overlay: OverlayWallReader | undefined,
  brep: { type?: string; attributes: IfcAttributeValue[] }, out: Vec2[],
): void {
  const shellId = numericAttr(brep.attributes[0]);
  if (shellId === null) return;
  const shell = readEntity(store, extractor, overlay, shellId);
  if (!shell || !Array.isArray(shell.attributes[0])) return;
  for (const faceRef of shell.attributes[0]) {
    const faceId = numericAttr(faceRef);
    if (faceId === null) continue;
    const face = readEntity(store, extractor, overlay, faceId);
    if (!face || !Array.isArray(face.attributes[0])) continue;
    for (const boundRef of face.attributes[0]) {
      const boundId = numericAttr(boundRef);
      if (boundId === null) continue;
      const bound = readEntity(store, extractor, overlay, boundId);
      if (!bound) continue;
      const loopId = numericAttr(bound.attributes[0]);
      if (loopId === null) continue;
      const loop = readEntity(store, extractor, overlay, loopId);
      if (!loop || !Array.isArray(loop.attributes[0])) continue;
      for (const ptRef of loop.attributes[0]) {
        const v = readCartesianPoint2D(store, extractor, overlay, ptRef);
        if (v) out.push(v);
      }
    }
  }
}

/**
 * Principal-axis centreline of a 2D point cloud (PCA). A wall footprint is a
 * thin elongated rectangle, so the largest-eigenvalue direction is the wall's
 * length and the centroid sits on the centreline — exactly the axis we want.
 * Returns the centroid-anchored segment spanning the footprint's extent along
 * that axis, or null if it collapses to a point.
 */
function principalAxisCentreline(points: Vec2[]): [Vec2, Vec2] | null {
  const n = points.length;
  let cx = 0, cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= n; cy /= n;

  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of points) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const tr = sxx + syy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)));
  const lambda = tr / 2 + disc; // largest eigenvalue
  let ex = sxy, ey = lambda - sxx;
  if (Math.hypot(ex, ey) < 1e-12) { ex = lambda - syy; ey = sxy; }
  const elen = Math.hypot(ex, ey);
  if (elen < 1e-12) return null;
  ex /= elen; ey /= elen;

  let tmin = Infinity, tmax = -Infinity;
  for (const [x, y] of points) {
    const t = (x - cx) * ex + (y - cy) * ey;
    if (t < tmin) tmin = t;
    if (t > tmax) tmax = t;
  }
  if (tmax - tmin < AXIS_EPS) return null;
  return [[cx + ex * tmin, cy + ey * tmin], [cx + ex * tmax, cy + ey * tmax]];
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
      const itemType = resolveEntityTypeName(store, item, itemId);
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
      const profileType = resolveEntityTypeName(store, profile, profileId);
      if (profileType !== 'ifcrectangleprofiledef') continue;
      // IfcRectangleProfileDef.XDim = attribute index 3.
      const xdim = numericAttr(profile.attributes[3]);
      if (xdim !== null && xdim > 0) return xdim;
    }
  }
  return null;
}

/**
 * Robust IFC type-name for an entity read from source. The columnar entity
 * table only indexes products/named entities, so `getTypeName` returns
 * `'Unknown'` for geometry primitives (IfcPolyline, IfcCartesianPoint,
 * profiles, solids). The extractor's `entity.type` is always reliable — so
 * prefer the table only when it actually resolved, otherwise fall back to the
 * extractor type. (Reading the table's `'Unknown'` literally was what made
 * every `Curve2D` Axis polyline — e.g. all of AC20-FZK-Haus — get skipped.)
 */
export function resolveEntityTypeName(
  store: IfcDataStore,
  entity: { type?: string },
  entityId: number,
): string {
  const fromTable = store.entities.getTypeName(entityId);
  const name = (fromTable && fromTable !== 'Unknown' ? fromTable : entity.type) ?? '';
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
