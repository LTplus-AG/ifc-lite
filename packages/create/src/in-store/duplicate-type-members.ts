/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { EntityExtractor } from '@ifc-lite/parser';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SourceAssociation } from './duplicate.js';

/** Validate the caller-owned fallback before any duplicate records are written. */
export function validateTypeMembers(editor: StoreEditor, association: SourceAssociation): void {
  if (association.relId === undefined || association.relType.toUpperCase() !== 'IFCRELDEFINESBYTYPE') return;
  const fail = () => new Error('duplicateInStore: relatedIds must contain the complete readable IfcRelDefinesByType RelatedObjects list');
  if (!association.relatedIds?.length) throw fail();
  const view = editor.getMutationView(), id = association.relId;
  if (view.isDeleted(id)) throw fail();
  const edits = view.getPositionalMutationsForEntity(id);
  const created = view.getNewEntity(id);
  // The writer reads an existing overlay list itself, including earlier copies.
  // A stale collected snapshot must not erase those in-session extensions.
  if (edits?.has(4) || created) {
    const live = edits?.has(4) ? edits.get(4) : created?.attributes[4];
    if (!Array.isArray(live)) throw fail();
    return;
  }
  // A parsed relationship has no overlay list yet. Never trust a nonempty
  // caller list as evidence that all its existing members were collected.
  const data = editor.getSourceEntityData(id);
  const entity = data ? new EntityExtractor(data.source).extractEntity(data.ref) : null;
  if (entity?.type.toUpperCase() !== 'IFCRELDEFINESBYTYPE' || !Array.isArray(entity.attributes[4])) throw fail();
  const expected = entity.attributes[4].map(value => typeof value === 'number' ? value
    : typeof value === 'string' && /^#[1-9][0-9]*$/.test(value) ? Number(value.slice(1)) : null);
  const supplied = new Set(association.relatedIds);
  if (expected.length !== association.relatedIds.length || supplied.size !== expected.length
    || expected.some(value => value === null || !Number.isInteger(value) || value <= 0 || !supplied.has(value))) throw fail();
}
