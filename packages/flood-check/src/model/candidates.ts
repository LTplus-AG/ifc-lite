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
 * - Stairs and ramps that lie outside the footprint (or are `IsExternal`).
 *   Interior stairs are not entry points. One whose body is readable and lies
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
 * their corrected level) are out of scope and are not listed.
 */

import { RelationshipType } from '@ifc-lite/data';
import { signedDistance } from '../geom.js';
import type { MapPoint } from '../types.js';
import type { CandidateCategory, CandidateFact, LevelBasis } from './facts.js';
import type { ModelGeoreference } from './georef.js';
import { extrusionBody, extrusionCorners, toWorld } from './outline.js';
import type { PlacementResolver } from './placement.js';
import { EQUIPMENT_OCCURRENCES, EQUIPMENT_TYPES, GENERIC_OCCURRENCES } from './equipment.js';
import { asEnum, asString, type DecodedEntity, type ModelReader } from './reader.js';

const DOOR_TYPES = ['IFCDOOR', 'IFCDOORSTANDARDCASE'];
const WINDOW_TYPES = ['IFCWINDOW', 'IFCWINDOWSTANDARDCASE'];
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

const COMMON_PSET: Record<string, string> = {
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
  skip(id: number, ifcClass: string, reason: string): void;
}

export function isExternal(reader: ModelReader, entity: DecodedEntity): boolean | null {
  const pset = COMMON_PSET[entity.type];
  if (!pset) return null;
  const v = reader.property(entity.expressId, pset, 'IsExternal');
  return typeof v === 'boolean' ? v : null;
}

function predefinedType(reader: ModelReader, entity: DecodedEntity): string | null {
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
function placed(ctx: CandidateContext, entity: DecodedEntity): { position: MapPoint; level: number } | null {
  const frame = ctx.placements.ofProduct(entity.expressId);
  if (!frame) {
    ctx.skip(entity.expressId, ctx.reader.className(entity), 'no readable IfcLocalPlacement chain');
    return null;
  }
  const [x, y, z] = ctx.georef.toMap(frame.origin);
  return { position: { x, y }, level: z };
}

/**
 * An opening's hole: plan centre and lowest point of its extrusion when
 * readable (`levelBasis` stays `placement-origin` only when it is not).
 */
function openingExtent(ctx: CandidateContext, entity: DecodedEntity): { position: MapPoint; level: number; fromBody: boolean } | null {
  const frame = ctx.placements.ofProduct(entity.expressId);
  if (!frame) {
    ctx.skip(entity.expressId, ctx.reader.className(entity), 'no readable IfcLocalPlacement chain');
    return null;
  }
  const corners = extrusionCorners(ctx.reader, entity.expressId);
  if (!corners) {
    const [x, y, z] = ctx.georef.toMap(frame.origin);
    return { position: { x, y }, level: z, fromBody: false };
  }
  const world = toWorld(frame, corners).map((p) => ctx.georef.toMap(p));
  let sx = 0;
  let sy = 0;
  let minZ = Infinity;
  for (const [x, y, z] of world) {
    sx += x;
    sy += y;
    minZ = Math.min(minZ, z);
  }
  return { position: { x: sx / world.length, y: sy / world.length }, level: minZ, fromBody: true };
}

function base(
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

function inScope(ctx: CandidateContext, level: number): boolean {
  return level <= ctx.groundLevel + ctx.aboveGroundScope;
}

function belowGround(ctx: CandidateContext, id: number, level: number): boolean {
  const storey = ctx.storeyOf(id);
  const storeyLevel = storey === null ? undefined : ctx.storeyLevel.get(storey);
  return storeyLevel !== undefined ? storeyLevel < ctx.groundLevel - 0.01 : level < ctx.groundLevel - 0.3;
}

/** The host a filling element or opening voids: opening → host element. */
function hostOfOpening(ctx: CandidateContext, openingId: number): DecodedEntity | null {
  const hosts = ctx.reader.related(openingId, RelationshipType.VoidsElement, 'inverse');
  return ctx.reader.entity(hosts[0]);
}

function facadeReason(ctx: CandidateContext, entity: DecodedEntity, host: DecodedEntity | null, at: MapPoint): string | null {
  const own = isExternal(ctx.reader, entity);
  if (own === true) return `IsExternal (${COMMON_PSET[entity.type]})`;
  const hostExternal = host ? isExternal(ctx.reader, host) : null;
  // An external host wins over the element's own `false`: authoring tools often default it.
  if (hostExternal === true) {
    return `host IsExternal (${COMMON_PSET[host!.type]})${own === false ? '; the element itself states IsExternal = false' : ''}`;
  }
  if (own === false || hostExternal === false) return null;
  // No outline to test against (no slab, no external wall): keep it rather than lose every façade element.
  if (ctx.footprint.length === 0) return 'IsExternal not stated and no footprint to test against (kept conservatively)';
  const d = signedDistance(at, ctx.footprint);
  return Number.isFinite(d) && Math.abs(d) <= ctx.boundaryTolerance
    ? `within ${ctx.boundaryTolerance} m of the footprint outline (IsExternal not stated)`
    : null;
}

/** Placement and opening-body levels further apart than this get a note. */
const LEVEL_DISAGREEMENT = 0.3;

/** A door's or window's level: the lower of its placement origin and the bottom of the opening it fills. */
function fillingLevel(
  ctx: CandidateContext,
  placementLevel: number,
  opening: DecodedEntity | null,
): { level: number; basis: LevelBasis; note?: string } {
  const body = opening ? openingExtent(ctx, opening) : null;
  if (!body || !body.fromBody) return { level: placementLevel, basis: 'placement-origin' };
  const diff = placementLevel - body.level;
  const note =
    Math.abs(diff) > LEVEL_DISAGREEMENT
      ? `placement origin ${placementLevel.toFixed(3)} m and the bottom of the filled opening ${body.level.toFixed(3)} m differ by ` +
        `${Math.abs(diff).toFixed(2)} m (some tools place windows at the head or centre); the lower is used`
      : undefined;
  return body.level < placementLevel
    ? { level: body.level, basis: 'opening-body-bottom', note }
    : { level: placementLevel, basis: 'placement-origin', note };
}

function collectFillings(ctx: CandidateContext, types: readonly string[], out: CandidateFact[]): void {
  const r = ctx.reader;
  for (const type of types) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity) continue;
      const at = placed(ctx, entity);
      if (!at) continue;
      const opening = r.related(id, RelationshipType.FillsElement, 'inverse')[0];
      const level = fillingLevel(ctx, at.level, opening === undefined ? null : r.entity(opening));
      if (!inScope(ctx, level.level)) continue;
      const host = opening === undefined ? null : hostOfOpening(ctx, opening);
      const reason = facadeReason(ctx, entity, host, at.position);
      if (!reason) continue;
      const isWindow = WINDOW_TYPES.includes(type);
      const category: CandidateCategory = isWindow
        ? belowGround(ctx, id, at.level) ? 'basement-window' : 'window'
        : 'door';
      const fact = base(ctx, entity, category, { position: at.position, level: level.level }, reason, level.basis);
      if (level.note) fact.notes = [level.note];
      if (host) fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
      out.push(fact);
    }
  }
}

