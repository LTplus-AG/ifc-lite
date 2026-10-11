/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EffectiveEntityOverlay, IfcAttributeValue } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { resolveEffectiveEntityRecord, type EffectiveEntityRecord } from './effective-entity-record.js';
import { getEntityRefFromStore } from './columnar-parser-root-attributes.js';
import { normalizeIfcTypeName } from './ifc-schema.js';
import { namedMetadataValue, positionalMetadataValue } from './metadata-edit-value.js';

export interface MetadataReadView extends EffectiveEntityOverlay {
  getNewEntities(): ReadonlyArray<{ readonly expressId: number; readonly type: string; readonly attributes: IfcAttributeValue[] }>;
  getNewEntity(expressId: number): { readonly type: string; readonly attributes: IfcAttributeValue[] } | null;
  getPositionalMutationsForEntity(expressId: number): ReadonlyMap<number, IfcAttributeValue> | null;
  getAttributeMutationsForEntity(expressId: number): ReadonlyArray<{ name: string; value: string }>;
  getMutationRevision(): number;
  resolveBaseEntityId?(expressId: number): number;
}

const records = new WeakMap<IfcDataStore, WeakMap<MetadataReadView, { revision: number; source: IfcDataStore['source']; rows: Map<number, EffectiveEntityRecord | null> }>>();

/** Retained native indexes provide resource types absent from the entity table.
 * Only the type is read: source-free attributes must still come from current edits. */
function sourceFreeMetadataType(store: IfcDataStore, expressId: number): string {
  const tableType = store.entities.getTypeName(expressId);
  return tableType && tableType !== 'Unknown' ? tableType
    : getEntityRefFromStore(store, expressId)?.type ?? tableType;
}

export function effectiveMetadataRecord(store: IfcDataStore, expressId: number, view?: MetadataReadView): EffectiveEntityRecord | null {
  if (view?.isDeleted(expressId)) return null;
  let modelRecords = records.get(store);
  if (!modelRecords) { modelRecords = new WeakMap(); records.set(store, modelRecords); }
  const revision = view?.getMutationRevision();
  let memo = view ? modelRecords.get(view) : undefined;
  if (view && (!memo || memo.revision !== revision || memo.source !== store.source)) { memo = { revision: revision!, source: store.source, rows: new Map() }; modelRecords.set(view, memo); }
  if (memo?.rows.has(expressId)) return memo.rows.get(expressId) ?? null;
  const created = view?.getNewEntity(expressId);
  // Source-empty stores cannot reveal source attributes through a stale accessor closure.
  // Named/positional edits may still supply a known field on an otherwise unreadable row.
  const base = created ? { ...created, attributes: created.attributes.map(positionalMetadataValue) } : (store.source?.length ? store.getEntity(expressId) : {
    type: sourceFreeMetadataType(store, expressId), attributes: [],
  });
  if (!base) return null;
  const retype = view?.getTypeMutations?.().get(expressId)?.newType;
  const result = resolveEffectiveEntityRecord(base, {
    retype,
    named: view?.getAttributeMutationsForEntity(expressId).map(row => [row.name, namedMetadataValue(row.value, retype ?? base.type, row.name, store.schemaVersion)] as const) ?? [],
    positional: [...(view?.getPositionalMutationsForEntity(expressId) ?? [])].map(([index, value]) => [index, positionalMetadataValue(value)] as const),
  }, store.schemaVersion);
  const normalized = { ...result, type: normalizeIfcTypeName(result.type) };
  memo?.rows.set(expressId, normalized);
  return normalized;
}

