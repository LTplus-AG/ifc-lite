/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The rule for one covered element: each function returns exactly one
 * {@link Verdict} for the element it is given, from that element's own data
 * (and its host, storey and body as data). None decides for another element:
 * relations between elements are resolved afterwards by `candidates.ts` from
 * these verdicts.
 */

import { signedDistance } from '../region.js';
import type { MapPoint } from '../types.js';
import type { CandidateCategory, CandidateFact, LevelBasis } from './facts.js';
import { asString, type DecodedEntity } from './reader.js';
import {
  base,
  belowGround,
  facadeReason,
  exclusionDoubt,
  groundDoubt,
  hostOf,
  hostOfOpening,
  isExternal,
  NO_PLACEMENT,
  predefinedType,
  scopeExclusion,
  type CandidateContext,
} from './candidate-base.js';
import { locate, readDescentBody, readSources, type LocateKind, type Location } from './locate.js';

/** Exactly one of: a candidate, or a skip with its reason. */
export type Verdict = { candidate: CandidateFact; skip?: never } | { skip: string; candidate?: never };

const skip = (reason: string): Verdict => ({ skip: reason });
const candidate = (fact: CandidateFact): Verdict => ({ candidate: fact });

/** Where the element is and how low it reaches, from `locate.ts`: the only source of positions and levels here. */
function where(ctx: CandidateContext, entity: DecodedEntity, kind: LocateKind, host?: DecodedEntity | null): Location | null {
  const loc = locate(kind, readSources(ctx, entity, kind, host));
  return 'refused' in loc ? null : loc;
}

/** A candidate at its location, carrying the location's quality and notes. */
function at(ctx: CandidateContext, entity: DecodedEntity, category: CandidateCategory, loc: Location, because: string, basis: LevelBasis = loc.basis): CandidateFact {
  const fact = base(ctx, entity, category, { position: loc.position, level: loc.level }, because, basis);
  if (loc.quality === 'upper-estimate') fact.levelIsUpperEstimate = true;
  if (!loc.positionCertain) fact.positionIsUncertain = true;
  if (loc.quality === 'lower-bound') fact.levelIsLowerBound = true;
  if (loc.notes.length > 0) fact.notes = [...loc.notes];
  return fact;
}

export const WINDOW_TYPES = ['IFCWINDOW', 'IFCWINDOWSTANDARDCASE'];

export const LIGHT_WELL_NAME = /licht\s*schacht|kellerschacht|light\s*-?\s*well|areaway|saut[\s-]+de[\s-]+loup|bocca\s+di\s+lupo|pozzo\s+di\s+luce/i;

export function elementLabel(ctx: CandidateContext, e: DecodedEntity): string {
  return `${asString(ctx.reader.attr(e, 'Name')) ?? ''} ${asString(ctx.reader.attr(e, 'ObjectType')) ?? ''}`;
}

/** A door or window: in scope by its corrected level, in the façade, at its hole. */
export function fillingVerdict(ctx: CandidateContext, entity: DecodedEntity): Verdict {
  const r = ctx.reader;
  const isWindow = WINDOW_TYPES.includes(entity.type);
  const loc = where(ctx, entity, isWindow ? 'window' : 'door');
  if (!loc) return skip(NO_PLACEMENT);
  const outOfScope = scopeExclusion(ctx, loc.lowest);
  if (outOfScope) return skip(outOfScope);
  // The opening's host, else the decomposition parent (a door in a curtain wall has no opening).
  const host = hostOf(ctx, entity);
  const reason = facadeReason(ctx, entity, host, loc.position, loc.positionCertain);
  if (typeof reason !== 'string') return skip(reason.not);
  const category: CandidateCategory = isWindow ? belowGround(ctx, entity.expressId, loc.level) ? 'basement-window' : 'window' : 'door';
  const fact = at(ctx, entity, category, loc, reason);
  if (host) fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
  return candidate(fact);
}

/**
 * An opening as a hole of its own. Whether a door or window filling it
 * reports for it instead is decided from that filling's verdict, not here.
 */
