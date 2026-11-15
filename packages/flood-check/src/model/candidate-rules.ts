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

import { RelationshipType } from '@ifc-lite/data';
import { signedDistance } from '../geom.js';
import type { CandidateCategory, CandidateFact } from './facts.js';
import { extrusionBody, toWorld } from './outline.js';
import { asString, type DecodedEntity } from './reader.js';
import {
  base,
  belowGround,
  facadeReason,
  fillingAt,
  hostOfOpening,
  inScope,
  isExternal,
  NO_PLACEMENT,
  openingExtent,
  outOfScopeReason,
  placed,
  predefinedType,
  type CandidateContext,
} from './candidate-base.js';

/** Exactly one of: a candidate, or a skip with its reason. */
export type Verdict = { candidate: CandidateFact; skip?: never } | { skip: string; candidate?: never };

const skip = (reason: string): Verdict => ({ skip: reason });
const candidate = (fact: CandidateFact): Verdict => ({ candidate: fact });

export const WINDOW_TYPES = ['IFCWINDOW', 'IFCWINDOWSTANDARDCASE'];

export const LIGHT_WELL_NAME = /licht\s*schacht|kellerschacht|light\s*-?\s*well|areaway|saut[\s-]+de[\s-]+loup|bocca\s+di\s+lupo|pozzo\s+di\s+luce/i;

export function elementLabel(ctx: CandidateContext, e: DecodedEntity): string {
  return `${asString(ctx.reader.attr(e, 'Name')) ?? ''} ${asString(ctx.reader.attr(e, 'ObjectType')) ?? ''}`;
}

/** A door or window: in scope by its corrected level, in the façade, at its hole. */
export function fillingVerdict(ctx: CandidateContext, entity: DecodedEntity): Verdict {
  const r = ctx.reader;
  const at = placed(ctx, entity);
  if (!at) return skip(NO_PLACEMENT);
  const opening = r.related(entity.expressId, RelationshipType.FillsElement, 'inverse')[0];
  const filled = fillingAt(ctx, at, opening === undefined ? null : r.entity(opening));
  if (!inScope(ctx, filled.level)) return skip(outOfScopeReason(ctx, filled.level));
  const host = opening === undefined ? null : hostOfOpening(ctx, opening);
  const reason = facadeReason(ctx, entity, host, filled.position);
  if (typeof reason !== 'string') return skip(reason.not);
  const category: CandidateCategory = WINDOW_TYPES.includes(entity.type)
    ? belowGround(ctx, entity.expressId, at.level) ? 'basement-window' : 'window'
    : 'door';
  const fact = base(ctx, entity, category, { position: filled.position, level: filled.level }, reason, filled.basis);
  if (filled.upperEstimate) fact.levelIsUpperEstimate = true;
  if (filled.notes.length > 0) fact.notes = filled.notes;
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
  const at = openingExtent(ctx, entity);
  if (!at) return skip(NO_PLACEMENT);
  const host = hostOfOpening(ctx, entity.expressId);
  const levelBasis = at.fromBody ? 'opening-body-bottom' : 'placement-origin';
  if (host && (host.type === 'IFCSLAB' || host.type === 'IFCSLABSTANDARDCASE' || host.type === 'IFCSLABELEMENTEDCASE')) {
    const hostAt = placed(ctx, host);
    if (hostAt && hostAt.level > ctx.groundLevel + 0.01) return skip(`in a slab above the ground storey (${hostAt.level.toFixed(3)} m)`);
    // An unplaced host slab may be at or below the ground storey: kept, at the opening's own level as an upper estimate.
    const fact = hostAt
      ? base(ctx, entity, 'slab-opening', { position: at.position, level: hostAt.level }, 'unfilled opening in a slab at or below the ground storey', 'host-slab-top')
      : base(ctx, entity, 'slab-opening', at, 'unfilled opening in a slab whose placement cannot be read (kept conservatively)', levelBasis);
    if (!hostAt) fact.levelIsUpperEstimate = true;
    fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
    return candidate(fact);
  }
  if (!inScope(ctx, at.level)) return skip(outOfScopeReason(ctx, at.level));
  // With no host, the opening itself is tested against the outline.
  const reason = facadeReason(ctx, host ?? entity, null, at.position);
  if (typeof reason !== 'string') return skip(reason.not);
  const fact = base(ctx, entity, 'wall-opening', at, `${filled ? 'opening' : 'unfilled opening'}; ${reason}${host ? '' : ' (no host element)'}`, levelBasis);
  if (at.partial) {
    fact.levelIsUpperEstimate = true;
    fact.notes = ['part of the opening\'s body cannot be read, so it may reach lower: the level is an upper estimate'];
  }
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
  const at = placed(ctx, entity);
  const body = openingExtent(ctx, entity);
  if (!at || !body) return skip(NO_PLACEMENT);
  const lower = body.fromBody && body.level < at.level;
  const level = lower ? body.level : at.level;
  if (!inScope(ctx, level)) return skip(outOfScopeReason(ctx, level));
  const fact = base(ctx, entity, 'light-well', { position: body.position, level }, `Name/ObjectType "${elementLabel(ctx, entity).trim()}"`, lower ? 'opening-body-bottom' : 'placement-origin');
  if (body.partial) {
    fact.levelIsUpperEstimate = true;
    fact.notes = ['part of its body cannot be read, so it may reach lower: the level is an upper estimate'];
  }
  return candidate(fact);
}

