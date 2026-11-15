/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared helpers for candidate selection: properties, façade tests, scope and
 * the candidate record. Positions and levels come only from `locate.ts`.
 */

import { RelationshipType } from '@ifc-lite/data';
import { signedDistance, type PreparedFootprint } from '../region.js';
import type { MapPoint } from '../types.js';
import type { CandidateCategory, CandidateFact, LevelBasis } from './facts.js';
import type { ModelGeoreference } from './georef.js';
import type { PlacementResolver } from './placement.js';
import { getInheritanceChainAcrossSchemas, normalizeIfcTypeName } from '@ifc-lite/parser';
import { asEnum, asString, type DecodedEntity, type ModelReader } from './reader.js';

/**
 * The Common property sets that may carry `IsExternal` for an element: the
 * `Pset_<Class>Common` of its class and of every supertype, nearest first
 * (`IfcWallStandardCase` → `Pset_WallStandardCaseCommon`, `Pset_WallCommon`,
 * …). Generic, so any host class (a proxy, a member, a column, a railing, a
 * plate) is read; names no standard defines simply hold no value.
 */
const commonCache = new Map<string, readonly string[]>();
export function commonPsets(entity: DecodedEntity): readonly string[] {
  let hit = commonCache.get(entity.type);
  if (hit === undefined) {
    const chain = getInheritanceChainAcrossSchemas(normalizeIfcTypeName(entity.type));
    const classes = chain.length > 0 ? chain : [normalizeIfcTypeName(entity.type)];
    hit = [...new Set(classes.filter((c) => /^Ifc/.test(c)).map((c) => `Pset_${c.slice(3)}Common`))];
    commonCache.set(entity.type, hit);
  }
  return hit;
}

export interface CandidateContext {
  reader: ModelReader;
  placements: PlacementResolver;
  georef: ModelGeoreference;
  storeyOf(id: number): number | null;
  storeyLevel: ReadonlyMap<number, number>;
  groundLevel: number;
  /** The prepared footprint (`region.ts`): every inside / distance question is asked of it. */
  footprint: PreparedFootprint;
  aboveGroundScope: number;
  boundaryTolerance: number;
  /**
   * The footprint's accumulated quality (`footprint.ts`); null when no
   * footprint is known yet. A hull or voids-filled footprint fills courtyards,
   * a partial one misses part of the building: neither proves an element
   * interior.
   */
  footprintQuality?: { hullLike: boolean; partial: boolean } | null;
  /** The ground storey was guessed (lowest storey, or none): a rule that rests on its level does not exclude. */
  groundUncertain?: boolean;
}

/** Why an exclusion that rests on the footprint does not hold, or null when the footprint is complete enough. */
export function footprintDoubt(ctx: CandidateContext, d: number): string | null {
  const q = ctx.footprintQuality;
  if (q?.hullLike) return 'the footprint fills courtyards or notches (a hull, or a slab with filled voids), so being inside it proves nothing (kept conservatively)';
  // Outside a footprint known to miss part of the building, the element may stand in that part.
  if (q?.partial && d > 0) return 'outside the readable footprint, and the footprint is partial (kept conservatively)';
  return null;
}

/** Why an exclusion that rests on the ground storey's level does not hold, or null when that level is known. */
export function groundDoubt(ctx: CandidateContext): string | null {
  return ctx.groundUncertain ? 'the ground storey was guessed, so its level does not decide (kept conservatively)' : null;
}

export const NO_PLACEMENT = 'no readable IfcLocalPlacement chain';

/** `IsExternal` and the set it was read from (the nearest Common set of the class chain that states a boolean). */
export function externalOf(reader: ModelReader, entity: DecodedEntity): { value: boolean | null; pset: string | null } {
  for (const pset of commonPsets(entity)) {
    // Several same-named sets may disagree: any `true` keeps the element in the façade (an exclusion needs every set to say false).
    const values = reader.propertyValues(entity.expressId, pset, 'IsExternal').filter((v): v is boolean => typeof v === 'boolean');
    if (values.length > 0) return { value: values.includes(true), pset };
  }
  return { value: null, pset: null };
}

