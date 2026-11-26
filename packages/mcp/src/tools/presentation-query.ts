/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  encodeRef, matchesCondition, parseFieldPath,
  type ChartDatum, type ColumnSpec, type FieldPath, type IfcQuerySpec, type RowSpec,
} from '@ifc-lite/a2ui';
import type { EntityData } from '@ifc-lite/sdk';
import type { LoadedModel } from '../context.js';
import { materialFallbackName } from '../material-naming.js';

type Attributes = ReturnType<LoadedModel['bim']['attributes']>;

/** `attrs` loads the entity's attributes once (a source re-parse) however many fields read them. */
function readField(model: LoadedModel, entity: EntityData, field: FieldPath, attrs: () => Attributes) {
  switch (field.kind) {
    case 'attribute': {
      const want = field.name.toLowerCase();
      return attrs().find((a) => a.name.toLowerCase() === want)?.value;
    }
    case 'property':
      return model.bim.property(entity.ref, field.set, field.name)
        ?? model.bim.quantity(entity.ref, field.set, field.name);
    case 'builtin':
      switch (field.key) {
        case 'modelId': return entity.ref.modelId;
        case 'storey': return model.bim.storey(entity.ref)?.name;
        case 'material': return materialFallbackName(model.bim.materials(entity.ref));
        default: return entity[field.key];
      }
  }
}

export function computePresentationQuery(
  model: LoadedModel,
  spec: IfcQuerySpec,
  columns: ColumnSpec[],
  groupBy: string | undefined,
  limit: number,
  signal: AbortSignal,
): { rows: RowSpec[]; groups: ChartDatum[]; total: number } {
  const filters = spec.where?.map((condition) => ({ condition, field: parseFieldPath(condition.path)! })) ?? [];
  const fields = columns.map((column) => [column.path, parseFieldPath(column.path)!] as const);
  const groupField = groupBy === undefined ? undefined : parseFieldPath(groupBy)!;
  const groups = new Map<string, ChartDatum>();
  const rows: RowSpec[] = [];
  let total = 0;
  for (const entity of model.bim.query().byType(...(spec.types ?? [])).toArray()) {
    signal.throwIfAborted();
    let loaded: Attributes | undefined;
    const attrs = () => (loaded ??= model.bim.attributes(entity.ref));
    if (spec.storey !== undefined && model.bim.storey(entity.ref)?.name.toLowerCase() !== spec.storey.toLowerCase()) continue;
    if (!filters.every(({ condition, field }) => matchesCondition(readField(model, entity, field, attrs), condition))) continue;
    total++;
    if (rows.length >= limit) continue;
    const ref = encodeRef(entity.ref);
    rows.push({ ...Object.fromEntries(fields.map(([path, field]) => [path, readField(model, entity, field, attrs) ?? null])), ref });
    if (groupField) {
      const label = String(readField(model, entity, groupField, attrs) ?? '(missing)') || '(missing)';
      const group = groups.get(label) ?? { label, value: 0, refs: [] };
      group.value++;
      group.refs?.push(ref);
      groups.set(label, group);
    }
  }
  return { rows, groups: [...groups.values()].sort((a, b) => b.value - a.value), total };
}