function collectOpenings(ctx: CandidateContext, out: CandidateFact[]): void {
  const r = ctx.reader;
  for (const id of r.idsOfType('IFCOPENINGELEMENT')) {
    if (r.related(id, RelationshipType.FillsElement, 'forward').length > 0) continue;
    const entity = r.entity(id);
    if (!entity || predefinedType(r, entity) === 'RECESS') continue;
    if (LIGHT_WELL_NAME.test(`${asString(r.attr(entity, 'Name')) ?? ''} ${asString(r.attr(entity, 'ObjectType')) ?? ''}`)) continue;
    const host = hostOfOpening(ctx, id);
    if (!host) continue;
    const at = openingExtent(ctx, entity);
    if (!at) continue;
    if (host.type === 'IFCSLAB' || host.type === 'IFCSLABSTANDARDCASE' || host.type === 'IFCSLABELEMENTEDCASE') {
      const hostAt = placed(ctx, host);
      if (!hostAt || hostAt.level > ctx.groundLevel + 0.01) continue;
      const fact = base(ctx, entity, 'slab-opening', { position: at.position, level: hostAt.level }, 'unfilled opening in a slab at or below the ground storey', 'host-slab-top');
      fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
      out.push(fact);
      continue;
    }
    if (!inScope(ctx, at.level)) continue;
    const reason = facadeReason(ctx, host, null, at.position);
    if (!reason) continue;
    const fact = base(ctx, entity, 'wall-opening', at, `unfilled opening; ${reason}`, at.fromBody ? 'opening-body-bottom' : 'placement-origin');
    fact.host = { expressId: host.expressId, ifcClass: r.className(host) };
    out.push(fact);
  }
}

