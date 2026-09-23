/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityFlags } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { getAttributeNamesForSchema, normalizeIfcTypeName, resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
import type { ElementsEntityTable } from '@ifc-lite/charts';

function textValue(value: unknown): string {
  if (typeof value !== 'string' || value === '$' || value === '*') return '';
  const text = value.trim();
  return text.length >= 2 && text.startsWith("'") && text.endsWith("'")
    ? text.slice(1, -1).replace(/''/g, "'")
    : text;
}

function effectiveCreatedRecord(store: IfcDataStore, view: MutablePropertyView, id: number) {
  const created = view.getNewEntity(id);
  if (!created) return null;
  return resolveEffectiveEntityRecord(created, {
    retype: view.getEntityTypeMutation(id)?.newType,
    named: view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
    positional: view.getPositionalMutationsForEntity(id) ?? [],
  }, store.schemaVersion);
}

export interface EffectiveChartRow {
  expressId: number;
  type: string;
  flags: number;
  overlayCreated: boolean;
}

/** The same live row membership for the dataset and the editor's chunked field scan. */
export function* iterateEffectiveChartRows(store: IfcDataStore, view?: MutablePropertyView): IterableIterator<EffectiveChartRow> {
  const source = store.entities;
  if (!view) {
    for (let i = 0; i < source.count; i++) {
      const expressId = source.expressId[i];
      yield { expressId, type: source.getTypeName(expressId), flags: source.flags[i], overlayCreated: false };
    }
    return;
  }
  const sourceFlags = new Map<number, number>();
  for (let i = 0; i < source.count; i++) sourceFlags.set(source.expressId[i], source.flags[i]);
  const namedEdits = view.getAttributeMutationsByEntity();
  for (const { expressId, type, overlayCreated } of iterateEffectiveEntityIds(store, view, undefined, source.expressId)) {
    let rowFlags = sourceFlags.get(expressId) ?? 0;
    let effectiveType: string;
    if (overlayCreated) {
      const record = effectiveCreatedRecord(store, view, expressId);
      if (!record) continue;
      const representation = record.attributes[record.names.indexOf('Representation')];
      rowFlags = representation !== undefined && representation !== null
        && representation !== '$' && representation !== '*' ? EntityFlags.HAS_GEOMETRY : 0;
      effectiveType = record.type;
    } else {
      const retyped = view.getEntityTypeMutation(expressId) !== undefined;
      effectiveType = retyped ? normalizeIfcTypeName(type) : source.getTypeName(expressId);
      const namedRepresentation = namedEdits.get(expressId)?.get('Representation');
      const positional = view.getPositionalMutationsForEntity(expressId);
      if (retyped || namedRepresentation !== undefined || positional) {
        const representationIndex = getAttributeNamesForSchema(effectiveType, store.schemaVersion).indexOf('Representation');
        if (representationIndex < 0) rowFlags &= ~EntityFlags.HAS_GEOMETRY;
        else {
          const representation = positional?.has(representationIndex)
            ? positional.get(representationIndex)
            : namedRepresentation;
          if (representation !== undefined) {
            if (representation === null || representation === '$' || representation === '*') rowFlags &= ~EntityFlags.HAS_GEOMETRY;
            else rowFlags |= EntityFlags.HAS_GEOMETRY;
          }
        }
      }
    }
    yield { expressId, type: effectiveType, flags: rowFlags, overlayCreated };
  }
}

/** EntityTable-shaped chart rows after pending edits, without mutating the parsed table. */
export function effectiveChartEntities(store: IfcDataStore, view: MutablePropertyView): ElementsEntityTable {
  const source = store.entities;
  const ids: number[] = [];
  const flags: number[] = [];
  const types = new Map<number, string>();
  const createdNames = new Map<number, string>();
  const namedEdits = view.getAttributeMutationsByEntity();
  for (const row of iterateEffectiveChartRows(store, view)) {
    ids.push(row.expressId);
    flags.push(row.flags);
    types.set(row.expressId, row.type);
    if (row.overlayCreated) {
      const record = effectiveCreatedRecord(store, view, row.expressId);
      if (record) createdNames.set(row.expressId, textValue(record.attributes[record.names.indexOf('Name')]));
    }
  }

  const getName = (id: number): string => {
    const created = createdNames.get(id);
    if (created !== undefined) return created;
    const named = namedEdits.get(id)?.get('Name');
    const positional = view.getPositionalMutationsForEntity(id);
    const nameIndex = positional
      ? getAttributeNamesForSchema(types.get(id) ?? source.getTypeName(id), store.schemaVersion).indexOf('Name')
      : -1;
    const edited = nameIndex >= 0 && positional?.has(nameIndex)
      ? positional.get(nameIndex)
      : named;
    return edited === undefined ? source.getName(id) : textValue(edited);
  };
  return {
    count: ids.length,
    expressId: ids,
    flags,
    getName,
    getTypeName: (id) => types.get(id) ?? source.getTypeName(id),
  };
}