/** The stair's or ramp's own body and its parts' bodies, in map coordinates; `complete` when every part was fully readable. */
function descentBody(ctx: CandidateContext, entity: DecodedEntity): { points: Array<[number, number, number]>; complete: boolean } {
  const ids = [entity.expressId, ...ctx.reader.related(entity.expressId, RelationshipType.Aggregates, 'forward')];
  const points: Array<[number, number, number]> = [];
  let complete = true;
  for (const id of ids) {
    const f = ctx.placements.ofProduct(id);
    const body = f ? extrusionBody(ctx.reader, id) : null;
    // A body with an unreadable item (a Brep, a UNION) may reach lower than its readable corners.
    if (!f || !body?.complete) complete = false;
    if (f && body) for (const p of toWorld(f, body.corners)) points.push(ctx.georef.toMap(p) as [number, number, number]);
  }
  return { points, complete };
}

/**
 * Whether an external stair or ramp can lead down to the entry level. Only a
 * complete readable body wholly at or above the ground storey (1 cm tolerance)
 * proves it leads up; a placement origin alone does not (a ramp is often placed
 * at its top), nor a body with an unreadable item or UNION.
 */
function descentEvidence(ctx: CandidateContext, entity: DecodedEntity, level: number, body: ReturnType<typeof descentBody>): { keep: boolean; why: string } {
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
  const at = placed(ctx, entity);
  if (!at) return skip(NO_PLACEMENT);
  const external = isExternal(ctx.reader, entity);
  const body = descentBody(ctx, entity);
  const d = signedDistance(at.position, ctx.footprint);
  // Outside is decisive (an explicit `false` is often an authoring default): by placement, by any body corner, or,
  // when the body cannot be read, by a placement within the boundary tolerance (it may be placed at its inner end).
  const outside =
    d > 0 ? 'placed outside the footprint'
    : body.points.some((p) => signedDistance({ x: p[0], y: p[1] }, ctx.footprint) > 0) ? 'its body reaches outside the footprint'
    : !body.complete && Math.abs(d) <= ctx.boundaryTolerance ? `placed within ${ctx.boundaryTolerance} m of the outline and its body cannot be fully read`
    : null;
  if (!external && !outside) {
    return skip(`interior ${category}: placed ${Math.abs(d).toFixed(2)} m inside the footprint${body.complete ? ' and its body lies inside it' : ''}${external === false ? '; IsExternal = false' : ''}`);
  }
  const evidence = descentEvidence(ctx, entity, at.level, body);
  if (!evidence.keep) return skip(`external ${category}: ${evidence.why}`);
  const why = external ? 'IsExternal' : `${outside}${external === false ? ' (despite IsExternal = false)' : ''}`;
  return candidate(base(ctx, entity, category, { position: at.position, level: ctx.groundLevel }, `${why}; ${evidence.why}; entry at the terrain`, 'ground-storey-or-terrain'));
}

function inLowestStoreys(ctx: CandidateContext, id: number, level: number): boolean {
  const storey = ctx.storeyOf(id);
  const storeyLevel = storey === null ? undefined : ctx.storeyLevel.get(storey);
  return storeyLevel !== undefined ? storeyLevel <= ctx.groundLevel + 0.01 : level <= ctx.groundLevel + ctx.aboveGroundScope;
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
  const at = placed(ctx, entity);
  if (!at) return skip(NO_PLACEMENT);
  if (!inLowestStoreys(ctx, entity.expressId, at.level)) return skip('equipment above the ground storey');
  return candidate(base(ctx, entity, 'equipment', at, `${why} in the ground storey or below`));
}
