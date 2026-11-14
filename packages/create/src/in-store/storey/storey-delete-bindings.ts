/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { StoreEditor } from '@ifc-lite/mutations';
import type { StoreyRefusal } from './storey-validation.js';
import { placementInAncestor } from '../host-geometry-frame.js';
import type { EditTarget } from '../edit/target.js';
import { heightRefusal } from '../edit/hosted-opening-refit.js';
import { attachedKind, attachedTopWorldOrigin, levelTopFaceAbove, readAttachedTop, writeAttachedTop, MIN_ATTACHED_EXTENT, type AttachedKind } from './storey-attached.js';
import { NEXT_STOREY_ABOVE, readTopAttachment, writeTopAttachment } from './storey-attachment.js';
import { storeyContents, storeyNeighbour, type StoreyInventory } from './storey-model.js';
import type { StoreyDeleteMode } from './storey-delete.js';

export interface DeletionBinding {
  readonly elementId: number;
  readonly kind: AttachedKind;
  readonly targetStoreyId: number | null;
  readonly targetGlobalId: string;
  /** Change in the followed floor's world Z, metres; null when there is no floor above. */
  readonly floorDelta: number | null;
  /** Physical target floor for a previously pending relative top. */
  readonly targetWorldZ: number | null;
}

function floorZ(inventory: StoreyInventory, id: number): number {
  const storey = inventory.storeys.find(s => s.expressId === id)!;
  const frame = storey.placementId === null ? null : placementInAncestor(inventory.reader, storey.placementId, null);
  return frame ? frame.o[2] * inventory.scale : storey.elevation;
}

/** A relative target follows the sequence after deletion, including contents moved to a new home. */
export function planDeletionBindings(inventory: StoreyInventory, deleted: number, mode: StoreyDeleteMode): DeletionBinding[] {
  const remaining = { ...inventory, storeys: inventory.storeys.filter(s => s.expressId !== deleted) };
  const bindings: DeletionBinding[] = [], seen = new Set<number>();
  for (const home of inventory.storeys) {
    if (home.expressId === deleted && mode.kind !== 'move') continue;
    const homeId = home.expressId === deleted && mode.kind === 'move' ? mode.targetStoreyId : home.expressId;
    for (const id of storeyContents(inventory, home.expressId, Infinity)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const kind = attachedKind(inventory.reader.entity(id)?.type);
      const attachment = kind ? readTopAttachment(inventory, id) : null;
      if (!kind || attachment?.kind !== 'storey' || attachment.binding !== 'relative'
        || (attachment.targetStoreyId !== deleted && home.expressId !== deleted)) continue;
      const next = storeyNeighbour(remaining, homeId, 1);
      bindings.push({ elementId: id, kind, targetStoreyId: next?.expressId ?? null,
        targetGlobalId: next?.GlobalId ?? NEXT_STOREY_ABOVE, targetWorldZ: next ? floorZ(inventory, next.expressId) : null,
        floorDelta: next && attachment.targetStoreyId !== null
          ? floorZ(inventory, next.expressId) - floorZ(inventory, attachment.targetStoreyId) : null });
    }
  }
  return bindings;
}

/** Compute in the current parent frame; moving containment keeps the world position. */
function bindingTop(target: EditTarget, binding: DeletionBinding): { from: number; to: number } | null {
  const from = readAttachedTop(target, binding.elementId, binding.kind);
  if (from === null || binding.targetWorldZ === null) return null;
  if (binding.floorDelta !== null) return { from, to: from + binding.floorDelta };
  const origin = attachedTopWorldOrigin(target, binding.elementId, binding.kind);
  return origin === null || !Number.isFinite(origin) ? null
    : { from, to: binding.targetWorldZ - origin - levelTopFaceAbove(target, binding.elementId, binding.kind) };
}

/** Read-only checks shared with the top writer: vertical extent and hosted opening clearance. */
export function deletionBindingRefusals(inventory: StoreyInventory, bindings: readonly DeletionBinding[]): StoreyRefusal[] {
  if (!bindings.some(binding => binding.kind !== 'linear' && binding.targetWorldZ !== null)) return [];
  const target = { dataStore: inventory.store, view: inventory.view, editor: new StoreEditor(inventory.store, inventory.view) };
  return bindings.flatMap(binding => {
    if (binding.kind === 'linear') return [];
    const top = bindingTop(target, binding);
    if (!top) return [];
    let reason: string | null = null;
    if (top.to < MIN_ATTACHED_EXTENT) {
      reason = `it would end ${top.to.toFixed(3)} m tall: the next storey after deletion is not above its base`;
    } else if (binding.kind === 'wall' && Math.abs(top.to - top.from) > 1e-9) {
      reason = heightRefusal(target, binding.elementId, top.to / inventory.scale, inventory.scale);
    }
    return reason ? [{ code: 'dependent' as const, elementIds: [binding.elementId],
      message: `#${binding.elementId} cannot follow the next storey after deletion: ${reason}` }] : [];
  });
}

/** Run after reparenting, so a linear element's top is read in its current parent frame. */
export function applyDeletionBindings(target: EditTarget, bindings: readonly DeletionBinding[]): { remesh: number[]; unreadable: number[] } {
  const remesh: number[] = [], unreadable: number[] = [];
  for (const binding of bindings) {
    if (target.view.isDeleted(binding.elementId)) continue;
    writeTopAttachment(target.view, binding.elementId, binding.targetGlobalId, 'relative');
    if (binding.targetWorldZ === null || (binding.floorDelta !== null && Math.abs(binding.floorDelta) < 1e-9)) continue;
    const top = bindingTop(target, binding);
    if (top === null) { unreadable.push(binding.elementId); continue; }
    const outcome = writeAttachedTop(target, binding.elementId, binding.kind, top.from, top.to);
    if (!outcome.ok) throw new Error(`#${binding.elementId} cannot follow the next storey after deletion: ${outcome.reason}`);
    remesh.push(...outcome.remesh);
  }
  return { remesh, unreadable };
}
