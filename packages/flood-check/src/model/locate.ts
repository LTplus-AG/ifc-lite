/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Where a candidate is and how low it reaches: the one place candidate
 * selection reads placements and bodies ({@link readSources},
 * {@link readDescentBody}) and the one function that turns what could be read
 * into a plan position, a lowest relevant level and its quality
 * ({@link locate}).
 *
 * Quality:
 * - `exact` only when every source that could lower the level or move the
 *   position was readable and was used;
 * - `upper-estimate` whenever a body that could do so (the element's own, or
 *   the opening it fills) exists but could not be read, in whole or in part,
 *   or is absent where the element's level is only defined by it (an opening
 *   is its body; a light well's placement has no defined height), and
 *   whenever a placement alone would have to stand for the level: a door or
 *   window with no readable body and no readable filled opening, equipment
 *   with no readable body. The level can then flag but never clear
 *   (`level-upper-estimate`);
 * - a refusal when the element has no readable placement: no position.
 *
 * Unreadable never counts as "nothing there": a body is described by how many
 * items it has and how many of them were read ({@link BodyReading}).
 */

import { RelationshipType } from '@ifc-lite/data';
import type { MapPoint } from '../types.js';
import type { LevelBasis } from './facts.js';
import { readBody, toWorld } from './outline.js';
import { asNumber, type DecodedEntity } from './reader.js';
import type { CandidateContext } from './candidate-base.js';

export type LocateKind = 'door' | 'window' | 'opening' | 'slab-opening' | 'light-well' | 'stair' | 'ramp' | 'equipment';
/** `lower-bound`: read from a clipped body's outer operand, which may have lost its bottom; the true level is no lower. */
export type LevelQuality = 'exact' | 'upper-estimate' | 'lower-bound';
export type Readability = 'none' | 'readable' | 'partial' | 'unreadable';

/** A body in map coordinates: how many solid items it has, how many were read, and the read corners. */
export interface MapBody {
  items: number;
  readable: number;
  corners: Array<[number, number, number]>;
  /** Readable items read through a clipped solid's first operand: they bound the level, not the position. */
  clipped?: number;
}

/** Everything {@link locate} decides from. */
export interface LocationSources {
  placement: { position: MapPoint; level: number } | null;
  /** The element's own body. */
  own: MapBody;
  /** Doors and windows: the body of the opening they fill; null when they fill none. */
  filled?: MapBody | null;
  /** Slab openings: the level of the slab they cut; null when it cannot be placed. */
  hostLevel?: number | null;
  /** Stairs and ramps: their entry is at the terrain, compared from the ground storey level down. */
  groundLevel?: number;
  /** Doors and windows: `OverallHeight` in metres, when stated (IFC2X3, IFC4, IFC4X3 all carry it). */
  overallHeight?: number | null;
}

export interface Location {
  position: MapPoint;
  level: number;
  basis: LevelBasis;
  quality: LevelQuality;
  /**
   * The position comes from a source that defines it and was read in full:
   * a fully readable body (the filled opening's, for a door or window), or a
   * placement the schema defines (a door, window or equipment with no body
   * that could place it elsewhere). An uncertain position proves nothing about
   * an element's distance to the outline.
   */
  positionCertain: boolean;
  /**
   * The lowest level the element can reach, proven from readable data; null
   * when nothing bounds it. `exact`: the level itself. An upper estimate: for
   * a door or window, its placement minus its `OverallHeight` (which covers a
   * placement at the head); otherwise none (an opening is bounded only by its
   * own readable body: it may be taller than its door or window). Only this
   * may prove an element out of scope; a storey never stands in for it.
   */
  lowest: number | null;
  notes: string[];
}

export const NO_BODY: MapBody = { items: 0, readable: 0, corners: [] };

export function readability(b: MapBody): Readability {
  if (b.items === 0) return 'none';
  if (b.readable === 0) return 'unreadable';
  return b.readable < b.items ? 'partial' : 'readable';
}

function centre(b: MapBody): MapPoint {
  let x = 0;
  let y = 0;
  for (const c of b.corners) {
    x += c[0];
    y += c[1];
  }
  return { x: x / b.corners.length, y: y / b.corners.length };
}

const bottom = (b: MapBody) => Math.min(...b.corners.map((c) => c[2]));

/** Placement and body positions or levels further apart than these get a note. */
const POSITION_DISAGREEMENT = 1;
const LEVEL_DISAGREEMENT = 0.3;

