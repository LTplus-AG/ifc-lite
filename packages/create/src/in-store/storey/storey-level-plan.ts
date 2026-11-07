/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Plan a storey re-level (#9013): an elevation edit moves one storey, a
 * floor-to-floor edit moves every storey above by the same delta. Geometry
 * follows: everything a moved storey holds moves with it, and nothing else
 * moves.
 *
 * The plan is a placement tree problem. Each affected product has an INTENT,
 * the world-Z delta it must end up with: its storey's delta for contents of
 * a moved storey, zero for everything else that hangs from a moved
 * placement. Walking placements parents-first, each placement is written
 * with `intent − inherited`, where `inherited` is what its moved ancestors
 * already carry. So:
 *
 * - contents hanging from the storey placement (everything the viewer
 *   authors) need no write of their own;
 * - contents placed relative to the building or the world, common in
 *   third-party files, get their own root placement lifted;
 * - a product of another storey that hangs from a moved placement is
 *   compensated, so it stays where it is;
 * - a placement two products share with different intents is refused.
 *
 * Every write is a fresh point and axis placement (`storey-placement.ts`).
 */

import { effectiveReferencers } from '@ifc-lite/export';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import { walkPlacementChain } from '@ifc-lite/data';
import { refId, type Vec3 } from '../host-geometry-frame.js';
import {
  countedElements, crossStoreyRefusal, siblingStoreys, walkStoreyContents, storeyNeighbour, storeyRecord, storeyTooLarge,
  type StoreyInventory, type StoreyRecord,
} from './storey-model.js';
import { storeyStateFingerprint } from './storey-fingerprint.js';
import { gridPlacementParent, gridPlacementsOn } from './storey-grid.js';
import { readPlacementLeaf, worldLiftInParent, type PlacementLeaf } from './storey-placement.js';
import {
  MIN_STOREY_SPACING, describeElevation, describeLength, type StoreyNotice, type StoreyRefusal,
} from './storey-validation.js';

export type StoreyLevelEdit =
  /** Move this storey to `Elevation` metres; storeys above stay where they are. */
  | { readonly kind: 'elevation'; readonly storeyId: number; readonly Elevation: number }
  /** Make this storey's floor-to-floor height `Height` metres; every storey above shifts. */
  | { readonly kind: 'floorHeight'; readonly storeyId: number; readonly Height: number };

export interface StoreyMove {
  readonly expressId: number;
  readonly Name: string;
  /** Metres. */
  readonly from: number;
  readonly to: number;
  /** IfcBuildingStorey.Elevation to write, file units. */
  readonly elevationAttribute: number;
}

export interface PlacementWrite {
  readonly leaf: PlacementLeaf;
  /** Offset in the parent's frame, file units. */
  readonly offset: Vec3;
  /** The products whose ObjectPlacement this is. */
  readonly owners: readonly number[];
}

/** A changed floor-to-floor gap, metres. Dependent elements (walls, stairs) read these. */
export interface SpacingChange {
  readonly lowerId: number;
  readonly upperId: number;
  readonly from: number;
  readonly to: number;
}

export interface StoreyLevelPlan {
  readonly edit: StoreyLevelEdit;
  readonly storeys: readonly StoreyMove[];
  readonly placements: readonly PlacementWrite[];
  /** Every product whose world position changes (for re-meshing), storeys excluded. */
  readonly moved: readonly number[];
  /** Products another storey owns that hang from a moved placement and are held in place. */
  readonly held: readonly number[];
  readonly spacing: readonly SpacingChange[];
  /** Elements a person counts as moving: openings and aggregated parts excluded. */
  readonly movedElementCount: number;
  readonly refusals: readonly StoreyRefusal[];
  readonly notices: readonly StoreyNotice[];
  /**
   * The reviewed state of what the writes start from: the moved storeys and
   * every written placement's chain (points, axes, directions). An edit to
   * any of them after review makes the plan stale.
   */
  readonly fingerprint: string;
}

const EPS = 1e-9;

function emptyPlan(edit: StoreyLevelEdit, refusals: StoreyRefusal[]): StoreyLevelPlan {
  return { edit, storeys: [], placements: [], moved: [], held: [], spacing: [], movedElementCount: 0, refusals, notices: [], fingerprint: '' };
}

/** Neighbour checks for one storey landing at `target` metres. */
function neighbourRefusals(storey: StoreyRecord, target: number, below: StoreyRecord | null, above: StoreyRecord | null): StoreyRefusal[] {
  const refusals: StoreyRefusal[] = [];
  const check = (neighbour: StoreyRecord | null, gap: number, side: 'below' | 'above') => {
    if (!neighbour || gap >= MIN_STOREY_SPACING) return;
    const crossing = gap <= -MIN_STOREY_SPACING;
    refusals.push({
      code: crossing ? 'crossing' : 'spacing',
      message: crossing
        ? `${storey.Name} at ${describeElevation(target)} would pass ${neighbour.Name} (${describeElevation(neighbour.elevation)}) ${side} it`
        : `${storey.Name} at ${describeElevation(target)} would leave no height between it and ${neighbour.Name}`,
      params: { storey: storey.Name, neighbour: neighbour.Name, elevation: target, neighbourElevation: neighbour.elevation, side },
    });
  };
  check(below, below ? target - below.elevation : 0, 'below');
  check(above, above ? above.elevation - target : 0, 'above');
  return refusals;
}

/** The storey deltas (metres) an edit asks for, or the refusals that stop it. */
function storeyDeltas(inventory: StoreyInventory, edit: StoreyLevelEdit): Map<number, number> | StoreyRefusal[] {
  const storey = inventory.storeys.find((candidate) => candidate.expressId === edit.storeyId);
  if (!storey) return [{ code: 'notFound', message: `#${edit.storeyId} is not a live IfcBuildingStorey in this model` }];
  const below = storeyNeighbour(inventory, storey.expressId, -1);
  const above = storeyNeighbour(inventory, storey.expressId, 1);
  if (edit.kind === 'elevation') {
    if (!Number.isFinite(edit.Elevation)) return [{ code: 'invalidValue', message: 'Enter an elevation in metres' }];
    const refusals = neighbourRefusals(storey, edit.Elevation, below, above);
    return refusals.length ? refusals : new Map([[storey.expressId, edit.Elevation - storey.elevation]]);
  }
  if (storey.parentId === null) {
    return [{
      code: 'dependent', elementIds: [storey.expressId],
      message: `${storey.Name} is not aggregated under a building, so there is no sequence of storeys above it to shift; edit its elevation instead`,
      params: { storey: storey.Name },
    }];
  }
  if (!above) {
    return [{ code: 'topStorey', message: `${storey.Name} is the top storey: there is no storey above to measure its height to`, params: { storey: storey.Name } }];
  }
  if (!Number.isFinite(edit.Height)) return [{ code: 'invalidValue', message: 'Enter a height in metres' }];
  if (edit.Height < MIN_STOREY_SPACING) {
    return [{
      code: 'spacing',
      message: `A floor-to-floor height of ${describeLength(edit.Height)} would leave no height between ${storey.Name} and ${above.Name}`,
      params: { storey: storey.Name, neighbour: above.Name, height: edit.Height },
    }];
  }
  const delta = edit.Height - (above.elevation - storey.elevation);
  // Every storey above in the same building; another building's storeys stay.
  const siblings = siblingStoreys(inventory, storey.expressId);
  return new Map(siblings.slice(siblings.indexOf(storey) + 1).map((moved) => [moved.expressId, delta]));
}

function isProduct(inventory: StoreyInventory, id: number): boolean {
  const type = inventory.reader.entity(id)?.type;
  return !!type && getInheritanceChainAcrossSchemas(type).includes('IfcProduct');
}

export function planStoreyLevelEdit(inventory: StoreyInventory, edit: StoreyLevelEdit): StoreyLevelPlan {
  const deltas = storeyDeltas(inventory, edit);
  if (Array.isArray(deltas)) return emptyPlan(edit, deltas);
  if ([...deltas.values()].every((delta) => Math.abs(delta) < EPS)) return emptyPlan(edit, []);

  const { reader, scale } = inventory;
  const refusals: StoreyRefusal[] = [];
  /** World-Z delta each product must end with, file units. */
  const intent = new Map<number, number>();
  const contents = new Map<number, Set<number>>();
  for (const [storeyId, delta] of deltas) {
    const native = delta / scale;
    intent.set(storeyId, native);
    const walked = walkStoreyContents(inventory, storeyId);
    if (!walked) return emptyPlan(edit, [storeyTooLarge(storeyRecord(inventory, storeyId))]);
    const held = walked.contents;
    // A product another storey contains, hosted here, comes apart unless its storey moves by as much.
    const apart = new Map([...walked.foreign].filter(([, own]) => Math.abs((deltas.get(own) ?? 0) - delta) > EPS));
    const split = crossStoreyRefusal(inventory, storeyRecord(inventory, storeyId), apart);
    if (split) refusals.push(split);
    contents.set(storeyId, held);
    for (const id of held) if (!intent.has(id)) intent.set(id, native);
  }

  const referencers = effectiveReferencers(inventory.store, inventory.view);
  const placementOf = (product: number): number | null => refId(reader.entity(product)?.attributes[5]);
  // A grid placement follows its grid's placement, so grid-bound products inherit the grid's move.
  const parentOf = (placement: number): number | null => {
    const type = reader.entity(placement)?.type.toUpperCase();
    if (type === 'IFCLOCALPLACEMENT') return refId(reader.entity(placement)?.attributes[0]);
    return type === 'IFCGRIDPLACEMENT' ? gridPlacementParent(reader, referencers, placement) : null;
  };
  const chainOf = (placement: number): readonly number[] => walkPlacementChain(placement, parentOf).ids;

  const nodeIntent = new Map<number, number>();
  const owners = new Map<number, number[]>();
  const conflicts = new Set<number>();
  const unplaced: number[] = [];
  const claim = (product: number) => {
    const target = intent.get(product)!;
    const placement = placementOf(product);
    if (placement === null) {
      const representation = reader.entity(product)?.attributes[6];
      if (Math.abs(target) > EPS && representation !== null && representation !== undefined) unplaced.push(product);
      return;
    }
    owners.set(placement, [...(owners.get(placement) ?? []), product]);
    const previous = nodeIntent.get(placement);
    if (previous !== undefined && Math.abs(previous - target) > EPS) conflicts.add(placement);
    nodeIntent.set(placement, previous ?? target);
  };
  for (const product of intent.keys()) claim(product);

  const written = new Map<number, number>();
  const solve = () => {
    written.clear();
    const order = [...nodeIntent.keys()].map((id) => ({ id, chain: chainOf(id) })).sort((a, b) => a.chain.length - b.chain.length);
    for (const { id, chain } of order) {
      let inherited = 0;
      for (const ancestor of chain.slice(1)) inherited += written.get(ancestor) ?? 0;
      const own = nodeIntent.get(id)! - inherited;
      if (Math.abs(own) > EPS) written.set(id, own);
    }
  };
  // Compensating a newly reached product can only add writes below it, so a
  // few rounds settle any real file; the bound keeps a pathological one finite.
  for (let round = 0; round < 8; round++) {
    solve();
    const reached = reachedProducts(inventory, [...written.keys()], referencers);
    const fresh = reached.filter((product) => !intent.has(product));
    if (fresh.length === 0) break;
    for (const product of fresh) { intent.set(product, 0); claim(product); }
  }

  if (unplaced.length) {
    refusals.push({ code: 'unplaced', elementIds: unplaced, message: `${unplaced.length} element(s) have geometry but no placement, so they cannot move with the storey` });
  }
  if (conflicts.size) {
    const shared = [...conflicts].flatMap((placement) => owners.get(placement) ?? []);
    refusals.push({ code: 'sharedPlacement', elementIds: shared, message: `${shared.length} element(s) share one placement with elements on another storey, so moving one would move the other` });
  }

  const placements: PlacementWrite[] = [];
  const unreadable: number[] = [];
  for (const [placementId, delta] of written) {
    const leaf = readPlacementLeaf(reader, placementId);
    const offset = leaf ? worldLiftInParent(reader, leaf.parentId, delta) : null;
    if (!leaf || !offset) { unreadable.push(...(owners.get(placementId) ?? [placementId])); continue; }
    placements.push({ leaf, offset, owners: owners.get(placementId) ?? [] });
  }
  if (unreadable.length) {
    refusals.push({ code: 'unreadablePlacement', elementIds: unreadable, message: `${unreadable.length} element(s) have a placement that cannot be read, so they cannot be moved safely` });
  }

  const storeys: StoreyMove[] = [...deltas].map(([storeyId, delta]) => {
    const record = storeyRecord(inventory, storeyId);
    const base = record.elevationAttribute ?? record.elevation / scale;
    return { expressId: storeyId, Name: record.Name, from: record.elevation, to: record.elevation + delta, elevationAttribute: base + delta / scale };
  });
  const storeyIds = new Set(inventory.storeys.map((storey) => storey.expressId));
  const moved = [...intent].filter(([id, delta]) => Math.abs(delta) > EPS && !storeyIds.has(id)).map(([id]) => id);
  const held = [...intent].filter(([id, delta]) => Math.abs(delta) <= EPS && !storeyIds.has(id)).map(([id]) => id);
  let movedElementCount = 0;
  for (const set of contents.values()) movedElementCount += countedElements(inventory, set);

  return {
    edit, storeys, placements, moved, held, spacing: spacingChanges(inventory, deltas), movedElementCount,
    refusals, notices: [],
    fingerprint: storeyStateFingerprint(reader, referencers, [...deltas.keys()], placements.map(({ leaf }) => leaf.placementId)),
  };
}

/** Products whose placement chain passes through one of `placements`. */
function reachedProducts(
  inventory: StoreyInventory, placements: readonly number[], referencers: (id: number) => readonly number[],
): number[] {
  const products = new Set<number>();
  const visited = new Set<number>();
  const queue = [...placements];
  while (queue.length) {
    const id = queue.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    for (const parent of referencers(id)) {
      const type = inventory.reader.entity(parent)?.type.toUpperCase();
      if (type === 'IFCLOCALPLACEMENT' || type === 'IFCGRIDPLACEMENT') {
        // Only the placement a child follows makes it a child; RelativePlacement is an axis, never a placement.
        const follows = type === 'IFCLOCALPLACEMENT'
          ? refId(inventory.reader.entity(parent)?.attributes[0])
          : gridPlacementParent(inventory.reader, referencers, parent);
        if (follows === id) queue.push(parent);
      } else if (isProduct(inventory, parent) && refId(inventory.reader.entity(parent)?.attributes[5]) === id) {
        products.add(parent);
        // What is bound to a grid's axes follows the grid's placement.
        if (type === 'IFCGRID') queue.push(...gridPlacementsOn(inventory.reader, referencers, parent));
      }
    }
  }
  return [...products];
}

function spacingChanges(inventory: StoreyInventory, deltas: ReadonlyMap<number, number>): SpacingChange[] {
  const changes: SpacingChange[] = [];
  const at = (storey: StoreyRecord) => storey.elevation + (deltas.get(storey.expressId) ?? 0);
  // Only storeys of one building form a sequence; unaggregated ones have no gaps.
  const parents = new Set(inventory.storeys.map((storey) => storey.parentId).filter((id) => id !== null));
  for (const parentId of parents) {
    // Gaps are measured between consecutive storeys of one building.
    const storeys = inventory.storeys.filter((storey) => storey.parentId === parentId);
    for (let i = 0; i + 1 < storeys.length; i++) {
      const lower = storeys[i], upper = storeys[i + 1];
      const from = upper.elevation - lower.elevation, to = at(upper) - at(lower);
      if (Math.abs(to - from) > EPS) changes.push({ lowerId: lower.expressId, upperId: upper.expressId, from, to });
    }
  }
  return changes;
}
