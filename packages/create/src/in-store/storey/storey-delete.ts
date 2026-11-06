/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Delete a storey without orphaning anything (#9013). An empty storey goes
 * straight away; a storey that holds elements is deleted only with an
 * explicit choice for them: move them, keeping identity and world position,
 * to another storey (`reassignElementsToStoreyInStore`), or delete them too.
 *
 * The storey's IfcLocalPlacement is kept, so anything placed relative to it
 * still resolves; the relationships that list the storey are narrowed, and
 * those that only exist for it are removed.
 */

import { effectiveReferencers } from '@ifc-lite/export';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { refId } from '../host-geometry-frame.js';
import { planStoreyReassignment } from '../storey-reassignment-plan.js';
import { reassignElementsToStoreyInStore } from '../storey-reassignment.js';
import { countedElements, readStoreyInventory, ref, storeyContents, type StoreyInventory } from './storey-model.js';
import { StoreyEditRefusedError, type StoreyRefusal } from './storey-validation.js';

export type StoreyDeleteMode =
  | { readonly kind: 'empty' }
  | { readonly kind: 'move'; readonly targetStoreyId: number }
  | { readonly kind: 'deleteContents' };

export interface StoreyDeletePlan {
  readonly storeyId: number;
  readonly Name: string;
  readonly mode: StoreyDeleteMode;
  /** Everything the storey holds, openings and parts included. */
  readonly contents: readonly number[];
  /** The storey's direct children: what a move re-parents. */
  readonly roots: readonly number[];
  readonly elementCount: number;
  readonly refusals: readonly StoreyRefusal[];
}

/** reassignElementsToStoreyInStore takes at most this many roots per call. */
const REASSIGN_BATCH = 200;

function directChildren(inventory: StoreyInventory, storeyId: number): number[] {
  const storeyIds = new Set(inventory.storeys.map((storey) => storey.expressId));
  return [...new Set((inventory.outgoing.get(storeyId) ?? [])
    .filter((rel) => rel.type === 'IFCRELCONTAINEDINSPATIALSTRUCTURE' || rel.type === 'IFCRELAGGREGATES')
    .flatMap((rel) => rel.children)
    .filter((child) => !storeyIds.has(child)))];
}

export function planStoreyDelete(inventory: StoreyInventory, storeyId: number, mode: StoreyDeleteMode): StoreyDeletePlan {
  const storey = inventory.storeys.find((candidate) => candidate.expressId === storeyId);
  const base = { storeyId, mode, Name: storey?.Name ?? `#${storeyId}` };
  if (!storey) {
    return { ...base, contents: [], roots: [], elementCount: 0, refusals: [{ code: 'notFound', message: `#${storeyId} is not a live IfcBuildingStorey in this model` }] };
  }
  const contents = storeyContents(inventory, storeyId);
  const roots = directChildren(inventory, storeyId);
  const elementCount = countedElements(inventory, contents);
  const refusals: StoreyRefusal[] = [];
  if (inventory.storeys.length === 1) {
    refusals.push({ code: 'onlyStorey', message: `${storey.Name} is the model's only storey; add another before deleting it`, params: { storey: storey.Name } });
  }
  const subStoreys = (inventory.outgoing.get(storeyId) ?? []).flatMap((rel) => rel.children)
    .filter((child) => inventory.storeys.some((candidate) => candidate.expressId === child));
  if (subStoreys.length) {
    refusals.push({ code: 'dependent', elementIds: subStoreys, message: `${storey.Name} aggregates ${subStoreys.length} other storey(s); delete or move those first` });
  }
  if (mode.kind === 'empty' && contents.size > 0) {
    refusals.push({ code: 'notEmpty', elementIds: [...contents], message: `${storey.Name} holds ${elementCount} element(s): move them to another storey or delete them with it`, params: { storey: storey.Name, count: elementCount } });
  }
  if (mode.kind === 'move') {
    const target = inventory.storeys.find((candidate) => candidate.expressId === mode.targetStoreyId);
    if (!target || target.expressId === storeyId) {
      refusals.push({ code: 'invalidTarget', message: 'Choose another storey to move the elements to' });
    } else {
      for (let start = 0; start < roots.length; start += REASSIGN_BATCH) {
        try {
          planStoreyReassignment(inventory.store, inventory.view, roots.slice(start, start + REASSIGN_BATCH), storeyId, target.expressId);
        } catch (error) {
          refusals.push({ code: 'dependent', elementIds: roots.slice(start, start + REASSIGN_BATCH), message: error instanceof Error ? error.message : String(error) });
          break;
        }
      }
    }
  }
  return { ...base, contents: [...contents], roots, elementCount, refusals };
}

/** Delete atomically, or throw `StoreyEditRefusedError` having written nothing. */
export function applyStoreyDelete(store: IfcDataStore, editor: StoreEditor, storeyId: number, mode: StoreyDeleteMode): StoreyDeletePlan {
  return editor.runAtomic((draft) => {
    const plan = planStoreyDelete(readStoreyInventory(store, draft.getMutationView()), storeyId, mode);
    if (plan.refusals.length) throw new StoreyEditRefusedError(plan.refusals);
    if (mode.kind === 'move') {
      for (let start = 0; start < plan.roots.length; start += REASSIGN_BATCH) {
        reassignElementsToStoreyInStore(store, draft, plan.roots.slice(start, start + REASSIGN_BATCH), storeyId, mode.targetStoreyId);
      }
    }
    const removed = new Set<number>([storeyId]);
    if (mode.kind === 'deleteContents') for (const id of plan.contents) removed.add(id);
    detachRelationships(store, draft, removed);
    for (const id of removed) draft.removeEntity(id);
    return plan;
  });
}

/**
 * Narrow every relationship that lists a removed entity; remove one whose
 * single-valued end (RelatingStructure, RelatingObject, ...) is removed or
 * whose list empties. Non-relationship referencers are left to the exporter,
 * which already drops tombstoned references.
 */
function detachRelationships(store: IfcDataStore, draft: StoreEditor, removed: ReadonlySet<number>): void {
  const view = draft.getMutationView();
  const inventory = readStoreyInventory(store, view);
  const referencers = effectiveReferencers(store, view);
  const rels = new Set<number>();
  for (const id of removed) for (const parent of referencers(id)) rels.add(parent);
  for (const relId of rels) {
    if (removed.has(relId)) continue;
    const entity = inventory.reader.entity(relId);
    if (!entity || !entity.type.toUpperCase().startsWith('IFCREL')) continue;
    let drop = false;
    const edits: Array<[number, string[]]> = [];
    entity.attributes.forEach((value, index) => {
      if (index === 0) return;
      if (Array.isArray(value)) {
        const ids = value.map(refId);
        if (!ids.some((id) => id !== null && removed.has(id))) return;
        const kept = ids.filter((id): id is number => id !== null && !removed.has(id));
        if (kept.length === 0) drop = true; else edits.push([index, kept.map(ref)]);
      } else {
        const id = refId(value);
        if (id !== null && removed.has(id)) drop = true;
      }
    });
    if (drop) draft.removeEntity(relId);
    else for (const [index, value] of edits) draft.setPositionalAttribute(relId, index, value);
  }
}