/** The position, lowest relevant level and quality of one element, or a refusal when it cannot be placed. */
export function locate(kind: LocateKind, s: LocationSources): Location | { refused: string } {
  const at = s.placement;
  if (!at) return { refused: 'no readable IfcLocalPlacement chain' };
  const notes: string[] = [];
  const own = readability(s.own);
  if (kind === 'stair' || kind === 'ramp') {
    return { position: at.position, level: s.groundLevel ?? at.level, basis: 'ground-storey-or-terrain', quality: 'upper-estimate', positionCertain: true, lowest: null, notes };
  }
  const filled = s.filled ? readability(s.filled) : 'none';
  const ownRead = s.own.readable > 0;
  const filledRead = !!s.filled && s.filled.readable > 0;

  // Position: the hole a door or window fills, else the element's own body, else its placement.
  let position = at.position;
  const filling = kind === 'door' || kind === 'window';
  const bodyDefined = kind === 'opening' || kind === 'slab-opening' || kind === 'light-well';
  // A door's or window's position is certain only from geometry actually read: the hole it fills, else its own body.
  let positionCertain = filling ? (filledRead ? filled === 'readable' : own === 'readable') : kind === 'equipment' ? own === 'readable' : !bodyDefined || own === 'readable';
  // A clipped body's first operand bounds the solid but its centre is not the solid's (the remainder may be one end of it).
  const clippedBody = (b: MapBody | null | undefined) => (b?.clipped ?? 0) > 0;
  if (filling && filledRead) {
    position = centre(s.filled!);
    if (clippedBody(s.filled)) {
      positionCertain = false;
      notes.push('the hole it fills is read from a clipped body\'s outer operand, so its centre is not proven: the position is uncertain');
    }
    const apart = Math.hypot(position.x - at.position.x, position.y - at.position.y);
    if (apart > POSITION_DISAGREEMENT) notes.push(`placed ${apart.toFixed(2)} m from the hole it fills (for example at its wall's origin); the hole's position is used`);
  } else if (ownRead) {
    position = centre(s.own);
    if (own !== 'readable') positionCertain = false;
    if (clippedBody(s.own)) {
      positionCertain = false;
      notes.push('its body is read from a clipped solid\'s outer operand, so its centre is not proven: the position is uncertain');
    }
  }

  // Level: the lowest of the sources that define it for this kind.
  let level = at.level;
  let basis: LevelBasis = 'placement-origin';
  // Whether the level came from a clipped body (its outer operand's bottom: the true bottom may be higher).
  let fromClipped = false;
  const lower = (value: number, why: LevelBasis, clipped: boolean) => {
    if (value < level) {
      level = value;
      basis = why;
      fromClipped = clipped;
    } else if (value === level && clipped) {
      // A clipped body's bottom equal to the level still only bounds it: the cut may have removed what lay there.
      fromClipped = true;
    }
  };
  if (kind === 'opening' || kind === 'slab-opening') {
    // An opening is its body; its placement is often its wall's origin.
    if (ownRead) {
      level = bottom(s.own);
      basis = 'opening-body-bottom';
      fromClipped = clippedBody(s.own);
    }
    // A slab opening: the lower of the slab's placement and its own readable body's bottom.
    if (kind === 'slab-opening' && typeof s.hostLevel === 'number' && (!ownRead || s.hostLevel < level)) {
      level = s.hostLevel;
      basis = 'host-slab-top';
      fromClipped = false;
    }
  } else {
    if (ownRead) lower(bottom(s.own), kind === 'light-well' ? 'opening-body-bottom' : 'body-bottom', clippedBody(s.own));
    if (filledRead) {
      const holeBottom = bottom(s.filled!);
      if (Math.abs(at.level - holeBottom) > LEVEL_DISAGREEMENT) {
        notes.push(
          `placement origin ${at.level.toFixed(3)} m and the bottom of the filled opening ${holeBottom.toFixed(3)} m differ by ` +
            `${Math.abs(at.level - holeBottom).toFixed(2)} m (some tools place windows at the head or centre); the lower is used`,
        );
      }
      lower(holeBottom, 'opening-body-bottom', clippedBody(s.filled));
    }
  }

  // Quality: anything that exists but could not be read, or is absent where it alone defines the level, leaves an upper estimate.
  const doubts: string[] = [];
  if (own === 'partial' || own === 'unreadable') doubts.push(`${own === 'partial' ? 'part of its' : 'its'} body cannot be read, so it may reach lower`);
  if (filled === 'partial' || filled === 'unreadable') doubts.push(`${filled === 'partial' ? 'part of the' : 'the'} filled opening's body cannot be read, so the hole may reach lower`);
  if ((kind === 'opening' || kind === 'slab-opening') && own === 'none') doubts.push('it has no body, so its placement stands for the hole, which may lie lower or elsewhere');
  if (kind === 'light-well' && own === 'none') doubts.push('it has no body, and a light well\'s placement has no defined height');
  if (kind === 'slab-opening' && s.hostLevel === null) doubts.push('the slab it cuts cannot be placed');
  // A placement alone is never exact (a door or window may be placed at its head, equipment anywhere on its body): it needs
  // geometry actually read. A body that exists but cannot be read is already a doubt above.
  if ((filling || kind === 'equipment') && own === 'none' && (!filling || filled === 'none')) {
    doubts.push(filling ? 'no readable body or filled opening corroborates its placement, which may be at its head' : 'no body corroborates its placement');
  }
  for (const d of doubts) notes.push(`${d}: the level is an upper estimate`);
  // An upper estimate wins (it may be too high, so it can never clear); else a level from a clipped body is only a lower bound.
  const quality: LevelQuality = doubts.length > 0 ? 'upper-estimate' : fromClipped ? 'lower-bound' : 'exact';
  if (quality === 'lower-bound') notes.push('the level is read from a clipped body\'s outer operand, which may have lost its bottom: it is a lower bound, the true level may be higher');
  let lowest: number | null = null;
  // A lower bound is exactly what the scope rule needs.
  if (quality === 'exact' || quality === 'lower-bound') lowest = level;
  else if (filling && typeof s.overallHeight === 'number') lowest = Math.min(level, at.level - s.overallHeight);
  return { position, level, basis, quality, positionCertain, lowest, notes };
}

