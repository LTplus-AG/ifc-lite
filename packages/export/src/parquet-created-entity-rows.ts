/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeNamesAcrossSchemas, getInheritanceChainAcrossSchemas, resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EffectiveEntityIndex } from './effective-index.js';

interface EntityColumns {
  ExpressId: number[];
  GlobalId: string[];
  Name: string[];
  Description: string[];
  Type: string[];
  ObjectType: string[];
  HasGeometry: boolean[];
  IsType: boolean[];
  ContainedInStorey: number[];
  DefinedByType: number[];
  GeometryIndex: number[];
}

function stepText(value: unknown): string {
  if (typeof value !== 'string' || value === '$') return '';
  return value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replaceAll("''", "'") : value;
}

/** Append live creations after the parsed rows; the caller filters tombstoned source rows. */
export function appendCreatedParquetEntityRows(
  columns: EntityColumns,
  store: IfcDataStore,
  view: MutablePropertyView | null,
  effective: EffectiveEntityIndex | null,
): void {
  if (!view || !effective) return;
  for (const created of view.getNewEntities()) {
    if (!effective.isOverlayCreated(created.expressId) || effective.isDeleted(created.expressId)) continue;
    const record = resolveEffectiveEntityRecord(
      { type: created.type, attributes: created.attributes },
      {
        retype: view.getTypeMutations().get(created.expressId)?.newType,
        named: view.getAttributeMutationsForEntity(created.expressId).map(({ name, value }) => [name, value] as const),
        positional: view.getPositionalMutationsForEntity(created.expressId) ?? [],
      },
      store.schemaVersion,
    );
    const names = record.names.length > 0 ? record.names : getAttributeNamesAcrossSchemas(record.type);
    const field = (name: string): string => stepText(record.attributes[names.indexOf(name)]);
    columns.ExpressId.push(created.expressId);
    columns.GlobalId.push(field('GlobalId'));
    columns.Name.push(field('Name'));
    columns.Description.push(field('Description'));
    columns.Type.push(record.type);
    columns.ObjectType.push(field('ObjectType'));
    // Geometry and relationship-derived indexes are absent until their own
    // Parquet tables can write the authored mesh/relationship rows.
    columns.HasGeometry.push(false);
    columns.IsType.push(getInheritanceChainAcrossSchemas(record.type).includes('IfcTypeObject'));
    columns.ContainedInStorey.push(-1);
    columns.DefinedByType.push(-1);
    columns.GeometryIndex.push(-1);
  }
}
