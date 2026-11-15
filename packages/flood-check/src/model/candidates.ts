/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which elements are candidates, and their level.
 *
 * - Doors and windows in the façade: `IsExternal` on the element
 *   (Pset_DoorCommon / Pset_WindowCommon) or its host wall (Pset_WallCommon).
 *   An external host wins over the element's own `false` (authoring tools
 *   often default it). When neither states it, an element within
 *   `boundaryTolerance` of the footprint outline counts as façade; otherwise
 *   an explicit `false` excludes. Windows below the ground storey are
 *   `basement-window`.
 * - Unfilled openings in external walls (`wall-opening`) and in slabs at or
 *   below the ground storey (`slab-opening`); RECESS openings are not through.
 * - Light wells: no IFC class exists, so proxies, chambers, civil elements,
 *   assemblies and openings whose Name/ObjectType say so (DE/FR/IT/EN).
 * - Stairs and ramps that lie outside the footprint (or are `IsExternal`): by
 *   placement, by any body corner, or, with no readable body, by a placement
 *   within `boundaryTolerance` of the outline. Interior stairs are not entry points. One whose body is readable and lies
 *   wholly above the ground storey leads up and is skipped; every other one is
 *   kept (its placement origin may be at its top), with the entry level at the
 *   terrain (`ground-storey-or-terrain`).
 * - Technical equipment in the ground storey and below, by class and
 *   predefined type, or through the type object of a generic occurrence (see
 *   `equipment.ts`).
 * - Door and window levels: the lower of the placement origin and the filled
 *   opening's body bottom, noted when 0.3 m apart (windows placed at head/centre).
 *
 * Doors, windows and openings above `ground storey + aboveGroundScope` (by
 * their corrected level) are out of scope.
 *
 * Every element of a covered class ends up as a candidate or in `skipped`
 * with a reason, exactly once. An exclusion that would rest on unreadable
 * data (a body, a kind) keeps the element instead, with an upper-estimate
 * level where its level is in doubt, so it can flag but never reassure.
 */

import { RelationshipType } from '@ifc-lite/data';
import { signedDistance } from '../geom.js';
import type { CandidateCategory, CandidateFact } from './facts.js';
import { extrusionBody, toWorld } from './outline.js';
import { EQUIPMENT_OCCURRENCES, EQUIPMENT_TYPES, GENERIC_OCCURRENCES } from './equipment.js';
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

export { isExternal, type CandidateContext } from './candidate-base.js';

const DOOR_TYPES = ['IFCDOOR', 'IFCDOORSTANDARDCASE'];
const WINDOW_TYPES = ['IFCWINDOW', 'IFCWINDOWSTANDARDCASE'];
const FILLING_TYPES = new Set([...DOOR_TYPES, ...WINDOW_TYPES]);
const STAIR_TYPES = ['IFCSTAIR', 'IFCSTAIRFLIGHT'];
const RAMP_TYPES = ['IFCRAMP', 'IFCRAMPFLIGHT'];
const LIGHT_WELL_TYPES = [
  'IFCBUILDINGELEMENTPROXY',
  'IFCDISTRIBUTIONCHAMBERELEMENT',
  'IFCCIVILELEMENT',
  'IFCELEMENTASSEMBLY',
  'IFCOPENINGELEMENT',
];
export const LIGHT_WELL_NAME = /licht\s*schacht|kellerschacht|light\s*-?\s*well|areaway|saut[\s-]+de[\s-]+loup|bocca\s+di\s+lupo|pozzo\s+di\s+luce/i;

const label = (ctx: CandidateContext, e: DecodedEntity) =>
  `${asString(ctx.reader.attr(e, 'Name')) ?? ''} ${asString(ctx.reader.attr(e, 'ObjectType')) ?? ''}`;
const skip = (ctx: CandidateContext, e: DecodedEntity, reason: string) => ctx.skip(e.expressId, ctx.reader.className(e), reason);

function collectFillings(ctx: CandidateContext, types: readonly string[], out: CandidateFact[]): void {
  const r = ctx.reader;
  for (const type of types) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity) continue;
      const at = placed(ctx, entity);
      if (!at) {
        skip(ctx, entity, NO_PLACEMENT);
        continue;
      }
      const opening = r.related(id, RelationshipType.FillsElement, 'inverse')[0];
      const filled = fillingAt(ctx, at, opening === undefined ? null : r.entity(opening));
      if (!inScope(ctx, filled.level)) {
        skip(ctx, entity, outOfScopeReason(ctx, filled.level));
        continue;
      }
      const host = opening === undefined ? null : hostOfOpening(ctx, opening);
      const reason = facadeReason(ctx, entity, host, filled.position);
      if (typeof reason !== 'string') {
        skip(ctx, entity, reason.not);
        continue;
      }
      const isWindow = WINDOW_TYPES.includes(type);
      const category: CandidateCategory = isWindow
        ? belowGround(ctx, id, at.level) ? 'basement-window' : 'window'
        : 'door';
      const fact = base(ctx, entity, category, { position: filled.position, level: filled.level }, reason, filled.basis);
      if (filled.upperEstimate) fact.levelIsUpperEstimate = true;
      if (filled.notes.length > 0) fact.notes = filled.notes;
      if (host) fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
      out.push(fact);
    }
  }
}

