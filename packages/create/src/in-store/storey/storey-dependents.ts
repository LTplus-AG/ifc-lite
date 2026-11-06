/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Elements whose SHAPE depends on storey spacing (#9013, requirement 2):
 *
 * - a wall attached to a storey above (`storey-attachment.ts`) takes
 *   `height + Δtarget − Δown`, so its top stays on that storey;
 * - a stair whose top tread lands on a storey (base + risers × riser height
 *   equals that storey's elevation within 1 mm, which is what "the flight
 *   connects these levels" means physically) is refit to the new rise with
 *   the riser height it was built with, rounded to whole risers.
 *
 * Everything else keeps its shape and only moves (`storey-level-plan.ts`).
 */

import { StoreEditor } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { placementInAncestor, refId } from '../host-geometry-frame.js';
import { readStairDimensions } from '../stair-edit.js';
import { readWallMetres } from '../wall-size-edit.js';
import { readTopAttachment } from './storey-attachment.js';
import { siblingStoreys, storeyContents, storeyNeighbour, type StoreyInventory } from './storey-model.js';
import { describeLength, type StoreyNotice, type StoreyRefusal } from './storey-validation.js';

/** A storey's top tread lands on a storey when the two agree to this, metres. */
export const LANDING_TOLERANCE = 0.001;
/** Below this rise no flight is built (the stair tool's own floor). */
export const MIN_FLIGHT_RISE = 0.3;

export interface WallHeightChange {
  readonly wallId: number;
  readonly storeyId: number;
  readonly targetStoreyId: number;
  /** Metres. */
  readonly from: number;
  readonly to: number;
}

export interface StairRefit {
  readonly stairId: number;
  readonly flightId: number;
  readonly storeyId: number;
  readonly landingStoreyId: number;
  readonly from: { readonly NumberOfRisers: number; readonly RiserHeight: number };
  readonly to: { readonly NumberOfRisers: number; readonly RiserHeight: number };
}

export interface StoreyDependents {
  readonly walls: readonly WallHeightChange[];
  readonly stairs: readonly StairRefit[];
  readonly refusals: readonly StoreyRefusal[];
  readonly notices: readonly StoreyNotice[];
}

const WALL_TYPES = new Set(['IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCWALLELEMENTEDCASE']);

/**
 * Products on each storey, by the storey that holds them. A read, so not
 * bounded: the planner has already refused (`tooLarge`) any MOVED storey past
 * the limit, and what this finds is written only for attached walls and stairs.
 */
function productsByStorey(inventory: StoreyInventory): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const storey of inventory.storeys) result.set(storey.expressId, [...storeyContents(inventory, storey.expressId, Infinity)]);
  return result;
}

/** World Z of a product's placement relative to its storey's, metres; null when unreadable. */
function heightAboveStorey(inventory: StoreyInventory, productId: number, storeyId: number): number | null {
  const { reader, scale } = inventory;
  const own = refId(reader.entity(productId)?.attributes[5]);
  const storey = inventory.storeys.find((candidate) => candidate.expressId === storeyId);
  if (own === null || !storey) return null;
  const at = placementInAncestor(reader, own, null);
  const floor = storey.placementId === null ? null : placementInAncestor(reader, storey.placementId, null);
  if (!at) return null;
  // The storey frame's own Z where it has one, else its Elevation.
  return floor ? (at.o[2] - floor.o[2]) * scale : at.o[2] * scale - storey.elevation;
}

/**
 * What a set of storey deltas (metres) does to spacing-dependent elements.
 * Pure read; `storey-dependents-apply.ts` writes it.
 */
export function planStoreyDependents(inventory: StoreyInventory, deltas: ReadonlyMap<number, number>): StoreyDependents {
  const delta = (storeyId: number) => deltas.get(storeyId) ?? 0;
  const walls: WallHeightChange[] = [];
  const stairs: StairRefit[] = [];
  const refusals: StoreyRefusal[] = [];
  const notices: StoreyNotice[] = [];
  const unreadableWalls: number[] = [];
  const unrefittable: number[] = [];
  // The wall readers take an edit target; this one is only read through.
  const target = { dataStore: inventory.store, view: inventory.view, editor: new StoreEditor(inventory.store, inventory.view) };

  for (const [storeyId, products] of productsByStorey(inventory)) {
    for (const id of products) {
      const type = inventory.reader.entity(id)?.type.toUpperCase() ?? '';
      if (WALL_TYPES.has(type)) {
        const attachment = readTopAttachment(inventory, id);
        if (!attachment || attachment.targetStoreyId === null || attachment.targetStoreyId === storeyId) continue;
        const change = delta(attachment.targetStoreyId) - delta(storeyId);
        if (Math.abs(change) < 1e-9) continue;
        const wall = readWallMetres(target, id);
        if (!wall || !Number.isFinite(wall.height)) { unreadableWalls.push(id); continue; }
        walls.push({ wallId: id, storeyId, targetStoreyId: attachment.targetStoreyId, from: wall.height, to: wall.height + change });
      } else if (type === 'IFCSTAIR') {
        const refit = planStairRefit(inventory, id, storeyId, delta, refusals);
        if (refit === 'unreadable') unrefittable.push(id);
        else if (refit) stairs.push(refit);
      }
    }
  }

  for (const wall of walls) {
    if (wall.to < 0.01) {
      refusals.push({
        code: 'dependent', elementIds: [wall.wallId],
        message: `Wall #${wall.wallId} would end ${describeLength(wall.to)} tall: its top is attached to a storey the edit brings down to its base`,
      });
    }
  }
  if (unreadableWalls.length) {
    notices.push({ code: 'wallNotResized', elementIds: unreadableWalls, message: `${unreadableWalls.length} attached wall(s) are not simple extrusions, so they move but keep their height` });
  }
  if (unrefittable.length) {
    notices.push({ code: 'stairNotRefit', elementIds: unrefittable, message: `${unrefittable.length} stair(s) may reach a moved storey but are not a single stepped flight this editor can rebuild; they move but are not refit` });
  }
  return { walls, stairs, refusals, notices };
}

