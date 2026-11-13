/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { IfcDataStore } from './columnar-parser.js';
import { selectionRelationshipOverlay } from './selection-relationship-overlay.js';

export interface SelectionEditView {
  getMutationRevision?(): number;
  getAttributeOverrideEntityIds?(): number[];
  getEffectiveChanges?(): ReadonlyArray<{ entityId: number; kind: string }>;
  getTypeMutations?(): ReadonlyMap<number, { newType: string }>;
  getNewEntity?(id: number): { readonly type: string } | null;
  getNewEntities?(): ReadonlyArray<{ readonly expressId: number; readonly type: string; readonly attributes?: readonly unknown[] }>;
  getAttributeMutationsForEntity?(id: number): ReadonlyArray<{ name: string; value: string }>;
  getPositionalMutationsForEntity?(id: number): ReadonlyMap<number, unknown> | null;
  isDeleted?(id: number): boolean;
}
interface Edits {
  revision: number | undefined;
  source: IfcDataStore['source'];
  ids: Set<number>;
  subjects?: Map<number, Map<string, Set<number>>>;
}
const models = new WeakMap<IfcDataStore, WeakMap<SelectionEditView, Edits>>();

function editsFor(store: IfcDataStore, view: SelectionEditView): Edits {
  let views = models.get(store);
  if (!views) { views = new WeakMap(); models.set(store, views); }
  const revision = view.getMutationRevision?.(), old = views.get(view);
  if (revision !== undefined && old?.revision === revision && old.source === store.source) return old;
  // Never derive property/quantity changes merely to find relationship edits.
  const candidates = view.getAttributeOverrideEntityIds?.() ?? view.getEffectiveChanges?.()
    .filter(row => ['attribute', 'type', 'entity-deleted'].includes(row.kind)).map(row => row.entityId) ?? [];
  const ids = new Set<number>();
  for (const id of new Set([...candidates, ...(view.getTypeMutations?.().keys() ?? [])])) {
    // @raw-entity-enumeration-ok classify one edited record without reading its source attributes
    const source = (store.entityIndex.byId.get(id) ?? store.deferredEntityIndex?.get(id))?.type;
    const effective = view.getTypeMutations?.().get(id)?.newType ?? view.getNewEntity?.(id)?.type ?? source;
    if (source?.toUpperCase().startsWith('IFCREL') || effective?.toUpperCase().startsWith('IFCREL')) ids.add(id);
  }
  const result: Edits = { revision, source: store.source, ids };
  if (revision !== undefined) views.set(view, result);
  return result;
}

/** #9947: classifying edits is per revision, never per selected subject. */
export function selectionRelationshipEditIds(store: IfcDataStore, view: SelectionEditView): ReadonlySet<number> {
  return editsFor(store, view).ids;
}

/** Index the effective endpoints once: moved/created edges can enter a subject
 * without appearing in its source graph. Unrelated renamed objects never decode. */
export function selectionEditedRelationshipsForSubject(store: IfcDataStore, view: SelectionEditView, subject: number, types: readonly string[]): Iterable<number> {
  const edits = editsFor(store, view);
  if (!edits.subjects) {
    const overlay = selectionRelationshipOverlay(store, view, {
      createdEntities: () => (view.getNewEntities?.() ?? []).flatMap(row => row.attributes === undefined ? [] : [{ ...row, attributes: row.attributes }]),
      mutatedEntityIds: () => edits.ids,
      entityType: id => view.getTypeMutations?.().get(id)?.newType,
      namedAttributes: id => view.getAttributeMutationsForEntity?.(id).map(row => [row.name, row.value] as const) ?? [],
      positionalAttributes: id => view.getPositionalMutationsForEntity?.(id) ?? [],
      isDeleted: id => view.isDeleted?.(id) ?? false,
    });
    const subjects = new Map<number, Map<string, Set<number>>>();
    for (const row of overlay.relationships) for (const id of new Set(row.related)) {
      const classes = subjects.get(id) ?? new Map<string, Set<number>>();
      const type = row.relationshipType.toUpperCase(), ids = classes.get(type) ?? new Set<number>();
      ids.add(row.relationshipId); classes.set(type, ids); subjects.set(id, classes);
    }
    edits.subjects = subjects;
  }
  return types.flatMap(type => [...(edits.subjects!.get(subject)?.get(type) ?? [])]);
}
