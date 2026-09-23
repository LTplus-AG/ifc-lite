/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { normalizeIfcTypeName, resolveEffectiveEntityRecord, type EffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { FilteredElement } from './filter-evaluate.js';

export interface EffectiveFilterFields {
  ifcType: string;
  name: string | undefined;
  globalId: string;
}

export function createdFilterRecord(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  expressId: number,
): EffectiveEntityRecord | null {
  const created = view?.getNewEntity(expressId);
  if (!created || !view) return null;
  return resolveEffectiveEntityRecord(created, {
    retype: view.getEntityTypeMutation(expressId)?.newType,
    named: view.getAttributeMutationsForEntity(expressId).map(({ name, value }) => [name, value] as const),
    positional: view.getPositionalMutationsForEntity(expressId) ?? [],
  }, store.schemaVersion);
}

/** The same class and root values export will write for a live filter result. */
export function effectiveFilterFields(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  expressId: number,
): EffectiveFilterFields {
  const record = createdFilterRecord(store, view, expressId);
  if (record) {
    const value = (name: string): string | undefined => {
      const index = record.names.indexOf(name);
      const raw = index < 0 ? undefined : record.attributes[index];
      return typeof raw === 'string' && raw !== '$' ? raw : undefined;
    };
    return { ifcType: record.type, name: value('Name'), globalId: value('GlobalId') ?? '' };
  }
  const retype = view?.getEntityTypeMutation(expressId)?.newType;
  const edits = view?.getAttributeMutationsForEntity(expressId);
  const edited = (name: string): string | undefined =>
    edits?.find((entry) => entry.name === name)?.value;
  return {
    ifcType: retype ? normalizeIfcTypeName(retype) : store.entities.getTypeName(expressId),
    name: edited('Name') ?? store.entities.getNameOrUndefined(expressId),
    globalId: edited('GlobalId') ?? store.entities.getGlobalId(expressId),
  };
}

export function buildFilterResult(modelId: string, expressId: number, fields: EffectiveFilterFields): FilteredElement {
  return {
    modelId,
    expressId,
    ifcType: fields.ifcType,
    name: fields.name ?? '',
    globalId: fields.globalId,
  };
}
