/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from './columnar-parser.js';
import { resolveRelationshipRecord, type EffectiveRelationship, type EffectiveRelationshipOverlay, type RelationshipOverlayReader } from './effective-relationship-overlay.js';
import { createSchemaEntityNameSnapshot } from './schema-entity-name.js';
import { getSchemaRegistryForVersion } from './generated/schema-registry-by-version.js';

interface View { getMutationRevision?(): number }
interface Memo {
  revision: number;
  source: IfcDataStore['source'];
  snapshot: ReturnType<typeof createSchemaEntityNameSnapshot>;
  rows: Map<number, EffectiveRelationship | null>;
  created: EffectiveRelationship[];
  createdIds: Set<number>;
}
const memos = new WeakMap<IfcDataStore, WeakMap<View, Memo>>();
const memberships = new WeakMap<EffectiveRelationship, Set<number>>();

/** Decode a relationship once per revision, even when many subjects share it.
 * The schema snapshot and authored rows also belong to the revision, not to a selection. */
export function selectionRelationshipOverlay(store: IfcDataStore, view: View, reader: RelationshipOverlayReader): EffectiveRelationshipOverlay {
  const revision = view.getMutationRevision?.();
  let models = memos.get(store);
  if (!models) { models = new WeakMap(); memos.set(store, models); }
  let memo = models.get(view);
  if (revision === undefined || memo?.revision !== revision || memo.source !== store.source) {
    const snapshot = createSchemaEntityNameSnapshot(getSchemaRegistryForVersion(store.schemaVersion === 'IFC2X3' ? 'IFC2X3' : store.schemaVersion === 'IFC4X3' || store.schemaVersion === 'IFC5' ? 'IFC4X3' : 'IFC4'));
    const created: EffectiveRelationship[] = [], createdIds = new Set<number>();
    for (const entity of reader.createdEntities()) {
      createdIds.add(entity.expressId);
      const row = resolveRelationshipRecord(store, entity, reader, snapshot);
      if (row) created.push(row);
    }
    memo = { revision: revision ?? -1, source: store.source, snapshot, rows: new Map(), created, createdIds };
    if (revision !== undefined) models.set(view, memo);
  }
  const relationships = [...memo.created], supersededSourceIds = new Set<number>();
  for (const id of new Set(reader.mutatedEntityIds())) {
    if (memo.createdIds.has(id)) continue;
    let row = memo.rows.get(id);
    if (row === undefined && !memo.rows.has(id)) {
      const entity = store.getEntity(id);
      row = entity ? resolveRelationshipRecord(store, entity, reader, memo.snapshot) : null;
      memo.rows.set(id, row);
    }
    supersededSourceIds.add(id);
    if (row) relationships.push(row);
  }
  return { relationships, supersededSourceIds };
}

/** A shared row can name thousands of siblings. Build its membership set once. */
export function selectedRelationshipMembers(row: EffectiveRelationship, subject: number | undefined, full: boolean): readonly number[] {
  if (full || subject === undefined) return row.related;
  let members = memberships.get(row);
  if (!members) { members = new Set(row.related); memberships.set(row, members); }
  return members.has(subject) ? [subject] : [];
}
