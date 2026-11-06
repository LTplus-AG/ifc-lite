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
import { boundedStoreyContents, countedElements, readStoreyInventory, ref, storeyTooLarge, type StoreyInventory } from './storey-model.js';
import { storeyStateFingerprint } from './storey-fingerprint.js';
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
  /** The reviewed state of the storey and its contents (records and placement chains); a later edit to any of them makes the plan stale. */
  readonly fingerprint: string;
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
    return { ...base, contents: [], roots: [], elementCount: 0, fingerprint: '', refusals: [{ code: 'notFound', message: `#${storeyId} is not a live IfcBuildingStorey in this model` }] };
  }
  const contents = boundedStoreyContents(inventory, storeyId);
  if (!contents) return { ...base, contents: [], roots: [], elementCount: 0, fingerprint: '', refusals: [storeyTooLarge(storey)] };
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
    const nested = [...new Set((inventory.outgoing.get(storeyId) ?? []).filter((rel) => rel.type === 'IFCRELNESTS').flatMap((rel) => rel.children))];
    const target = inventory.storeys.find((candidate) => candidate.expressId === mode.targetStoreyId);
    if (!target || target.expressId === storeyId) {
      refusals.push({ code: 'invalidTarget', message: 'Choose another storey to move the elements to' });
    } else if (nested.length) {
      // IfcRelNests children have no spatial owner to re-point: moving the
      // storey's other contents would leave them orphaned by the deletion.
      refusals.push({
        code: 'dependent', elementIds: nested,
        message: `${storey.Name} nests ${nested.length} product(s) through IfcRelNests, which cannot be moved to another storey; delete them with it or re-nest them first`,
      });
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
  return { ...base, contents: [...contents], roots, elementCount, fingerprint: storeyStateFingerprint(inventory.reader, [storeyId, ...contents]), refusals };
}

/**
 * What makes two deletion plans the same: the storey, the mode, exactly what
 * would be moved or deleted, and the state the storey and those products were reviewed in.
 * Contents added after the review, or a reviewed product edited or moved
 * since, change it, so a reviewed deletion never acts on them unseen.
 */
export function storeyDeletePlanSignature(plan: StoreyDeletePlan): string {
  return JSON.stringify({
    storeyId: plan.storeyId,
    mode: plan.mode.kind === 'move' ? ['move', plan.mode.targetStoreyId] : [plan.mode.kind],
    contents: [...plan.contents].sort((x, y) => x - y),
    roots: [...plan.roots].sort((x, y) => x - y),
    fingerprint: plan.fingerprint,
  });
}

/**
 * Delete atomically, or throw `StoreyEditRefusedError` having written nothing.
 * With `expected` (the plan a person reviewed), a model that has changed
 * since is refused rather than re-planned.
 */
export function applyStoreyDelete(
  store: IfcDataStore, editor: StoreEditor, storeyId: number, mode: StoreyDeleteMode, expected?: StoreyDeletePlan,
): StoreyDeletePlan {
  return editor.runAtomic((draft) => {
    const plan = planStoreyDelete(readStoreyInventory(store, draft.getMutationView()), storeyId, mode);
    // A reviewed plan is answered first: what changed since the review is the news, not what the change now blocks.
    if (expected && storeyDeletePlanSignature(plan) !== storeyDeletePlanSignature(expected)) {
      throw new StoreyEditRefusedError([{ code: 'stale', message: 'The storey deletion was planned against a model that has changed since; review it again' }]);
    }
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