function mapBody(ctx: CandidateContext, id: number): MapBody {
  const frame = ctx.placements.ofProduct(id);
  const body = readBody(ctx.reader, id);
  // A body that cannot be placed cannot be read either.
  if (!frame) return { items: Math.max(1, body.items), readable: 0, corners: [] };
  return { items: body.items, readable: body.readable, clipped: body.clipped, corners: toWorld(frame, body.corners).map((p) => ctx.georef.toMap(p) as [number, number, number]) };
}

/** The `OverallHeight` a door or window may plausibly have, metres; outside it the attribute bounds nothing. */
export const OVERALL_HEIGHT_RANGE: readonly [number, number] = [0.1, 10];

/** A door's or window's `OverallHeight` in metres (map vertical units), or null when it states none or an implausible one. */
function overallHeight(ctx: CandidateContext, id: number): number | null {
  const e = ctx.reader.entity(id);
  const raw = e ? asNumber(ctx.reader.attr(e, 'OverallHeight')) : null;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  // Through the georeference, so the project unit and the map scale apply as to every other height.
  const frame = ctx.placements.ofProduct(id);
  if (!frame) return null;
  const top = ctx.georef.toMap(frame.origin)[2];
  const below = ctx.georef.toMap([frame.origin[0], frame.origin[1], frame.origin[2] - raw])[2];
  const h = top - below;
  // Only a plausible door or window height bounds anything; a wrong unit or a typo gives no bound.
  return h >= OVERALL_HEIGHT_RANGE[0] && h <= OVERALL_HEIGHT_RANGE[1] ? h : null;
}

/** What candidate selection can read about an element (and the opening it fills, or the slab it cuts). */
export function readSources(ctx: CandidateContext, entity: DecodedEntity, kind: LocateKind, host?: DecodedEntity | null): LocationSources {
  const frame = ctx.placements.ofProduct(entity.expressId);
  const placement = frame ? (() => {
    const [x, y, z] = ctx.georef.toMap(frame.origin);
    return { position: { x, y }, level: z };
  })() : null;
  const s: LocationSources = { placement, own: frame ? mapBody(ctx, entity.expressId) : { ...NO_BODY }, groundLevel: ctx.groundLevel };
  if (kind === 'door' || kind === 'window') {
    const opening = ctx.reader.related(entity.expressId, RelationshipType.FillsElement, 'inverse')[0];
    s.filled = opening === undefined ? null : mapBody(ctx, opening);
    s.overallHeight = overallHeight(ctx, entity.expressId);
  }
  if (kind === 'slab-opening' && host) {
    const hostFrame = ctx.placements.ofProduct(host.expressId);
    s.hostLevel = hostFrame ? ctx.georef.toMap(hostFrame.origin)[2] : null;
  }
  return s;
}

/** A stair's or ramp's own body and its parts' bodies, in map coordinates; `complete` when every part was fully readable. */
export function readDescentBody(ctx: CandidateContext, entity: DecodedEntity): { points: Array<[number, number, number]>; complete: boolean } {
  const ids = [entity.expressId, ...ctx.reader.related(entity.expressId, RelationshipType.Aggregates, 'forward')];
  const points: Array<[number, number, number]> = [];
  let complete = true;
  for (const id of ids) {
    const body = ctx.placements.ofProduct(id) ? mapBody(ctx, id) : { ...NO_BODY };
    // A part with no body, or with an unreadable item (a Brep, a UNION), may reach lower than its readable corners.
    if (readability(body) !== 'readable') complete = false;
    points.push(...body.corners);
  }
  return { points, complete };
}
