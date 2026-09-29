/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live reads for wall-hosted openings, doors and windows (#6232): the host
 * wall's frame on its storey, and where an opening sits in its host.
 *
 * `addOpeningToStore` places the opening relative to the host's
 * IfcLocalPlacement with its Location at `[Offset, …, Sill]` in the host's
 * frame, and `addHostedDoorToStore` / `addHostedWindowToStore` place the
 * filling relative to the opening. So a placing gesture needs the host's
 * frame to turn a cursor into `Offset`, and an edit of Offset or Sill is one
 * write to the opening's Location point: the filling follows it.
 *
 * Every read goes through the mutation overlay, so a wall or opening authored
 * this session reads like one from the file, and a deleted one is gone.
 */

import { EntityExtractor, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { fromNativeLength } from './anchor.js';
import { safeLengthUnitScale } from './length-unit-scale.js';
import {
  frameInStoreyFrame,
  numericAttr,
  readEntity,
  readVec3,
  storeyPlacementChain,
  type OverlayWallReader,
} from './placement-frame.js';
import { AnchorEntityReader } from './resolve-anchor.js';

export interface HostPlanFrame {
  /** The host's placement origin, storey-local metres; z is its height above the storey's placement. */
  origin: [number, number, number];
  /** The host's local +X on the storey plane, unit length. */
  axisX: [number, number];
}

function lengthScale(store: IfcDataStore, context: string): number {
  return store.source && store.source.byteLength > 0
    ? safeLengthUnitScale(store.source, store.entityIndex, context) ?? 1
    : 1;
}

/**
 * The host's placement frame on storey `storeyExpressId`, composed through
 * every `PlacementRelTo` hop the same way the storey's wall axes are
 * (`extractWallSegmentsForStorey`), so a point read against one lines up
 * with the other. Null when the host has no readable placement.
 */
export function hostPlanFrame(
  store: IfcDataStore,
  hostExpressId: number,
  storeyExpressId: number,
  view?: MutablePropertyView | null,
): HostPlanFrame | null {
  if (!store.source || store.source.byteLength === 0) return null;
  const extractor = new EntityExtractor(store.source);
  const overlay: OverlayWallReader | undefined = view ?? undefined;
  const host = readEntity(store, extractor, overlay, hostExpressId);
  const placementId = host ? numericAttr(host.attributes[5]) : null;
  if (placementId === null) return null;
  const chain = storeyPlacementChain(store, extractor, overlay, storeyExpressId);
  const frame = frameInStoreyFrame(store, extractor, overlay, placementId, chain);
  if (!frame) return null;
  const z = heightAboveStorey(store, extractor, overlay, placementId, chain);
  const k = lengthScale(store, 'hostPlanFrame');
  return { origin: [frame.origin[0] * k, frame.origin[1] * k, z * k], axisX: [frame.axisX[0], frame.axisX[1]] };
}

/** One placement's own Location z (in its parent's frame), 0 when unreadable. */
function ownZ(store: IfcDataStore, extractor: EntityExtractor, overlay: OverlayWallReader | undefined, placementId: number): number {
  const placement = readEntity(store, extractor, overlay, placementId);
  const axisId = placement ? numericAttr(placement.attributes[1]) : null;
  const axis = axisId === null ? null : readEntity(store, extractor, overlay, axisId);
  const pointId = axis ? numericAttr(axis.attributes[0]) : null;
  const point = pointId === null ? null : readEntity(store, extractor, overlay, pointId);
  return (point && readVec3(point.attributes[0])?.[2]) ?? 0;
}

/**
 * Native-unit height of `placementId` above the storey's placement: the z of
 * every hop up to where the walk meets the storey's own chain, minus the
 * storey's hops above that point. Upright placements only (a wall's), like
 * the planar frames it goes with.
 */
function heightAboveStorey(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  placementId: number,
  chain: ReadonlyMap<number, number> | null,
): number {
  let z = 0;
  const seen = new Set<number>();
  let id: number | null = placementId;
  while (id !== null && !seen.has(id) && !chain?.has(id)) {
    seen.add(id);
    z += ownZ(store, extractor, overlay, id);
    const placement = readEntity(store, extractor, overlay, id);
    id = placement ? numericAttr(placement.attributes[0]) : null;
  }
  if (!chain) return z;
  // Joined the storey's chain `hops` above its own placement (or ran out at the root).
  const hops = id !== null && chain.has(id) ? chain.get(id)! : id === null ? chain.size : 0;
  let walked = 0;
  for (const storeyHop of chain.keys()) {
    if (walked++ >= hops) break;
    z -= ownZ(store, extractor, overlay, storeyHop);
  }
  return z;
}

export interface HostedFillRead {
  /** The voided wall or slab (IfcRelVoidsElement.RelatingBuildingElement). */
  hostId: number;
  openingId: number;
  /** The IfcDoor / IfcWindow in the opening (IfcRelFillsElement); null for a bare opening. */
  fillingId: number | null;
  /** The opening placement's Location point: Offset is its x, Sill its z (native units). */
  locationPointId: number;
  /** Its current coordinates, native units. */
  location: [number, number, number];
  /** Along the host's local X to the opening's placement origin, metres (the centre, for an authored one). */
  offset: number;
  /** The opening's bottom above the host's placement origin, metres. */
  sill: number;
}

function refId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^#[1-9][0-9]*$/.test(value)) return Number(value.slice(1));
  return null;
}

const OPENING_TYPES = new Set(['IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE']);

/**
 * Where an opening, or the door or window filling one, sits in its host.
 * Null when `expressId` is neither, when it has no live host, or when the
 * opening is not placed relative to its host (an absolutely placed opening
 * has no offset along the wall to edit).
 */
export function readHostedFill(
  store: IfcDataStore,
  expressId: number,
  view?: MutablePropertyView | null,
): HostedFillRead | null {
  const reader = new AnchorEntityReader(store, view);
  const self = reader.entity(expressId);
  if (!self) return null;

  // IfcRelFillsElement: RelatingOpeningElement(4), RelatedBuildingElement(5).
  let openingId: number | null = OPENING_TYPES.has(self.type.toUpperCase()) ? expressId : null;
  let fillingId: number | null = null;
  for (const relId of reader.ids('IFCRELFILLSELEMENT')) {
    const rel = reader.entity(relId);
    if (!rel) continue;
    const opening = refId(rel.attributes[4]);
    const filling = refId(rel.attributes[5]);
    if (openingId === null && filling === expressId) { openingId = opening; fillingId = expressId; break; }
    if (openingId !== null && opening === openingId && filling !== null && reader.entity(filling)) { fillingId = filling; break; }
  }
  if (openingId === null) return null;

  // IfcRelVoidsElement: RelatingBuildingElement(4), RelatedOpeningElement(5).
  let hostId: number | null = null;
  for (const relId of reader.ids('IFCRELVOIDSELEMENT')) {
    const rel = reader.entity(relId);
    if (rel && refId(rel.attributes[5]) === openingId) { hostId = refId(rel.attributes[4]); break; }
  }
  const host = hostId === null ? null : reader.entity(hostId);
  const opening = reader.entity(openingId);
  if (hostId === null || !host || !opening) return null;

  const hostPlacement = refId(host.attributes[5]);
  const placementId = refId(opening.attributes[5]);
  const placement = placementId === null ? null : reader.entity(placementId);
  if (!placement || hostPlacement === null || refId(placement.attributes[0]) !== hostPlacement) return null;
  const axisId = refId(placement.attributes[1]);
  const axis = axisId === null ? null : reader.entity(axisId);
  const locationPointId = axis ? refId(axis.attributes[0]) : null;
  const point = locationPointId === null ? null : reader.entity(locationPointId);
  const coords = point?.attributes[0];
  if (locationPointId === null || !Array.isArray(coords)) return null;
  const location = [0, 1, 2].map((i) => (typeof coords[i] === 'number' ? coords[i] as number : 0)) as [number, number, number];
  if (!location.every(Number.isFinite)) return null;

  const unit = { lengthUnitScale: lengthScale(store, 'readHostedFill') };
  return {
    hostId,
    openingId,
    fillingId,
    locationPointId,
    location,
    offset: fromNativeLength(unit, location[0]),
    sill: fromNativeLength(unit, location[2]),
  };
}
