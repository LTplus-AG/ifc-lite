/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One-to-many relationships where an object belongs to at most one relating
 * entity: IfcRelDefinesByType (one type per occurrence) and
 * IfcRelAssociatesMaterial (one material association per object). Both keep
 * `RelatedObjects` at slot 4 and the relating side at slot 5.
 *
 * Assigning moves each object: it leaves every other relationship of the same
 * class (a relationship it empties is removed), then joins the relating
 * entity's existing relationship, or a new one when there is none. Reading
 * the existing relationships is the resolver's job (`readRelatedLists`), so
 * this stays a pure write through the editor.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { ExistingRelatedList } from './cost.js';

const RELATED_SLOT = 4;

export interface OneToManyResult {
  /** The relationship the objects now belong to. */
  relId: number;
  /** True when `relId` was created by this call rather than extended. */
  created: boolean;
  /** Relationships the objects were moved out of (removed when emptied). */
  detachedRelIds: number[];
}

export interface OneToManySpec {
  relType: 'IfcRelDefinesByType' | 'IfcRelAssociatesMaterial';
  relatingId: number;
  relatedIds: readonly number[];
  existing: readonly ExistingRelatedList[];
  /** Full attribute list for a new relationship, given its RelatedObjects. */
  create: (related: string[]) => unknown[];
}

export function relateOneToManyInStore(editor: StoreEditor, spec: OneToManySpec, op: string): OneToManyResult {
  const ids = [...new Set(spec.relatedIds)];
  if (ids.length === 0) throw new Error(`${op}: pass at least one object id`);
  for (const id of [spec.relatingId, ...ids]) {
    if (!Number.isInteger(id) || id <= 0) throw new Error(`${op}: ${id} is not an entity id`);
  }
  if (ids.includes(spec.relatingId)) throw new Error(`${op}: #${spec.relatingId} cannot relate to itself`);

  const moving = new Set(ids);
  const target = spec.existing.find((rel) => rel.relatingId === spec.relatingId);
  const detachedRelIds: number[] = [];
  for (const rel of spec.existing) {
    if (rel === target || !rel.relatedIds.some((id) => moving.has(id))) continue;
    detachedRelIds.push(rel.relId);
    const remaining = rel.relatedIds.filter((id) => !moving.has(id));
    if (remaining.length === 0) editor.removeEntity(rel.relId);
    else editor.setPositionalAttribute(rel.relId, RELATED_SLOT, remaining.map((id) => `#${id}`));
  }

  if (target) {
    const merged = [...new Set([...target.relatedIds, ...ids])];
    if (merged.length !== target.relatedIds.length) {
      editor.setPositionalAttribute(target.relId, RELATED_SLOT, merged.map((id) => `#${id}`));
    }
    return { relId: target.relId, created: false, detachedRelIds };
  }
  const attrs = spec.create(ids.map((id) => `#${id}`));
  const relId = editor.addEntity(spec.relType, attrs as Parameters<StoreEditor['addEntity']>[1]).expressId;
  return { relId, created: true, detachedRelIds };
}
