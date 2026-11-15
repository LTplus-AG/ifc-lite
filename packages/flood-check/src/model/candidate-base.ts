/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared reading for candidate selection (`candidates.ts`): placements,
 * opening bodies, façade tests and levels. None of these records a skip: the
 * rules in `candidate-rules.ts` return one verdict per element.
 */

import { RelationshipType } from '@ifc-lite/data';
import { signedDistance } from '../geom.js';
import type { MapPoint } from '../types.js';
import type { CandidateCategory, CandidateFact, LevelBasis } from './facts.js';
import type { ModelGeoreference } from './georef.js';
import { extrusionBody, toWorld } from './outline.js';
import type { PlacementResolver } from './placement.js';
import { asEnum, asString, type DecodedEntity, type ModelReader } from './reader.js';

export const COMMON_PSET: Record<string, string> = {
  IFCDOOR: 'Pset_DoorCommon',
  IFCDOORSTANDARDCASE: 'Pset_DoorCommon',
  IFCWINDOW: 'Pset_WindowCommon',
  IFCWINDOWSTANDARDCASE: 'Pset_WindowCommon',
  IFCWALL: 'Pset_WallCommon',
  IFCWALLSTANDARDCASE: 'Pset_WallCommon',
  IFCCURTAINWALL: 'Pset_CurtainWallCommon',
  IFCSTAIR: 'Pset_StairCommon',
  IFCSTAIRFLIGHT: 'Pset_StairFlightCommon',
  IFCRAMP: 'Pset_RampCommon',
  IFCRAMPFLIGHT: 'Pset_RampFlightCommon',
  IFCSLAB: 'Pset_SlabCommon',
  IFCSLABSTANDARDCASE: 'Pset_SlabCommon',
  IFCSLABELEMENTEDCASE: 'Pset_SlabCommon',
};

export interface CandidateContext {
  reader: ModelReader;
  placements: PlacementResolver;
  georef: ModelGeoreference;
  storeyOf(id: number): number | null;
  storeyLevel: ReadonlyMap<number, number>;
  groundLevel: number;
  footprint: readonly (readonly MapPoint[])[];
  aboveGroundScope: number;
  boundaryTolerance: number;
}

export const NO_PLACEMENT = 'no readable IfcLocalPlacement chain';

export function isExternal(reader: ModelReader, entity: DecodedEntity): boolean | null {
  const pset = COMMON_PSET[entity.type];
  if (!pset) return null;
  const v = reader.property(entity.expressId, pset, 'IsExternal');
  return typeof v === 'boolean' ? v : null;
}

export function predefinedType(reader: ModelReader, entity: DecodedEntity): string | null {
  const own = asEnum(reader.attr(entity, 'PredefinedType'));
  if (own && own !== 'NOTDEFINED' && own !== 'USERDEFINED') return own;
  for (const typeId of reader.related(entity.expressId, RelationshipType.DefinesByType, 'inverse')) {
    const t = asEnum(reader.attr(reader.entity(typeId), 'PredefinedType'));
    if (t && t !== 'NOTDEFINED' && t !== 'USERDEFINED') return t;
  }
  // IFC2X3 transport elements carry the kind in OperationType.
  return asEnum(reader.attr(entity, 'OperationType')) ?? own;
}

/** Map position and absolute level of a product's placement origin; null when unplaced. */
export function placed(ctx: CandidateContext, entity: DecodedEntity): { position: MapPoint; level: number } | null {
  const frame = ctx.placements.ofProduct(entity.expressId);
  if (!frame) return null;
  const [x, y, z] = ctx.georef.toMap(frame.origin);
  return { position: { x, y }, level: z };
}

export interface OpeningExtent {
  position: MapPoint;
  level: number;
  /** The level and position come from the body's extrusion. */
  fromBody: boolean;
  /** Some body item could not be read, so the hole may reach lower than `level`. */
  partial: boolean;
}

/**
 * An opening's hole: plan centre and lowest point of its extrusion when
 * readable, else its placement origin. Null when unplaced.
 */
export function openingExtent(ctx: CandidateContext, entity: DecodedEntity): OpeningExtent | null {
  const frame = ctx.placements.ofProduct(entity.expressId);
  if (!frame) return null;
  const body = extrusionBody(ctx.reader, entity.expressId);
  if (!body) {
    const [x, y, z] = ctx.georef.toMap(frame.origin);
    return { position: { x, y }, level: z, fromBody: false, partial: false };
  }
  const world = toWorld(frame, body.corners).map((p) => ctx.georef.toMap(p));
  let sx = 0;
  let sy = 0;
  let minZ = Infinity;
  for (const [x, y, z] of world) {
    sx += x;
    sy += y;
    minZ = Math.min(minZ, z);
  }
  return { position: { x: sx / world.length, y: sy / world.length }, level: minZ, fromBody: true, partial: !body.complete };
}