export function openingVerdict(ctx: CandidateContext, entity: DecodedEntity, filled: boolean): Verdict {
  const r = ctx.reader;
  if (predefinedType(r, entity) === 'RECESS') return skip('a RECESS opening, not through the wall');
  const host = hostOfOpening(ctx, entity.expressId);
  const inSlab = !!host && (host.type === 'IFCSLAB' || host.type === 'IFCSLABSTANDARDCASE' || host.type === 'IFCSLABELEMENTEDCASE');
  const loc = where(ctx, entity, inSlab ? 'slab-opening' : 'opening', host);
  if (!loc) return skip(NO_PLACEMENT);
  if (inSlab) {
    // Above the ground storey only on a bound proven from geometry read (`locate`'s `lowest`); an unplaced host slab or an
    // unreadable opening body is kept, as an upper estimate.
    if (loc.lowest !== null && loc.lowest > ctx.groundLevel + 0.01 && !groundDoubt(ctx)) return skip(`in a slab above the ground storey (lowest possible level ${loc.lowest.toFixed(3)} m)`);
    const because = loc.basis === 'host-slab-top'
      ? 'unfilled opening in a slab at or below the ground storey'
      : loc.basis === 'opening-body-bottom'
        ? 'unfilled opening in a slab, its body reaching below the slab\'s placement'
        : 'unfilled opening in a slab whose placement cannot be read (kept conservatively)';
    const fact = at(ctx, entity, 'slab-opening', loc, because);
    fact.host = { expressId: host!.expressId, ifcClass: r.className(host!) };
    return candidate(fact);
  }
  const outOfScope = scopeExclusion(ctx, loc.lowest);
  if (outOfScope) return skip(outOfScope);
  // With no host, the opening itself is tested against the outline.
  const reason = facadeReason(ctx, host ?? entity, null, loc.position, loc.positionCertain);
  if (typeof reason !== 'string') return skip(reason.not);
  const fact = at(ctx, entity, 'wall-opening', loc, `${filled ? 'opening' : 'unfilled opening'}; ${reason}${host ? '' : ' (no host element)'}`);
  if (host) fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
  return candidate(fact);
}

/**
 * An element whose Name or ObjectType names a light well, read like an
 * opening: at its body's plan centre when readable, at the lower of its
 * placement and its body's bottom (an upper estimate when the body is only
 * partly readable), since its placement may be at the rim, the centre or a
 * wall's origin.
 */
export function lightWellVerdict(ctx: CandidateContext, entity: DecodedEntity): Verdict {
  const loc = where(ctx, entity, 'light-well');
  if (!loc) return skip(NO_PLACEMENT);
  const outOfScope = scopeExclusion(ctx, loc.lowest);
  if (outOfScope) return skip(outOfScope);
  return candidate(at(ctx, entity, 'light-well', loc, `Name/ObjectType "${elementLabel(ctx, entity).trim()}"`));
}


/**
 * Whether an external stair or ramp can lead down to the entry level. Only a
 * complete readable body wholly at or above the ground storey (1 cm tolerance)
 * proves it leads up; a placement origin alone does not (a ramp is often placed
 * at its top), nor a body with an unreadable item or UNION.
 */
function descentEvidence(ctx: CandidateContext, entity: DecodedEntity, level: number, body: ReturnType<typeof readDescentBody>): { keep: boolean; why: string } {
  if (belowGround(ctx, entity.expressId, level)) return { keep: true, why: 'in a storey below ground' };
  if (body.points.length === 0) return { keep: true, why: 'its body cannot be read, so it may lead down (kept conservatively)' };
  const minZ = Math.min(...body.points.map((p) => p[2]));
  if (minZ < ctx.groundLevel - 0.01) return { keep: true, why: `its body reaches ${(ctx.groundLevel - minZ).toFixed(2)} m below the ground storey` };
  if (!body.complete) return { keep: true, why: 'a part of its body cannot be read (the readable parts lead up), so it may lead down (kept conservatively)' };
  return { keep: false, why: 'its body lies wholly at or above the ground storey (leads up)' };
}

/**
 * A stair or ramp (or a flight, on its own). Whether a flight is reported or
 * assessed through its stair instead is decided from the stair's verdict.
 */
