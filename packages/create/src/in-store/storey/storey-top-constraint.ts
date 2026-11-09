/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Set what an element's top is attached to, and fit it there now (#9296):
 * the one write behind `bim.store.setTopConstraint` and the inspector's top
 * field, for walls, columns, beams, members and curtain walls.
 *
 * - `storeyAbove`: relative ("home storey + 1"); the top reaches the next
 *   storey above the element's own, or, with none yet, is recorded
 *   `NextStoreyAbove` and keeps its height until one is added;
 * - `storey`: explicit ("Up to level: X"); the top reaches that storey,
 *   which must be above the element's own;
 * - `slab`: the top reaches the slab's underside;
 * - `fixed`: no attachment; the height stays as it is.
 *
 * `topConstraintForNewElement` is the authoring default of `bim.store`'s
 * builders: an element drawn so its top lands on the storey above (within
 * 1 mm) is drawn attached to it, as the Model workspace's "To storey above"
 * draws it. Anything else is fixed unless the caller asks.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { placementInAncestor, refId } from '../host-geometry-frame.js';
import { getModelLengthUnitScale } from '../edit/length-unit-scale.js';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { effectiveStoreyElevation } from '../room-storey-elevation.js';
import { attachedKind, attachedTopWorldOrigin, levelTopFaceAbove, readAttachedTop, writeAttachedTop, MIN_ATTACHED_EXTENT } from './storey-attached.js';
import { clearTopAttachment, homeStoreyOf, writeTopAttachment, NEXT_STOREY_ABOVE } from './storey-attachment.js';
import { slabUndersideWorld } from './storey-attachment-target.js';
import { scaleWallQuantities, wallGeometry } from './storey-level-write.js';
import { readStoreyInventory, storeyNeighbour, type StoreyInventory, type StoreyRecord } from './storey-model.js';

export type TopConstraint =
  | { readonly kind: 'storeyAbove' }
  | { readonly kind: 'storey'; readonly storeyId: number }
  | { readonly kind: 'slab'; readonly slabId: number }
  | { readonly kind: 'fixed' };

/** An element's top lands on a storey when the two agree to this, metres. */
const LANDS = 0.001;
const SLAB_TYPES = new Set(['IFCSLAB', 'IFCSLABSTANDARDCASE', 'IFCSLABELEMENTEDCASE']);

function floorWorld(inventory: StoreyInventory, storey: StoreyRecord): number {
  const frame = storey.placementId === null ? null : placementInAncestor(inventory.reader, storey.placementId, null);
  return frame ? frame.o[2] * inventory.scale : storey.elevation;
}

/** World Z of the element's top, metres, or null when its body or placement cannot be read. */
function topWorld(inventory: StoreyInventory, editor: StoreEditor, elementId: number): { from: number; world: number } | null {
  const kind = attachedKind(inventory.reader.entity(elementId)?.type);
  if (!kind) return null;
  const target = { dataStore: inventory.store, view: inventory.view, editor };
  const from = readAttachedTop(target, elementId, kind);
  const origin = attachedTopWorldOrigin(target, elementId, kind);
  return from === null || origin === null || !Number.isFinite(origin) ? null : { from, world: origin + from };
}

/** Set an element's top constraint and fit it, atomically. Throws (writing nothing) with the reason it cannot. */
export function setTopConstraintInStore(store: IfcDataStore, editor: StoreEditor, elementId: number, constraint: TopConstraint): { remesh: number[] } {
  return editor.runAtomic((draft) => {
    const view = draft.getMutationView();
    const inventory = readStoreyInventory(store, view);
    const kind = attachedKind(inventory.reader.entity(elementId)?.type);
    if (!kind) throw new Error(`#${elementId} is not a wall, column, beam, member or curtain wall, so its top cannot be attached`);
    if (constraint.kind === 'fixed') {
      clearTopAttachment(view, elementId);
      return { remesh: [] };
    }
    const homeId = homeStoreyOf(inventory, elementId);
    const home = inventory.storeys.find((storey) => storey.expressId === homeId);
    if (!home) throw new Error(`#${elementId} is on no storey, so its top cannot follow one`);
    let reach: number;
    if (constraint.kind === 'slab') {
      const type = inventory.reader.entity(constraint.slabId)?.type.toUpperCase();
      if (!type || !SLAB_TYPES.has(type)) throw new Error(`#${constraint.slabId} is not a slab`);
      if (homeStoreyOf(inventory, constraint.slabId) === null) throw new Error(`The slab #${constraint.slabId} is on no storey, so it cannot be followed`);
      const underside = slabUndersideWorld({ dataStore: store, view, editor: draft }, constraint.slabId);
      if (underside === null) throw new Error(`The slab #${constraint.slabId} is not a flat extrusion, so its underside cannot be read`);
      writeTopAttachment(view, elementId, String(inventory.reader.entity(constraint.slabId)?.attributes[0]), 'explicit');
      reach = underside;
    } else {
      const storey = constraint.kind === 'storeyAbove'
        ? storeyNeighbour(inventory, home.expressId, 1)
        : inventory.storeys.find((candidate) => candidate.expressId === constraint.storeyId);
      if (constraint.kind === 'storey' && (!storey || storey.parentId !== home.parentId || storey.elevation <= home.elevation)) {
        throw new Error(`#${constraint.storeyId} is not a storey above ${home.Name}`);
      }
      if (!storey) {
        writeTopAttachment(view, elementId, NEXT_STOREY_ABOVE, 'relative');
        return { remesh: [] };
      }
      writeTopAttachment(view, elementId, storey.GlobalId, constraint.kind === 'storeyAbove' ? 'relative' : 'explicit');
      // Storey floors in world Z: the target's floor frame where it has one.
      reach = floorWorld(inventory, storey);
    }
    const top = topWorld(inventory, draft, elementId);
    if (!top) throw new Error(`#${elementId} has a body this editor cannot resize, so its top cannot be fitted`);
    const to = top.from + reach - top.world;
    if (kind !== 'linear' && to < MIN_ATTACHED_EXTENT) throw new Error(`#${elementId} would end ${to.toFixed(3)} m tall: what it is attached to is not above its base`);
    if (Math.abs(to - top.from) < 1e-9) return { remesh: [] };
    const target = { dataStore: store, view, editor: draft };
    const geometry = kind === 'wall' ? wallGeometry(store, view, draft, elementId) : undefined;
    const outcome = writeAttachedTop(target, elementId, kind, top.from, to);
    if (!outcome.ok) throw new Error(`#${elementId} cannot reach what it is attached to: ${outcome.reason}`);
    if (kind === 'wall') scaleWallQuantities(store, view, elementId, to / top.from, geometry);
    return { remesh: outcome.remesh };
  });
}