export function base(
  ctx: CandidateContext,
  entity: DecodedEntity,
  category: CandidateCategory,
  at: { position: MapPoint; level: number },
  selectedBecause: string,
  levelBasis: LevelBasis = 'placement-origin',
): CandidateFact {
  const r = ctx.reader;
  return {
    expressId: entity.expressId,
    globalId: asString(r.attr(entity, 'GlobalId')),
    name: asString(r.attr(entity, 'Name')),
    ifcClass: r.className(entity),
    predefinedType: predefinedType(r, entity),
    category,
    position: at.position,
    level: at.level,
    levelBasis,
    levelIsUpperEstimate: levelBasis === 'ground-storey-or-terrain',
    storeyId: ctx.storeyOf(entity.expressId),
    selectedBecause,
  };
}

export function inScope(ctx: CandidateContext, level: number): boolean {
  return level <= ctx.groundLevel + ctx.aboveGroundScope;
}

export function outOfScopeReason(ctx: CandidateContext, level: number): string {
  return `level ${level.toFixed(3)} m is more than ${ctx.aboveGroundScope} m above the ground storey (out of scope)`;
}

export function belowGround(ctx: CandidateContext, id: number, level: number): boolean {
  const storey = ctx.storeyOf(id);
  const storeyLevel = storey === null ? undefined : ctx.storeyLevel.get(storey);
  return storeyLevel !== undefined ? storeyLevel < ctx.groundLevel - 0.01 : level < ctx.groundLevel - 0.3;
}

/** The host a filling element or opening voids: opening → host element. */
export function hostOfOpening(ctx: CandidateContext, openingId: number): DecodedEntity | null {
  const hosts = ctx.reader.related(openingId, RelationshipType.VoidsElement, 'inverse');
  return ctx.reader.entity(hosts[0]);
}

/** Why the element is in the façade, or `{ not }` with why it is taken not to be. */
export function facadeReason(ctx: CandidateContext, entity: DecodedEntity, host: DecodedEntity | null, at: MapPoint): string | { not: string } {
  const own = isExternal(ctx.reader, entity);
  if (own === true) return `IsExternal (${COMMON_PSET[entity.type]})`;
  const hostExternal = host ? isExternal(ctx.reader, host) : null;
  // An external host wins over the element's own `false`: authoring tools often default it.
  if (hostExternal === true) {
    return `host IsExternal (${COMMON_PSET[host!.type]})${own === false ? '; the element itself states IsExternal = false' : ''}`;
  }
  if (own === false || hostExternal === false) return { not: `not in the façade: ${own === false ? 'it' : 'its host'} states IsExternal = false` };
  // No outline to test against (no slab, no external wall): keep it rather than lose every façade element.
  if (ctx.footprint.length === 0) return 'IsExternal not stated and no footprint to test against (kept conservatively)';
  const d = signedDistance(at, ctx.footprint);
  return Number.isFinite(d) && Math.abs(d) <= ctx.boundaryTolerance
    ? `within ${ctx.boundaryTolerance} m of the footprint outline (IsExternal not stated)`
    : { not: `not in the façade: IsExternal not stated and ${Math.abs(d).toFixed(2)} m from the footprint outline (more than ${ctx.boundaryTolerance} m)` };
}

/** Placement and opening-body positions or levels further apart than these get a note. */
const LEVEL_DISAGREEMENT = 0.3;
const POSITION_DISAGREEMENT = 1;

export interface FillingAt {
  position: MapPoint;
  level: number;
  basis: LevelBasis;
  /** The opening's body is only partly readable, so its hole may reach lower: the level can flag but never clear. */
  upperEstimate: boolean;
  notes: string[];
}

/**
 * A door's or window's position and level from its placement and the opening
 * it fills: the hole's plan centre when the body is readable (a filling may be
 * placed at its wall's origin), and the lower of the placement origin and the
 * bottom of the hole.
 */
export function fillingAt(ctx: CandidateContext, at: { position: MapPoint; level: number }, opening: DecodedEntity | null): FillingAt {
  const body = opening ? openingExtent(ctx, opening) : null;
  if (!body || !body.fromBody) return { position: at.position, level: at.level, basis: 'placement-origin', upperEstimate: false, notes: [] };
  const notes: string[] = [];
  const apart = Math.hypot(body.position.x - at.position.x, body.position.y - at.position.y);
  if (apart > POSITION_DISAGREEMENT) {
    notes.push(`placed ${apart.toFixed(2)} m from the hole it fills (for example at its wall's origin); the hole's position is used`);
  }
  const diff = at.level - body.level;
  if (Math.abs(diff) > LEVEL_DISAGREEMENT) {
    notes.push(
      `placement origin ${at.level.toFixed(3)} m and the bottom of the filled opening ${body.level.toFixed(3)} m differ by ` +
        `${Math.abs(diff).toFixed(2)} m (some tools place windows at the head or centre); the lower is used`,
    );
  }
  if (body.partial) notes.push('part of the filled opening\'s body cannot be read, so the hole may reach lower: the level is an upper estimate');
  const lower = body.level < at.level;
  return { position: body.position, level: lower ? body.level : at.level, basis: lower ? 'opening-body-bottom' : 'placement-origin', upperEstimate: body.partial, notes };
}
