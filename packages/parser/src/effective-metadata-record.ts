/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { EffectiveEntityOverlay, IfcAttributeValue } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { resolveEffectiveEntityRecord, type EffectiveEntityRecord } from './effective-entity-record.js';

export interface MetadataReadView extends EffectiveEntityOverlay {
  getNewEntities(): ReadonlyArray<{ readonly expressId: number; readonly type: string; readonly attributes: IfcAttributeValue[] }>;
  getNewEntity(expressId: number): { readonly type: string; readonly attributes: IfcAttributeValue[] } | null;
  getPositionalMutationsForEntity(expressId: number): ReadonlyMap<number, IfcAttributeValue> | null;
  getAttributeMutationsForEntity(expressId: number): ReadonlyArray<{ name: string; value: string }>;
  getMutationRevision(): number;
  resolveBaseEntityId?(expressId: number): number;
}

const records = new WeakMap<IfcDataStore, WeakMap<MetadataReadView, { revision: number; source: IfcDataStore['source']; rows: Map<number, EffectiveEntityRecord | null> }>>();
// Native edited/created '$' denotes absent data. The canonical source reader
// retains '*', and a quoted '$' in the original file remains literal text.
const editValue = (value: unknown): unknown => value === '$' ? null : value;
// Created/positional attributes use serializeStepValueAt, which trims marker
// tokens; named STRING attributes preserve whitespace as literal text.
const positionalValue = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  const token = value.trim();
  return token === '$' ? null : token === '*' ? '*' : value;
};

export function effectiveMetadataRecord(store: IfcDataStore, expressId: number, view?: MetadataReadView): EffectiveEntityRecord | null {
  if (view?.isDeleted(expressId)) return null;
  let modelRecords = records.get(store);
  if (!modelRecords) { modelRecords = new WeakMap(); records.set(store, modelRecords); }
  const revision = view?.getMutationRevision();
  let memo = view ? modelRecords.get(view) : undefined;
  if (view && (memo?.revision !== revision || memo.source !== store.source)) { memo = { revision: revision!, source: store.source, rows: new Map() }; modelRecords.set(view, memo); }
  if (memo?.rows.has(expressId)) return memo.rows.get(expressId) ?? null;
  const created = view?.getNewEntity(expressId);
  // Source-empty stores cannot reveal source attributes through a stale accessor closure.
  // Named/positional edits may still supply a known field on an otherwise unreadable row.
  const base = created ? { ...created, attributes: created.attributes.map(positionalValue) } : (store.source?.length ? store.getEntity(expressId) : {
    type: store.entities.getTypeName(expressId), attributes: [],
  });
  if (!base) return null;
  const result = resolveEffectiveEntityRecord(base, {
    retype: view?.getTypeMutations?.().get(expressId)?.newType,
    named: view?.getAttributeMutationsForEntity(expressId).map(row => [row.name, editValue(row.value)] as const) ?? [],
    positional: [...(view?.getPositionalMutationsForEntity(expressId) ?? [])].map(([index, value]) => [index, positionalValue(value)] as const),
  }, store.schemaVersion);
  memo?.rows.set(expressId, result);
  return result;
}

