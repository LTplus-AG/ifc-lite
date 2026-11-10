/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Elements whose SHAPE depends on storey spacing (#9013, requirement 2; #9296):
 *
 * - a wall, column, beam, member or curtain wall attached to a storey above
 *   (`storey-attachment.ts`) moves its top by `Δtarget − Δown`, so the top
 *   keeps its offset from that storey; one attached to a slab ends on the
 *   slab's underside (`storey-attachment-target.ts`). How each kind's top
 *   moves is `storey-attached.ts`;
 * - a stair whose top tread lands on a storey (base + risers × riser height
 *   equals that storey's elevation within 1 mm, which is what "the flight
 *   connects these levels" means physically) is refit to the new rise with
 *   the riser height it was built with, rounded to whole risers, and a
 *   railing that runs up it is stretched with it (`railing-stair-refit.ts`).
 *
 * Everything else keeps its shape and only moves (`storey-level-plan.ts`).
 */

import { StoreEditor } from '@ifc-lite/mutations';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { placementInAncestor, refId } from '../host-geometry-frame.js';
import { railingsOnStair, type RailingRefit } from '../railing-stair-refit.js';
import { readStairDimensions } from '../stair-edit.js';
import { attachedKind, attachedTopWorldOrigin, readAttachedTop, MIN_ATTACHED_EXTENT, type AttachedKind } from './storey-attached.js';
import { readTopAttachment, topAttachmentProblem } from './storey-attachment.js';
import { attachedTopTarget } from './storey-attachment-target.js';
import { wallQuantitySetCount } from './storey-level-write.js';
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

/**
 * A column, beam, member or curtain wall whose top follows its attachment
 * (#9296). `from` and `to` are the kind's `top` measure (`storey-attached.ts`):
 * the height above its base, or a beam's top end above its placement's parent.
 */
export interface AttachedHeightChange {
  readonly elementId: number;
  readonly kind: Exclude<AttachedKind, 'wall'>;
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
  readonly attached: readonly AttachedHeightChange[];
  readonly stairs: readonly StairRefit[];
  /** Railings that run up a refit stair, stretched with it. */
  readonly railings: readonly RailingRefit[];
  readonly refusals: readonly StoreyRefusal[];
  readonly notices: readonly StoreyNotice[];
}

const KIND_NAMES: Record<AttachedKind, string> = { wall: 'Wall', column: 'Column', linear: 'Beam', curtainWall: 'Curtain wall' };

/**
 * Products on each storey, by the storey that holds them. A read, so not
 * bounded: the planner has already refused (`tooLarge`) any MOVED storey past
 * the limit, and what this finds is written only for attached elements, stairs and their railings.
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

const editTarget = (inventory: StoreyInventory) => ({ dataStore: inventory.store, view: inventory.view, editor: new StoreEditor(inventory.store, inventory.view) });

/**
 * What a set of storey deltas (metres) does to spacing-dependent elements.
 * Pure read; `storey-level-write.ts` writes it.
 */
export function planStoreyDependents(inventory: StoreyInventory, deltas: ReadonlyMap<number, number>): StoreyDependents {
  const delta = (storeyId: number) => deltas.get(storeyId) ?? 0;
  const walls: WallHeightChange[] = [];
  const attached: AttachedHeightChange[] = [];
  const stairs: StairRefit[] = [];
  const refusals: StoreyRefusal[] = [];
  const notices: StoreyNotice[] = [];
  const unreadable = new Map<AttachedKind, number[]>();
  const unresolved: Array<{ id: number; problem: string }> = [];
  const unrefittable: number[] = [];
  // Whether an edit changes the spacing above a storey: it moves, or a storey above it moves by another amount.
  const spacingAboveChanges = (storeyId: number) => {
    const record = inventory.storeys.find((storey) => storey.expressId === storeyId);
    return !!record && inventory.storeys.some((storey) => storey.parentId === record.parentId
      && storey.elevation > record.elevation && Math.abs(delta(storey.expressId) - delta(storeyId)) > 1e-9);
  };
  // The element readers take an edit target; this one is only read through.
  const target = editTarget(inventory);
  const byStorey = productsByStorey(inventory);

  for (const [storeyId, products] of byStorey) {
    for (const id of products) {
      const type = inventory.reader.entity(id)?.type.toUpperCase() ?? '';
      const kind = attachedKind(type);
      if (kind) {
        const attachment = readTopAttachment(inventory, id);
        if (!attachment) {
          // A record naming nothing it can follow is reported, not guessed at.
          // Reported whenever the edit touches the element: its storey moves, or the spacing above it changes.
          const touched = Math.abs(delta(storeyId)) > 1e-9 || spacingAboveChanges(storeyId);
          const problem = touched ? topAttachmentProblem(inventory, id) : null;
          if (problem) unresolved.push({ id, problem });
          continue;
        }
        if (attachment.targetStoreyId === null || (attachment.kind === 'storey' && attachment.targetStoreyId === storeyId)) continue;
        const ownDelta = delta(storeyId), targetDelta = delta(attachment.targetStoreyId);
        if (Math.abs(targetDelta - ownDelta) < 1e-9) continue;
        const from = readAttachedTop(target, id, kind);
        const to = from === null ? null : attachedTopTarget(target, id, kind, attachment, from, ownDelta, targetDelta);
        if (from === null || to === null) { unreadable.set(kind, [...(unreadable.get(kind) ?? []), id]); continue; }
        if (Math.abs(to - from) < 1e-9) continue;
        if (kind === 'wall') walls.push({ wallId: id, storeyId, targetStoreyId: attachment.targetStoreyId, from, to });
        else attached.push({ elementId: id, kind, storeyId, targetStoreyId: attachment.targetStoreyId, from, to });
      } else if (type === 'IFCSTAIR') {
        const refit = planStairRefit(inventory, id, storeyId, delta, refusals);
        if (refit === 'unreadable') unrefittable.push(id);
        else if (refit) stairs.push(refit);
      }
    }
  }

  // Heights a vertical element cannot take; a beam's turn is checked when it is written (the dry run).
  for (const change of [...walls.map((wall) => ({ ...wall, elementId: wall.wallId, kind: 'wall' as const })), ...attached]) {
    if (change.kind === 'linear' || change.to >= MIN_ATTACHED_EXTENT) continue;
    refusals.push({
      code: 'dependent', elementIds: [change.elementId],
      message: `${KIND_NAMES[change.kind]} #${change.elementId} would end ${describeLength(change.to)} tall: its top is attached to a level the edit brings down to its base`,
    });
  }
  const railings = planStairRailings(inventory, stairs, byStorey);
  for (const [kind, ids] of unreadable) {
    notices.push(kind === 'wall'
      ? { code: 'wallNotResized', elementIds: ids, message: `${ids.length} attached wall(s) are not simple extrusions, so they move but keep their height` }
      : { code: 'attachedNotResized', elementIds: ids, message: `${ids.length} attached ${KIND_NAMES[kind].toLowerCase()}(s) have a body or attachment this editor cannot follow, so they move but keep their height` });
  }
  // The overlay keeps one same-named quantity set per wall true; a second instance would keep old values.
  const partial = walls.filter((wall) => wallQuantitySetCount(inventory.store, inventory.view, wall.wallId) > 1).map((wall) => wall.wallId);
  if (partial.length) {
    notices.push({
      code: 'wallQuantitiesPartial', elementIds: partial,
      message: `${partial.length} resized wall(s) carry more than one Qto_WallBaseQuantities set; only the first is updated, the others keep their old values`,
    });
  }
  if (unresolved.length) {
    notices.push({
      code: 'wallAttachmentUnresolved', elementIds: unresolved.map(({ id }) => id),
      message: `${unresolved.length} element(s) record a top attachment that names nothing they can follow, so they keep their height: ${unresolved.map(({ id, problem }) => `#${id} ${problem}`).join('; ')}`,
    });
  }
  if (unrefittable.length) {
    notices.push({ code: 'stairNotRefit', elementIds: unrefittable, message: `${unrefittable.length} stair(s) may reach a moved storey but are not a single stepped flight this editor can rebuild; they move but are not refit` });
  }
  return { walls, attached, stairs, railings, refusals, notices };
}

/** Railings on each refit stair's storey that run up it. */
function planStairRailings(inventory: StoreyInventory, stairs: readonly StairRefit[], byStorey: ReadonlyMap<number, readonly number[]>): RailingRefit[] {
  const target = editTarget(inventory);
  return stairs.flatMap((stair) => {
    const dims = readStairDimensions(inventory.store, stair.stairId, inventory.view);
    if (!dims) return [];
    const railings = (byStorey.get(stair.storeyId) ?? []).filter((id) => inventory.reader.entity(id)?.type.toUpperCase() === 'IFCRAILING');
    const extent = { stairId: stair.stairId, run: dims.NumberOfRisers * dims.TreadLength, rise: dims.NumberOfRisers * dims.RiserHeight, width: dims.Width };
    return railings.length ? railingsOnStair(target, extent, railings) : [];
  });
}

/** A stair's landing and its refit, null when its rise is unaffected, or 'unreadable'. */
function planStairRefit(
  inventory: StoreyInventory, stairId: number, storeyId: number, delta: (id: number) => number, refusals: StoreyRefusal[],
): StairRefit | 'unreadable' | null {
  const storey = inventory.storeys.find((candidate) => candidate.expressId === storeyId)!;
  const dims = readStairDimensions(inventory.store, stairId, inventory.view);
  const generic = dims ? null : genericFlights(inventory, stairId);
  // The flights carry the steps and may sit above their stair's placement: measure from the lowest.
  const flightBases = (dims ? [dims.flightId] : generic?.flights ?? [])
    .map((flight) => heightAboveStorey(inventory, flight, storeyId)).filter((h): h is number => h !== null);
  const base = flightBases.length ? Math.min(...flightBases) : heightAboveStorey(inventory, stairId, storeyId);
  const rise = dims ? dims.NumberOfRisers * dims.RiserHeight : generic?.rise ?? null;
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
function genericFlights(inventory: StoreyInventory, stairId: number): { rise: number; flights: number[] } | null {
  for (const rel of inventory.outgoing.get(stairId) ?? []) {
    if (rel.type !== 'IFCRELAGGREGATES') continue;
    let rise = 0;
    const flights: number[] = [];
    for (const child of rel.children) {
      const flight = inventory.reader.entity(child);
      if (!flight || !getInheritanceChainAcrossSchemas(flight.type).includes('IfcStairFlight')) continue;
      flights.push(child);
      const at = (name: string) => flight.attributes[flight.names.indexOf(name)];
      const n = at(inventory.schema === 'IFC2X3' ? 'NumberOfRiser' : 'NumberOfRisers');
      const raw = at('RiserHeight');
      const r = typeof raw === 'number' ? raw : raw && typeof raw === 'object' && 'real' in raw ? (raw as { real: unknown }).real : null;
      if (typeof n !== 'number' || typeof r !== 'number') return null;
      rise += n * r * inventory.scale;
    }
    return rise > 0 ? { rise, flights } : null;
  }
  return null;
}

/**
 * An element a new storey binds (#9296): one drawn attached while no storey
 * stood above its own (`NextStoreyAbove`), which takes the height from its
 * base to the new floor, or one relatively bound to the storey above its own
 * ("home storey + 1") when the new storey is inserted between the two, which
 * re-binds to it and keeps its offset from the floor it follows.
 */
export interface StoreyBinding {
  readonly elementId: number;
  readonly kind: AttachedKind;
  readonly storeyId: number;
  /** The storey the element was bound to before, or null for an unbound one. */
  readonly previousTargetId: number | null;
  /** Metres, in the kind's `top` measure (`storey-attached.ts`). */
  readonly from: number;
  readonly to: number;
}

/**
 * The elements a new storey at `elevation` (metres) would bind or re-bind:
 * those on the storey directly below it. Explicit bindings ("Up to level:
 * X") stay where they are. Pure read.
 */
export function planAttachmentBindings(
  inventory: StoreyInventory, elevation: number, parentId: number | null,
): { walls: WallHeightChange[]; bindings: StoreyBinding[]; unreadable: number[] } {
  // Only storeys of the building the new storey joins.
  const storeys = inventory.storeys.filter((storey) => storey.parentId === parentId);
  const below = [...storeys].reverse().find((storey) => storey.elevation < elevation);
  if (!below) return { walls: [], bindings: [], unreadable: [] };
  const above = storeys.find((storey) => storey.elevation > below.elevation) ?? null;
  const target = editTarget(inventory);
  const floor = below.placementId === null ? null : placementInAncestor(inventory.reader, below.placementId, null);
  const floorWorld = floor ? floor.o[2] * inventory.scale : below.elevation;
  const bindings: StoreyBinding[] = [];
  const unreadable: number[] = [];
  // A read of the storey below; only its relatively attached elements are written.
  for (const id of storeyContents(inventory, below.expressId, Infinity)) {
    const kind = attachedKind(inventory.reader.entity(id)?.type);
    const attachment = kind ? readTopAttachment(inventory, id) : null;
    if (!kind || !attachment || attachment.kind !== 'storey' || attachment.binding !== 'relative') continue;
    if (attachment.targetStoreyId !== null && attachment.targetStoreyId !== above?.expressId) continue;
    const from = readAttachedTop(target, id, kind);
    const origin = from === null ? null : attachedTopWorldOrigin(target, id, kind);
    // An element whose body or placement cannot be read is still bound (its record names the new storey,
    // so later edits report it as not resized) but cannot be resized now.
    if (from === null) { unreadable.push(id); continue; }
    if (attachment.targetStoreyId !== null) {
      bindings.push({ elementId: id, kind, storeyId: below.expressId, previousTargetId: attachment.targetStoreyId, from, to: from + elevation - above!.elevation });
      continue;
    }
    if (origin === null || !Number.isFinite(origin)) { unreadable.push(id); continue; }
    // The top reaches the new floor: from + (new floor above this storey's) − (where the top is above it now).
    bindings.push({ elementId: id, kind, storeyId: below.expressId, previousTargetId: null, from, to: from + (elevation - below.elevation) - (origin + from - floorWorld) });
  }
  // targetStoreyId is filled in by the add, which knows the new storey's id.
  const walls = bindings.filter((binding) => binding.kind === 'wall')
    .map(({ elementId, storeyId, from, to }) => ({ wallId: elementId, storeyId, targetStoreyId: -1, from, to }));
  return { walls, bindings, unreadable };
}