/** A stair's landing and its refit, null when its rise is unaffected, or 'unreadable'. */
function planStairRefit(
  inventory: StoreyInventory, stairId: number, storeyId: number, delta: (id: number) => number, refusals: StoreyRefusal[],
): StairRefit | 'unreadable' | null {
  const storey = inventory.storeys.find((candidate) => candidate.expressId === storeyId)!;
  const dims = readStairDimensions(inventory.store, stairId, inventory.view);
  const base = heightAboveStorey(inventory, stairId, storeyId);
  const rise = dims ? dims.NumberOfRisers * dims.RiserHeight : genericRise(inventory, stairId);
  if (rise === null || base === null) {
    // The file records no rise (a spiral or freeform stair whose body is the
    // IfcStair itself): it cannot be checked or refit. Report it whenever the
    // gap above its storey changes, rather than staying silent.
    const above = storeyNeighbour(inventory, storeyId, 1);
    return above && Math.abs(delta(above.expressId) - delta(storeyId)) > 1e-9 ? 'unreadable' : null;
  }
  const top = storey.elevation + base + rise;
  // A flight lands on a storey of its own building.
  const landing = siblingStoreys(inventory, storeyId).find((candidate) => candidate.expressId !== storeyId
    && Math.abs(candidate.elevation - top) <= LANDING_TOLERANCE);
  if (!landing) return null;
  const change = delta(landing.expressId) - delta(storeyId);
  if (Math.abs(change) < 1e-9) return null;
  if (!dims) return 'unreadable';
  const next = rise + change;
  const risers = Math.max(1, Math.round(next / dims.RiserHeight));
  const riser = next / risers;
  if (next < MIN_FLIGHT_RISE) {
    refusals.push({
      code: 'dependent', elementIds: [stairId],
      message: `The stair #${stairId} from ${storey.Name} to ${landing.Name} would have to climb ${describeLength(next)}: no flight fits; move or delete the stair first`,
      params: { stair: stairId, rise: next },
    });
    return null;
  }
  return {
    stairId: dims.stairId, flightId: dims.flightId, storeyId, landingStoreyId: landing.expressId,
    from: { NumberOfRisers: dims.NumberOfRisers, RiserHeight: dims.RiserHeight },
    to: { NumberOfRisers: risers, RiserHeight: riser },
  };
}

/** NumberOfRisers × RiserHeight read off a stair's flight, for third-party stairs; metres. */
function genericRise(inventory: StoreyInventory, stairId: number): number | null {
  for (const rel of inventory.outgoing.get(stairId) ?? []) {
    if (rel.type !== 'IFCRELAGGREGATES') continue;
    let rise = 0;
    for (const child of rel.children) {
      const flight = inventory.reader.entity(child);
      if (!flight || !getInheritanceChainAcrossSchemas(flight.type).includes('IfcStairFlight')) continue;
      const at = (name: string) => flight.attributes[flight.names.indexOf(name)];
      const n = at(inventory.schema === 'IFC2X3' ? 'NumberOfRiser' : 'NumberOfRisers');
      const raw = at('RiserHeight');
      const r = typeof raw === 'number' ? raw : raw && typeof raw === 'object' && 'real' in raw ? (raw as { real: unknown }).real : null;
      if (typeof n !== 'number' || typeof r !== 'number') return null;
      rise += n * r * inventory.scale;
    }
    return rise > 0 ? rise : null;
  }
  return null;
}

/**
 * Walls a new storey at `elevation` (metres) would bind: walls on the storey
 * directly below it that were drawn attached while no storey stood above
 * them (`NextStoreyAbove`). Each takes the height from its base to the new
 * floor. Pure read.
 */
export function planAttachmentBindings(inventory: StoreyInventory, elevation: number, parentId: number | null): WallHeightChange[] {
  // Only storeys of the building the new storey joins.
  const storeys = inventory.storeys.filter((storey) => storey.parentId === parentId);
  const below = [...storeys].reverse().find((storey) => storey.elevation < elevation);
  if (!below) return [];
  const above = storeys.find((storey) => storey.elevation > below.elevation);
  // Only the storey that has nothing above it can hold unbound walls.
  if (above && above.elevation < elevation) return [];
  const target = { dataStore: inventory.store, view: inventory.view, editor: new StoreEditor(inventory.store, inventory.view) };
  const changes: WallHeightChange[] = [];
  // A read of the storey below; only its unbound attached walls are written.
  for (const id of storeyContents(inventory, below.expressId, Infinity)) {
    if (!WALL_TYPES.has(inventory.reader.entity(id)?.type.toUpperCase() ?? '')) continue;
    const attachment = readTopAttachment(inventory, id);
    if (!attachment || attachment.targetStoreyId !== null) continue;
    const wall = readWallMetres(target, id);
    const base = heightAboveStorey(inventory, id, below.expressId);
    if (!wall || base === null) continue;
    // targetStoreyId is filled in by the add, which knows the new storey's id.
    changes.push({ wallId: id, storeyId: below.expressId, targetStoreyId: -1, from: wall.height, to: elevation - below.elevation - base });
  }
  return changes;
}