function collectOpenings(ctx: CandidateContext, out: CandidateFact[]): void {
  const r = ctx.reader;
  // A skip that says another element reports for this one is only true when that element is a candidate.
  const reported = new Set(out.map((c) => c.expressId));
  for (const id of r.idsOfType('IFCOPENINGELEMENT')) {
    const entity = r.entity(id);
    if (!entity) continue;
    // A light well named so is collected as one.
    if (LIGHT_WELL_NAME.test(label(ctx, entity))) continue;
    // Filled by a door or window that is a candidate: reported through it. Otherwise (a gate as a proxy, a door that
    // could not be placed or was excluded) the hole is checked on its own.
    const filling = r.related(id, RelationshipType.FillsElement, 'forward').map((f) => r.entity(f)).find((f) => f && FILLING_TYPES.has(f.type));
    if (filling && reported.has(filling.expressId)) {
      skip(ctx, entity, `filled by ${r.className(filling)} #${filling.expressId}, which is reported for it`);
      continue;
    }
    const fillingNote = filling ? `its filling ${r.className(filling)} #${filling.expressId} is not a candidate (see skipped), so the hole is checked itself` : null;
    if (predefinedType(r, entity) === 'RECESS') {
      skip(ctx, entity, 'a RECESS opening, not through the wall');
      continue;
    }
    const at = openingExtent(ctx, entity);
    if (!at) {
      skip(ctx, entity, NO_PLACEMENT);
      continue;
    }
    const host = hostOfOpening(ctx, id);
    const levelBasis = at.fromBody ? 'opening-body-bottom' : 'placement-origin';
    if (host && (host.type === 'IFCSLAB' || host.type === 'IFCSLABSTANDARDCASE' || host.type === 'IFCSLABELEMENTEDCASE')) {
      const hostAt = placed(ctx, host);
      if (hostAt && hostAt.level > ctx.groundLevel + 0.01) {
        skip(ctx, entity, `in a slab above the ground storey (${hostAt.level.toFixed(3)} m)`);
        continue;
      }
      // An unplaced host slab may be at or below the ground storey: kept, at the opening's own level as an upper estimate.
      const fact = hostAt
        ? base(ctx, entity, 'slab-opening', { position: at.position, level: hostAt.level }, 'unfilled opening in a slab at or below the ground storey', 'host-slab-top')
        : base(ctx, entity, 'slab-opening', at, 'unfilled opening in a slab whose placement cannot be read (kept conservatively)', levelBasis);
      if (!hostAt) fact.levelIsUpperEstimate = true;
      fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
      out.push(fact);
      continue;
    }
    if (!inScope(ctx, at.level)) {
      skip(ctx, entity, outOfScopeReason(ctx, at.level));
      continue;
    }
    // With no host, the opening itself is tested against the outline.
    const reason = facadeReason(ctx, host ?? entity, null, at.position);
    if (typeof reason !== 'string') {
      skip(ctx, entity, reason.not);
      continue;
    }
    const fact = base(ctx, entity, 'wall-opening', at, `${filling ? 'opening' : 'unfilled opening'}; ${reason}${host ? '' : ' (no host element)'}`, levelBasis);
    const notes = fillingNote ? [fillingNote] : [];
    if (at.partial) {
      fact.levelIsUpperEstimate = true;
      notes.push('part of the opening\'s body cannot be read, so it may reach lower: the level is an upper estimate');
    }
    if (notes.length > 0) fact.notes = notes;
    if (host) fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
    out.push(fact);
  }
}

function collectLightWells(ctx: CandidateContext, out: CandidateFact[]): void {
  const r = ctx.reader;
  for (const type of LIGHT_WELL_TYPES) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity || !LIGHT_WELL_NAME.test(label(ctx, entity))) continue;
      const at = placed(ctx, entity);
      if (!at) skip(ctx, entity, NO_PLACEMENT);
      else if (!inScope(ctx, at.level)) skip(ctx, entity, outOfScopeReason(ctx, at.level));
      else out.push(base(ctx, entity, 'light-well', at, `Name/ObjectType "${label(ctx, entity).trim()}"`));
    }
  }
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