export function descentVerdict(ctx: CandidateContext, entity: DecodedEntity, category: 'stair' | 'ramp'): Verdict {
  const loc = where(ctx, entity, category);
  if (!loc) return skip(NO_PLACEMENT);
  const sources = readSources(ctx, entity, category);
  const external = isExternal(ctx.reader, entity);
  const body = readDescentBody(ctx, entity);
  // Null: no footprint, so inside and outside are unknown (never "infinitely far outside").
  const d = signedDistance(ctx.footprint, loc.position);
  const outsideAt = (p: MapPoint) => (signedDistance(ctx.footprint, p) ?? 0) > 0;
  // Outside is decisive (an explicit `false` is often an authoring default): by placement, by any body corner, or,
  // when the body cannot be read, by a placement within the boundary tolerance (it may be placed at its inner end).
  const outside =
    d === null ? null
    : d > 0 ? 'placed outside the footprint'
    : body.points.some((p) => outsideAt({ x: p[0], y: p[1] })) ? 'its body reaches outside the footprint'
    : !body.complete && Math.abs(d) <= ctx.boundaryTolerance ? `placed within ${ctx.boundaryTolerance} m of the outline and its body cannot be fully read`
    : null;
  // The one exclusion rule: an uncertain position, no footprint, or one that fills courtyards or misses part: kept.
  const doubt = exclusionDoubt(ctx, loc.positionCertain, d);
  if (!external && !outside && !doubt) {
    return skip(`interior ${category}: placed ${Math.abs(d!).toFixed(2)} m inside the footprint${body.complete ? ' and its body lies inside it' : ''}${external === false ? '; IsExternal = false' : ''}`);
  }
  // Below ground by its storey, else by its placement height.
  const evidence = descentEvidence(ctx, entity, sources.placement!.level, body);
  if (!evidence.keep && !groundDoubt(ctx)) return skip(`external ${category}: ${evidence.why}`);
  const why = external ? 'IsExternal' : `${outside ?? doubt}${external === false ? ' (despite IsExternal = false)' : ''}`;
  const evidenceWhy = evidence.keep ? evidence.why : `${evidence.why}, but ${groundDoubt(ctx)}`;
  return candidate(at(ctx, entity, category, loc, `${why}; ${evidenceWhy}; entry at the terrain`));
}

/**
 * In the ground storey or below by its storey (the storey may include an
 * element); otherwise kept unless its proven lowest possible level lies above
 * `ground storey + aboveGroundScope` (a storey is never proof of height).
 */
function inLowestStoreys(ctx: CandidateContext, id: number, lowest: number | null): boolean {
  const storey = ctx.storeyOf(id);
  const storeyLevel = storey === null ? undefined : ctx.storeyLevel.get(storey);
  if (storeyLevel !== undefined && storeyLevel <= ctx.groundLevel + 0.01) return true;
  return lowest === null || lowest <= ctx.groundLevel + ctx.aboveGroundScope;
}

/**
 * Technical equipment, given why it is equipment (`because`), or the
 * predefined kinds its class is limited to (`predefined`, for example
 * ELEVATOR / LIFTINGGEAR): a stated other kind is skipped, an unstated one kept.
 */
export function equipmentVerdict(ctx: CandidateContext, entity: DecodedEntity, because: string | { predefined?: readonly string[] }): Verdict {
  const r = ctx.reader;
  let why: string;
  if (typeof because === 'string') {
    why = because;
  } else {
    const kind = predefinedType(r, entity);
    const stated = kind !== null && kind !== 'NOTDEFINED' && kind !== 'USERDEFINED';
    const predefined = because.predefined;
    if (predefined && stated && !predefined.includes(kind)) return skip(`${r.className(entity)} ${kind} is not a kind the check covers (${predefined.join(', ')})`);
    // An unstated kind may be a covered one: kept.
    why = `${r.className(entity)}${stated ? ` ${kind}` : predefined ? ' (kind not stated, kept conservatively)' : ''}`;
  }
  const loc = where(ctx, entity, 'equipment');
  if (!loc) return skip(NO_PLACEMENT);
  const lowest = inLowestStoreys(ctx, entity.expressId, loc.lowest);
  if (!lowest && !groundDoubt(ctx)) return skip('equipment above the ground storey');
  return candidate(at(ctx, entity, 'equipment', loc, lowest ? `${why} in the ground storey or below` : `${why}; ${groundDoubt(ctx)}`));
}
