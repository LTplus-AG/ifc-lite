/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The IFC5 writer's columnar source domain, with live entity edits folded in. */
import { IfcTypeEnumToString, iterateEffectiveEntities, type IfcTypeEnum } from '@ifc-lite/data';
import { getAttributeNamesAcrossSchemas, resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

export interface Ifc5EntityRow {
  expressId: number;
  type: string;
  globalId: string;
  name: string;
  description: string;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '$') return '';
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replaceAll("''", "'") : value;
}

function createdFields(names: readonly string[], attributes: readonly unknown[]): Pick<Ifc5EntityRow, 'globalId' | 'name' | 'description'> {
  const field = (name: string): string => text(attributes[names.indexOf(name)]);
  return { globalId: field('GlobalId'), name: field('Name'), description: field('Description') };
}

function editedFields(
  id: number,
  type: string,
  fields: Pick<Ifc5EntityRow, 'globalId' | 'name' | 'description'>,
  view: MutablePropertyView | null,
): typeof fields {
  if (!view) return fields;
  const values = { ...fields };
  const slots = getAttributeNamesAcrossSchemas(type);
  const set = (name: string, value: unknown): void => {
    if (name === 'GlobalId') values.globalId = text(value);
    if (name === 'Name') values.name = text(value);
    if (name === 'Description') values.description = text(value);
  };
  for (const { name, value } of view.getAttributeMutationsForEntity(id)) set(name, value);
  for (const [slot, value] of view.getPositionalMutationsForEntity(id) ?? []) set(slots[slot] ?? '', value);
  return values;
}

/**
 * Preserve the parsed EntityTable as the source domain: it intentionally omits
 * low-level geometry atoms. The shared iterator adds live creates and removes
 * tombstones while applying retypes to both halves of the domain.
 */
export function ifc5EntityRows(store: IfcDataStore, mutationView: MutablePropertyView | null, applyMutations: boolean): Ifc5EntityRow[] {
  const { entities, strings } = store;
  // Older integrations can supply property-only view shims. Keep their
  // property reads in the exporter, while treating membership as source-only.
  const view = applyMutations && mutationView
    && typeof mutationView.getNewEntities === 'function'
    && typeof mutationView.getNewEntity === 'function'
    && typeof mutationView.isDeleted === 'function'
      ? mutationView : null;
  const sourceIds: number[] = [];
  const sourceRows = new Map<number, number>();
  const byId = new Map<number, { type: string }>();
  // @raw-entity-enumeration-ok map the columnar source domain for the canonical effective iterator below
  for (let i = 0; i < entities.count; i++) {
    const id = entities.expressId[i];
    const fromEnum = IfcTypeEnumToString(entities.typeEnum[i] as IfcTypeEnum);
    const type = fromEnum !== 'Unknown' ? fromEnum : entities.getTypeName(id);
    sourceIds.push(id);
    sourceRows.set(id, i);
    byId.set(id, { type: type === 'Unknown' ? 'IFCUNCLASSIFIED' : type });
  }

  const result: Ifc5EntityRow[] = [];
  for (const entity of iterateEffectiveEntities({ entityIndex: { byType: new Map(), byId } }, view, undefined, sourceIds)) {
    const row = sourceRows.get(entity.expressId);
    if (row !== undefined) {
      const fields = editedFields(entity.expressId, entity.type, {
        globalId: strings.get(entities.globalId[row]) || '',
        name: strings.get(entities.name[row]) || '',
        description: strings.get(entities.description[row]) || '',
      }, view);
      result.push({
        expressId: entity.expressId, type: entity.type,
        ...fields,
      });
      continue;
    }
    const created = view?.getNewEntity(entity.expressId);
    if (!created) continue;
    const record = resolveEffectiveEntityRecord(
      { type: created.type, attributes: created.attributes },
      {
        retype: view?.getTypeMutations?.().get(entity.expressId)?.newType,
        named: (view?.getAttributeMutationsForEntity(entity.expressId) ?? []).map(({ name, value }) => [name, value] as const),
        positional: view?.getPositionalMutationsForEntity(entity.expressId) ?? [],
      },
      store.schemaVersion,
    );
    const names = record.names.length > 0 ? record.names : getAttributeNamesAcrossSchemas(record.type);
    result.push({ expressId: entity.expressId, type: entity.type, ...createdFields(names, record.attributes) });
  }
  return result;
}