/**
 * The storey directly above `storeyId` in its building, read from the
 * storeys and their aggregation alone: the authoring default runs once per
 * drawn element, so it must not read the whole model's relationships.
 */
function storeyAboveOf(store: IfcDataStore, draft: StoreEditor, storeyId: number): { GlobalId: string; floor: number } | null {
  const view = draft.getMutationView();
  const reader = new AnchorEntityReader(store, view);
  const storeys = new Set(reader.ids('IFCBUILDINGSTOREY'));
  const parentOf = new Map<number, number>();
  for (const relId of reader.ids('IFCRELAGGREGATES')) {
    const rel = reader.entity(relId);
    const parent = rel ? refId(rel.attributes[4]) : null;
    const children = Array.isArray(rel?.attributes[5]) ? rel!.attributes[5] as unknown[] : [];
    if (parent === null) continue;
    for (const child of children) { const id = refId(child); if (id !== null && storeys.has(id)) parentOf.set(id, parent); }
  }
  const parent = parentOf.get(storeyId);
  if (parent === undefined) return null;
  const own = effectiveStoreyElevation(store, view, storeyId);
  let best: { id: number; elevation: number } | null = null;
  for (const id of storeys) {
    if (id === storeyId || parentOf.get(id) !== parent) continue;
    const elevation = effectiveStoreyElevation(store, view, id);
    if (elevation > own && (!best || elevation < best.elevation || (elevation === best.elevation && id < best.id))) best = { id, elevation };
  }
  if (!best) return null;
  const guid = reader.entity(best.id)?.attributes[0];
  const placement = reader.storeyPlacementId(best.id);
  const frame = placement === null ? null : placementInAncestor(reader, placement, null);
  return typeof guid === 'string' ? { GlobalId: guid, floor: frame ? frame.o[2] * safeScale(store) : best.elevation } : null;
}

const safeScale = (store: IfcDataStore) => {
  const scale = getModelLengthUnitScale(store);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
};

/**
 * Record the authoring default on an element just drawn on `storeyId`
 * (inside the caller's transaction): `auto` attaches it relatively when its
 * top lands on the storey above; an explicit constraint is applied as given.
 * Returns the products to re-mesh.
 */
export function applyNewElementTop(
  store: IfcDataStore, draft: StoreEditor, elementId: number, constraint: TopConstraint | 'auto', storeyId: number,
): number[] {
  if (constraint !== 'auto') return constraint.kind === 'fixed' ? [] : setTopConstraintInStore(store, draft, elementId, constraint).remesh;
  const kind = attachedKind(draft.getEntityType(elementId));
  const above = kind ? storeyAboveOf(store, draft, storeyId) : null;
  if (!kind || !above) return [];
  const target = { dataStore: store, view: draft.getMutationView(), editor: draft };
  const from = readAttachedTop(target, elementId, kind);
  const origin = from === null ? null : attachedTopWorldOrigin(target, elementId, kind);
  // A level beam reaches the floor above with its top face, and is lifted whole to stay there.
  if (from !== null && origin !== null && Math.abs(origin + from + levelTopFaceAbove(target, elementId, kind) - above.floor) <= LANDS) {
    writeTopAttachment(draft.getMutationView(), elementId, above.GlobalId, 'relative');
  }
  return [];
}