export function isExternal(reader: ModelReader, entity: DecodedEntity): boolean | null {
  return externalOf(reader, entity).value;
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

/**
 * Why the element is out of scope, or null when it is not proven to be: only
 * its proven lowest possible level (`Location.lowest` from `locate`) above
 * `ground storey + aboveGroundScope` excludes it. No proven bound, or a
 * guessed ground storey, keeps it; a storey is never proof of height.
 */
export function scopeExclusion(ctx: CandidateContext, lowest: number | null): string | null {
  if (lowest === null || inScope(ctx, lowest) || groundDoubt(ctx)) return null;
  return `lowest possible level ${lowest.toFixed(3)} m is more than ${ctx.aboveGroundScope} m above the ground storey (out of scope)`;
}

export function belowGround(ctx: CandidateContext, id: number, level: number): boolean {
  const storey = ctx.storeyOf(id);
  const storeyLevel = storey === null ? undefined : ctx.storeyLevel.get(storey);
  return storeyLevel !== undefined ? storeyLevel < ctx.groundLevel - 0.01 : level < ctx.groundLevel - 0.3;
}

/** The element an opening voids (an opening voids exactly one element). */
export function hostOfOpening(ctx: CandidateContext, openingId: number): DecodedEntity | null {
  const hosts = ctx.reader.related(openingId, RelationshipType.VoidsElement, 'inverse');
  return ctx.reader.entity(hosts[0]);
}

/**
 * The one place a door's or window's host is resolved: the element voided by
 * the opening it fills, else its decomposition parent (a door aggregated or
 * nested into a curtain wall has no opening). Each relation has at most one
 * target by the schema.
 */
export function hostOf(ctx: CandidateContext, entity: DecodedEntity): DecodedEntity | null {
  const r = ctx.reader;
  const opening = r.related(entity.expressId, RelationshipType.FillsElement, 'inverse')[0];
  const voided = opening === undefined ? null : hostOfOpening(ctx, opening);
  if (voided) return voided;
  const parent = r.related(entity.expressId, RelationshipType.Aggregates, 'inverse')[0] ?? r.related(entity.expressId, RelationshipType.Nests, 'inverse')[0];
  return r.entity(parent);
}

/**
 * The one eligibility rule for an exclusion: why the element may NOT be
 * excluded on this evidence, or null when it may. An uncertain position never
 * supports an exclusion, whatever rests on it; an exclusion by distance also
 * needs a footprint (none: inside and outside are unknown) that is complete
 * enough (`footprintDoubt`).
 */
export function exclusionDoubt(ctx: CandidateContext, positionCertain: boolean, d?: number | null): string | null {
  // The footprint first (when the exclusion rests on a distance), then the position.
  if (d === null) return 'there is no footprint to test against';
  const footprint = d === undefined ? null : footprintDoubt(ctx, d);
  if (footprint) return footprint;
  if (!positionCertain) return 'its position is uncertain (a body that places it cannot be fully read, or a clipped body), so it proves nothing';
  return null;
}

/** Why the element is in the façade, or `{ not }` with why it is taken not to be. */
export function facadeReason(ctx: CandidateContext, entity: DecodedEntity, host: DecodedEntity | null, at: MapPoint, positionCertain = true): string | { not: string } {
  const ownRead = externalOf(ctx.reader, entity);
  const own = ownRead.value;
  if (own === true) return `IsExternal (${ownRead.pset})`;
  const hostRead = host ? externalOf(ctx.reader, host) : { value: null, pset: null };
  const hostExternal = hostRead.value;
  // An external host wins over the element's own `false`: authoring tools often default it.
  if (hostExternal === true) {
    return `host IsExternal (${hostRead.pset})${own === false ? '; the element itself states IsExternal = false' : ''}`;
  }
  const statedInternal = own === false || hostExternal === false;
  const stated = statedInternal ? `${own === false ? 'it' : 'its host'} states IsExternal = false` : 'IsExternal not stated';
  const d = signedDistance(ctx.footprint, at);
  // More than the tolerance OUTSIDE the footprint, an element cannot be interior, whatever it states (the footprint is then
  // marked partial by the extraction).
  if (d !== null && d > ctx.boundaryTolerance) {
    return `${d.toFixed(2)} m outside the footprint, so it cannot be interior (kept${statedInternal ? ' despite IsExternal = false' : ''}, and the footprint is partial: it misses this part of the building)`;
  }
  // A stated IsExternal = false excludes, but not on an uncertain position: kept, the statement noted.
  if (statedInternal) {
    const doubt = exclusionDoubt(ctx, positionCertain);
    return doubt ? `${stated}, but ${doubt} (kept conservatively)` : { not: `not in the façade: ${stated}` };
  }
  if (d !== null && Math.abs(d) <= ctx.boundaryTolerance) return `within ${ctx.boundaryTolerance} m of the footprint outline (IsExternal not stated)`;
  const doubt = exclusionDoubt(ctx, positionCertain, d);
  if (doubt) return `IsExternal not stated, ${doubt} (kept conservatively)`;
  return { not: `not in the façade: IsExternal not stated and ${Math.abs(d!).toFixed(2)} m from the footprint outline (more than ${ctx.boundaryTolerance} m)` };
}
