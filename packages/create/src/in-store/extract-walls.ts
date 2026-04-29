/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pull every wall axis on a given storey from a parsed `IfcDataStore`
 * plus an optional overlay (`MutablePropertyView`-style new-entities
 * map). The resulting 2D segments feed `detectEnclosedAreas`.
 *
 * Wall convention (matching `addWallToStore` / `IfcCreator.addIfcWall`):
 *   - Placement origin = wall Start (storey-local).
 *   - `IfcAxis2Placement3D.RefDirection` = wall axis direction.
 *   - The body is `IfcRectangleProfileDef` with XDim = wall length.
 *
 * Walls that don't follow this convention (no rect profile, sloped
 * placement, missing parts) are skipped silently — auto-space
 * detection stays best-effort.
 */

import { EntityExtractor, type IfcDataStore, type IfcAttributeValue } from '@ifc-lite/parser';
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

export interface WallExtractionResult {
  segments: Segment[];
  /** Wall expressIds that contributed an axis segment. */
  contributingWallIds: number[];
  /** Wall ids skipped because the convention couldn't be matched. */
  skippedWallIds: number[];
}

const AXIS_EPS = 1e-6;

export function extractWallSegmentsForStorey(
  store: IfcDataStore,
  storeyExpressId: number,
  overlay?: OverlayWallReader,
): WallExtractionResult {
  const segments: Segment[] = [];
  const contributing: number[] = [];
  const skipped: number[] = [];
  if (!store.source) {
    return { segments, contributingWallIds: contributing, skippedWallIds: skipped };
  }

  const extractor = new EntityExtractor(store.source);
  const wallIds = collectWallIdsOnStorey(store, storeyExpressId);

  for (const id of wallIds) {
    const seg = extractWallAxisFromSource(store, extractor, id);
    if (seg) {
      segments.push(seg);
      contributing.push(id);
    } else {
      skipped.push(id);
    }
  }

  if (overlay) {
    for (const ent of overlay.getNewEntities()) {
      if (!isWallType(ent.type)) continue;
      const seg = extractWallAxisFromOverlay(store, extractor, overlay, ent);
      if (seg) {
        segments.push(seg);
        contributing.push(ent.expressId);
      } else {
        skipped.push(ent.expressId);
      }
    }
  }

  return { segments, contributingWallIds: contributing, skippedWallIds: skipped };
}

function isWallType(type: string): boolean {
  const lower = type.toLowerCase();
  return lower === 'ifcwall' || lower === 'ifcwallstandardcase';
}

function collectWallIdsOnStorey(store: IfcDataStore, storeyId: number): number[] {
  // ContainedInSpatialStructure → element membership lookup. Walls
  // on the storey are anchored by `IfcRelContainedInSpatialStructure`
  // with `RelatingStructure = #storeyId`.
  const ids: number[] = [];
  const seen = new Set<number>();
  const containedRels = store.entityIndex.byType.get('IFCRELCONTAINEDINSPATIALSTRUCTURE') ?? [];
  if (!store.source) return ids;
  const extractor = new EntityExtractor(store.source);
  for (const relId of containedRels) {
    const ref = store.entityIndex.byId.get(relId);
    if (!ref) continue;
    const rel = extractor.extractEntity(ref);
    if (!rel) continue;
    const relating = rel.attributes[5];
    if (typeof relating !== 'number' || relating !== storeyId) continue;
    const related = rel.attributes[4];
    if (!Array.isArray(related)) continue;
    for (const member of related) {
      if (typeof member !== 'number') continue;
      const memberType = store.entities.getTypeName(member);
      if (!memberType || !isWallType(memberType)) continue;
      if (seen.has(member)) continue;
      seen.add(member);
      ids.push(member);
    }
  }
  return ids;
}

function extractWallAxisFromSource(
  store: IfcDataStore,
  extractor: EntityExtractor,
  wallId: number,
): Segment | null {
  const ref = store.entityIndex.byId.get(wallId);
  if (!ref) return null;
  const wall = extractor.extractEntity(ref);
  if (!wall) return null;
  const placementId = numericAttr(wall.attributes[5]);
  const representationId = numericAttr(wall.attributes[6]);
  if (placementId === null || representationId === null) return null;
  return computeWallSegment(store, extractor, placementId, representationId);
}

function extractWallAxisFromOverlay(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader,
  wall: { expressId: number; attributes: IfcAttributeValue[] },
): Segment | null {
  const placementId = numericAttr(wall.attributes[5]);
  const representationId = numericAttr(wall.attributes[6]);
  if (placementId === null || representationId === null) return null;
  return computeWallSegment(store, extractor, placementId, representationId, overlay);
}

function computeWallSegment(
  store: IfcDataStore,
  extractor: EntityExtractor,
  placementId: number,
  representationId: number,
  overlay?: OverlayWallReader,
): Segment | null {
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
  // Default axis direction is +X when RefDirection is omitted.
  let dirX = 1;
  let dirY = 0;
  if (refDirId !== null) {
    const refDir = readEntity(store, extractor, overlay, refDirId);
    if (refDir) {
      const dir = readVec3(refDir.attributes[0]);
      if (dir) {
        const len = Math.hypot(dir[0], dir[1]);
        if (len > AXIS_EPS) {
          dirX = dir[0] / len;
          dirY = dir[1] / len;
        }
      }
    }
  }

  // Resolve wall length from the rectangle profile XDim.
  const length = readWallLength(store, extractor, overlay, representationId);
  if (length === null || length <= AXIS_EPS) return null;

  const start: Vec2 = [origin[0], origin[1]];
  const end: Vec2 = [origin[0] + dirX * length, origin[1] + dirY * length];
  return { a: start, b: end };
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

function readVec3(v: IfcAttributeValue | undefined): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 2) return null;
  const x = numericAttr(v[0]);
  const y = numericAttr(v[1]);
  const z = v.length >= 3 ? numericAttr(v[2]) : 0;
  if (x === null || y === null || z === null) return null;
  return [x, y, z];
}