function collectDescents(ctx: CandidateContext, types: readonly string[], category: 'stair' | 'ramp', out: CandidateFact[]): void {
  const r = ctx.reader;
  // How each container was decided (containers come before their flights in `types`): a flight is reported or assessed
  // through it, unless the container could not be placed, or is no stair or ramp: then the flight is checked on its own.
  const decided = new Map<number, string>();
  const skipAs = (e: DecodedEntity, reason: string) => {
    decided.set(e.expressId, reason);
    skip(ctx, e, reason);
  };
  for (const type of types) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity) continue;
      const container = type.endsWith('FLIGHT') ? r.related(id, RelationshipType.Aggregates, 'inverse')[0] : undefined;
      const verdict = container === undefined ? undefined : decided.get(container);
      if (verdict !== undefined && verdict !== NO_PLACEMENT) {
        skip(ctx, entity, verdict === 'candidate' ? `part of #${container}, which is reported for it` : `part of #${container}, assessed with it (${verdict})`);
        continue;
      }
      const at = placed(ctx, entity);
      if (!at) {
        skipAs(entity, NO_PLACEMENT);
        continue;
      }
      const external = isExternal(r, entity);
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
        skipAs(entity, `interior ${category}: placed ${Math.abs(d).toFixed(2)} m inside the footprint${body.complete ? ' and its body lies inside it' : ''}${external === false ? '; IsExternal = false' : ''}`);
        continue;
      }
      const evidence = descentEvidence(ctx, entity, at.level, body);
      if (!evidence.keep) {
        skipAs(entity, `external ${category}: ${evidence.why}`);
        continue;
      }
      const why = external ? 'IsExternal' : `${outside}${external === false ? ' (despite IsExternal = false)' : ''}`;
      decided.set(id, 'candidate');
      out.push(base(ctx, entity, category, { position: at.position, level: ctx.groundLevel }, `${why}; ${evidence.why}; entry at the terrain`, 'ground-storey-or-terrain'));
    }
  }
}

function inLowestStoreys(ctx: CandidateContext, id: number, level: number): boolean {
  const storey = ctx.storeyOf(id);
  const storeyLevel = storey === null ? undefined : ctx.storeyLevel.get(storey);
  return storeyLevel !== undefined ? storeyLevel <= ctx.groundLevel + 0.01 : level <= ctx.groundLevel + ctx.aboveGroundScope;
}

function collectEquipment(ctx: CandidateContext, out: CandidateFact[]): void {
  const r = ctx.reader;
  const add = (entity: DecodedEntity, because: string) => {
    const at = placed(ctx, entity);
    if (!at) skip(ctx, entity, NO_PLACEMENT);
    else if (!inLowestStoreys(ctx, entity.expressId, at.level)) skip(ctx, entity, 'equipment above the ground storey');
    else out.push(base(ctx, entity, 'equipment', at, `${because} in the ground storey or below`));
  };
  for (const { type, predefined } of EQUIPMENT_OCCURRENCES) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity) continue;
      const kind = predefinedType(r, entity);
      const stated = kind !== null && kind !== 'NOTDEFINED' && kind !== 'USERDEFINED';
      if (predefined && stated && !predefined.includes(kind)) {
        skip(ctx, entity, `${r.className(entity)} ${kind} is not a kind the check covers (${predefined.join(', ')})`);
        continue;
      }
      // An unstated kind may be a covered one: kept.
      add(entity, `${r.className(entity)}${stated ? ` ${kind}` : predefined ? ' (kind not stated, kept conservatively)' : ''}`);
    }
  }
  for (const type of GENERIC_OCCURRENCES) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity) continue;
      const typeObject = r
        .related(id, RelationshipType.DefinesByType, 'inverse')
        .map((t) => r.entity(t))
        .find((t): t is DecodedEntity => t !== null && EQUIPMENT_TYPES.has(t.type));
      if (!typeObject) continue;
      const kind = predefinedType(r, entity);
      add(entity, `${r.className(entity)} typed ${r.className(typeObject)}${kind ? ` ${kind}` : ''}`);
    }
  }
}

export function collectCandidates(ctx: CandidateContext): CandidateFact[] {
  const out: CandidateFact[] = [];
  collectFillings(ctx, DOOR_TYPES, out);
  collectFillings(ctx, WINDOW_TYPES, out);
  collectOpenings(ctx, out);
  collectLightWells(ctx, out);
  collectDescents(ctx, STAIR_TYPES, 'stair', out);
  collectDescents(ctx, RAMP_TYPES, 'ramp', out);
  collectEquipment(ctx, out);
  return out;
}
