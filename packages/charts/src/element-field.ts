/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue, ChartDatasetColumn, ElementFieldBinding, ElementFieldValueKind } from './types.js';

/** Stable, collision-free dataset column id for a persisted IFC field binding. */
export function elementFieldColumnId(binding: ElementFieldBinding): string {
  const identity = binding.kind === 'attribute'
    ? ['attribute', binding.attributeName]
    : ['property', binding.psetName, binding.propertyName];
  return `ifc-field:${JSON.stringify(identity)}`;
}

export function elementFieldLabel(binding: ElementFieldBinding): string {
  return binding.kind === 'attribute'
    ? binding.attributeName
    : `${binding.psetName}.${binding.propertyName}`;
}

export function elementFieldColumn(binding: ElementFieldBinding): ChartDatasetColumn {
  return {
    id: elementFieldColumnId(binding),
    label: elementFieldLabel(binding),
    kind: binding.valueKind,
    ...(binding.unit ? { unit: binding.unit } : {}),
  };
}

export interface NormalizedElementFieldValue {
  value: CellValue;
  status: 'value' | 'missing' | 'unsupported';
}

function typedScalar(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') return value;
  const tag = value[0].toUpperCase();
  if (!tag.startsWith('IFC')) return value;
  return value[1];
}

/** Normalize a scalar for aggregation without display formatting or coercing labels. */
export function normalizeElementFieldValue(raw: unknown, kind: ElementFieldValueKind): NormalizedElementFieldValue {
  const value = typedScalar(raw);
  if (value === null || value === undefined) return { value: null, status: 'missing' };
  if (Array.isArray(value) || typeof value === 'object') return { value: null, status: 'unsupported' };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { value: null, status: 'unsupported' };
    return kind === 'number' ? { value, status: 'value' } : { value: String(value), status: 'value' };
  }
  if (typeof value === 'boolean') {
    return kind === 'boolean' ? { value, status: 'value' } : { value: String(value), status: 'value' };
  }
  if (typeof value !== 'string') return { value: null, status: 'unsupported' };
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.U.' || trimmed === '.X.') return { value: null, status: 'missing' };
  if (kind === 'boolean') {
    if (trimmed === '.T.' || trimmed.toLowerCase() === 'true') return { value: true, status: 'value' };
    if (trimmed === '.F.' || trimmed.toLowerCase() === 'false') return { value: false, status: 'value' };
    return { value: null, status: 'unsupported' };
  }
  if (kind === 'number') return { value: null, status: 'unsupported' };
  const categorical = trimmed.startsWith('.') && trimmed.endsWith('.') ? trimmed.slice(1, -1) : trimmed;
  return { value: categorical, status: 'value' };
}
