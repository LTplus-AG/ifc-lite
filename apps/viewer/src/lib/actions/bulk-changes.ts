/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bulk editor action → reviewed `model.changes` (P15). Each target becomes
 * one change addressed by GlobalId and pinned to its model, with the value
 * the effective model holds now as the expected value. Values already set
 * (or a property already absent, for delete) are counted, not proposed.
 */

import { PropertyValueType } from '@ifc-lite/data';
import { validatePropertyDataType } from '@ifc-lite/export';
import type { BulkAction } from '@ifc-lite/mutations';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import type { ViewerState } from '@/store';
import { toConversion, type ChangeConversion, type ConversionIssue } from './change-conversion';
import { EDITABLE_ATTRIBUTES, type EditableAttribute, type ModelChange } from './model-change';
import { currentValue, modelReader, sameValue, UNSUPPORTED_VALUE, type ModelReader } from './model-change-values';
import { existingProperty } from './table-cells';

export interface ChangeTargetRef { modelId: string; expressId: number }

/** The IFC value type a bulk value type writes, so a Real stays Real even when the value is whole. */
const DECLARED: Partial<Record<PropertyValueType, string>> = {
  [PropertyValueType.String]: 'IfcLabel', [PropertyValueType.Label]: 'IfcLabel', [PropertyValueType.Text]: 'IfcText',
  [PropertyValueType.Identifier]: 'IfcIdentifier', [PropertyValueType.Real]: 'IfcReal', [PropertyValueType.Integer]: 'IfcInteger',
  [PropertyValueType.Boolean]: 'IfcBoolean', [PropertyValueType.Logical]: 'IfcLogical',
};

function build(reader: ModelReader, expressId: number, globalId: string, modelId: string, action: BulkAction): ModelChange | string {
  const target = { globalId, modelId };
  switch (action.type) {
    case 'SET_PROPERTY': {
      const value = action.value;
      if (value === null || Array.isArray(value) || typeof value === 'object') return 'only single values can be reviewed';
      const declared = existingProperty(reader, expressId, action.psetName, action.propName)?.dataType ?? DECLARED[action.valueType];
      let dataType: string | undefined;
      try { dataType = declared ? validatePropertyDataType(value, declared).dataType : undefined; }
      catch (error) { return error instanceof Error ? error.message : String(error); }
      return { op: 'property.set', target, pset: action.psetName, name: action.propName, expected: null, value, ...(dataType ? { dataType } : {}) };
    }
    case 'DELETE_PROPERTY':
      // The expected value is filled in from the model; a placeholder keeps the type exact.
      return { op: 'property.delete', target, pset: action.psetName, name: action.propName, expected: '' };
    case 'SET_ATTRIBUTE': {
      if (!EDITABLE_ATTRIBUTES.includes(action.attribute as EditableAttribute)) return `${action.attribute} cannot be reviewed`;
      const type = reader.view.getEntityTypeMutation(expressId)?.newType ?? reader.dataStore.entities.getTypeName(expressId);
      if (!getAttributeNamesAcrossSchemas(type).includes(action.attribute)) return `${type} has no ${action.attribute}`;
      return { op: 'attribute.set', target, name: action.attribute as EditableAttribute, expected: '', value: action.value };
    }
    default:
      return 'this bulk action cannot be reviewed';
  }
}

export function bulkActionToModelChanges(state: ViewerState, targets: readonly ChangeTargetRef[], action: BulkAction,
  title: string): ChangeConversion {
  const issues: ConversionIssue[] = [];
  const changes: ModelChange[] = [];
  const readers = new Map<string, ModelReader | null>();
  let unchanged = 0;
  if (action.type === 'SET_ENTITY_TYPE') {
    return toConversion(title, undefined, [], [{ kind: 'unsupported-action', detail: action.type }], 0);
  }
  for (const { modelId, expressId } of targets) {
    if (!readers.has(modelId)) readers.set(modelId, modelReader(state, modelId));
    const reader = readers.get(modelId);
    if (!reader) { issues.push({ kind: 'model-unavailable', element: modelId }); continue; }
    const globalId = reader.dataStore.entities.getGlobalId(expressId);
    const element = reader.dataStore.entities.getName(expressId) || globalId || `#${expressId}`;
    if (!globalId) { issues.push({ kind: 'no-global-id', element }); continue; }
    const built = build(reader, expressId, globalId, modelId, action);
    if (typeof built === 'string') { issues.push({ kind: 'unsupported-value', element, detail: built }); continue; }
    const current = currentValue(reader, expressId, built);
    if (current === UNSUPPORTED_VALUE) { issues.push({ kind: 'unsupported-value', element }); continue; }
    if (built.op === 'property.delete') {
      if (current === null) { unchanged++; continue; }
      changes.push({ ...built, expected: current });
      continue;
    }
    if (sameValue(current, built.value, built.op === 'attribute.set')) { unchanged++; continue; }
    changes.push({ ...built, expected: current } as ModelChange);
  }
  return toConversion(title, undefined, changes, issues, unchanged);
}