function collectLightWells(ctx: CandidateContext, out: CandidateFact[]): void {
  const r = ctx.reader;
  for (const type of LIGHT_WELL_TYPES) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity) continue;
      const label = `${asString(r.attr(entity, 'Name')) ?? ''} ${asString(r.attr(entity, 'ObjectType')) ?? ''}`;
      if (!LIGHT_WELL_NAME.test(label)) continue;
      const at = placed(ctx, entity);
      if (!at || !inScope(ctx, at.level)) continue;
      out.push(base(ctx, entity, 'light-well', at, `Name/ObjectType "${label.trim()}"`));
    }
  }
}

/**
 * Whether an external stair or ramp can lead down to the entry level. Only a
 * complete readable body wholly at or above the ground storey (1 cm tolerance)
 * proves it leads up; a placement origin alone does not (a ramp is often placed
 * at its top), nor a body with an unreadable item or UNION (`extrusionBody`).
 */
function descentEvidence(ctx: CandidateContext, entity: DecodedEntity, level: number): { keep: boolean; why: string } {
  if (belowGround(ctx, entity.expressId, level)) return { keep: true, why: 'in a storey below ground' };
  const frame = ctx.placements.ofProduct(entity.expressId);
  const ids = [entity.expressId, ...ctx.reader.related(entity.expressId, RelationshipType.Aggregates, 'forward')];
  let minZ = Infinity;
  let readable = 0;
  for (const id of ids) {
    const f = id === entity.expressId ? frame : ctx.placements.ofProduct(id);
    const body = f ? extrusionBody(ctx.reader, id) : null;
    if (!f || !body?.complete) continue;
    readable++;
    for (const p of toWorld(f, body.corners)) minZ = Math.min(minZ, ctx.georef.toMap(p)[2]);
  }
  if (readable === 0) return { keep: true, why: 'its body cannot be read, so it may lead down (kept conservatively)' };
  if (minZ < ctx.groundLevel - 0.01) return { keep: true, why: `its body reaches ${(ctx.groundLevel - minZ).toFixed(2)} m below the ground storey` };
  // One flight proven to lead up says nothing about a flight whose body cannot be read.
  if (readable < ids.length) return { keep: true, why: 'a part of it has no readable body (the readable parts lead up), so it may lead down (kept conservatively)' };
  return { keep: false, why: 'its body lies wholly at or above the ground storey (leads up)' };
}

function collectDescents(ctx: CandidateContext, types: readonly string[], category: 'stair' | 'ramp', out: CandidateFact[]): void {
  const r = ctx.reader;
  for (const type of types) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity) continue;
      // A flight inside a stair or ramp is reported through its container.
      if (type.endsWith('FLIGHT') && r.related(id, RelationshipType.Aggregates, 'inverse').length > 0) continue;
      const at = placed(ctx, entity);
      if (!at) continue;
      const external = isExternal(r, entity);
      const outside = signedDistance(at.position, ctx.footprint) > 0;
      // Outside the footprint is decisive: an explicit `false` is often an authoring default.
      if (!external && !outside) continue;
      const evidence = descentEvidence(ctx, entity, at.level);
      if (!evidence.keep) {
        ctx.skip(id, r.className(entity), `external ${category}: ${evidence.why}`);
        continue;
      }
      out.push(
        base(
          ctx,
          entity,
          category,
          { position: at.position, level: ctx.groundLevel },
          `${external ? 'IsExternal' : `outside the footprint${external === false ? ' (despite IsExternal = false)' : ''}`}; ${evidence.why}; entry at the terrain`,
          'ground-storey-or-terrain',
        ),
      );
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
  const taken = new Set<number>();
  const add = (entity: DecodedEntity, because: string) => {
    const at = placed(ctx, entity);
    if (!at || !inLowestStoreys(ctx, entity.expressId, at.level)) return;
    taken.add(entity.expressId);
    out.push(base(ctx, entity, 'equipment', at, `${because} in the ground storey or below`));
  };
  for (const { type, predefined } of EQUIPMENT_OCCURRENCES) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity || taken.has(id)) continue;
      const kind = predefinedType(r, entity);
      if (predefined && (!kind || !predefined.includes(kind))) continue;
      add(entity, `${r.className(entity)}${kind ? ` ${kind}` : ''}`);
    }
  }
  for (const type of GENERIC_OCCURRENCES) {
    for (const id of r.idsOfType(type)) {
      const entity = r.entity(id);
      if (!entity || taken.has(id)) continue;
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
