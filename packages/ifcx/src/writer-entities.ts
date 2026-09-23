/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  ENTITIES_IFC2X3, ENTITIES_IFC4_EXPRESS, ENTITIES_IFC4X3,
  IFC_ENTITY_NAMES, IfcTypeEnumToString, iterateEffectiveEntities, type IfcTypeEnum,
} from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcxExportData } from './writer.js';

export interface WriterEntity {
  expressId: number;
  typeName?: string;
  globalId: string;
  name: string;
  description: string;
}

const attributesByType = new Map<string, readonly string[]>();
for (const schema of [ENTITIES_IFC4_EXPRESS, ENTITIES_IFC4X3, ENTITIES_IFC2X3]) {
  for (const entity of schema) {
    if (!attributesByType.has(entity.name.toUpperCase())) {
      attributesByType.set(entity.name.toUpperCase(), entity.attributes);
    }
  }
}

function textValue(value: unknown): string {
  if (typeof value !== 'string' || value === '$') return '';
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replaceAll("''", "'")
    : value;
}

function createdText(
  type: string,
  attributes: readonly unknown[] | undefined,
  name: 'GlobalId' | 'Name' | 'Description',
): string {
  const slot = attributesByType.get(type)?.indexOf(name) ?? -1;
  return slot < 0 ? '' : textValue(attributes?.[slot]);
}

/** One IFCX writer domain: source rows plus the live overlay's creates, minus tombstones. */
export function writerEntities(data: IfcxExportData, applyMutations: boolean): WriterEntity[] {
  const { entities, strings } = data;
  // Older integrations supply property-only view shims. They still edit
  // properties, but have no entity-membership API to apply here.
  const view: MutablePropertyView | null = applyMutations
    && data.mutationView
    && typeof data.mutationView.getNewEntities === 'function'
    && typeof data.mutationView.isDeleted === 'function'
      ? data.mutationView : null;
  const sourceIds: number[] = [];
  const sourceRows = new Map<number, number>();
  const byId = new Map<number, { type: string }>();
  const sourceClasses = new Map<number, string | undefined>();
  // @raw-entity-enumeration-ok map columnar source rows for the canonical effective iterator below; only that iterator selects emitted ids
  for (let i = 0; i < entities.count; i++) {
    const id = entities.expressId[i];
    const fromTable = entities.getTypeName?.(id);
    const resolved = fromTable && fromTable !== 'Unknown'
      ? fromTable : IfcTypeEnumToString(entities.typeEnum[i] as IfcTypeEnum);
    const type = resolved === 'Unknown' ? undefined : resolved;
    sourceIds.push(id);
    sourceRows.set(id, i);
    sourceClasses.set(id, type);
    // The canonical iterator excludes its Unknown sentinel. IFCX has always
    // kept such a source node without a class, so use a private domain token.
    byId.set(id, { type: type ?? 'IFCUNCLASSIFIED' });
  }

  const result: WriterEntity[] = [];
  for (const entity of iterateEffectiveEntities({ entityIndex: { byType: new Map(), byId } }, view, undefined, sourceIds)) {
    const row = sourceRows.get(entity.expressId);
    const created = entity.overlayCreated ? view?.getNewEntity(entity.expressId) : null;
    const typeName = entity.type === 'IFCUNCLASSIFIED'
      ? undefined
      : IFC_ENTITY_NAMES[entity.type]
        ?? created?.type
        ?? (row !== undefined ? sourceClasses.get(entity.expressId) : undefined)
        ?? entity.type;
    const globalId = row !== undefined ? strings?.get(entities.globalId[row]) ?? ''
      : createdText(entity.type, created?.attributes, 'GlobalId');
    const name = row !== undefined ? strings?.get(entities.name[row]) ?? ''
      : createdText(entity.type, created?.attributes, 'Name');
    const description = row !== undefined ? strings?.get(entities.description[row]) ?? ''
      : createdText(entity.type, created?.attributes, 'Description');
    result.push({ expressId: entity.expressId, typeName, globalId, name, description });
  }
  return result;
}
