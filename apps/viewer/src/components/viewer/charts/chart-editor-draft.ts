/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { elementFieldColumn, elementFieldColumnId, type ChartDataset, type ChartDatasetColumn, type ChartSpec, type ChartType, type ElementFieldBinding } from '@ifc-lite/charts';

/** The form changes chart type and dimension independently. Its empty string
 * dimension is resolved only when the draft becomes a saved spec. */
export type ChartDraft = Omit<ChartSpec, 'type' | 'dimension'> & { type: ChartType; dimension: string };

export function specToDraft(spec: ChartSpec): ChartDraft {
  const measureField = spec.measureField ?? (spec.elementField?.valueKind === 'number'
    && spec.measure.agg === 'sum' && spec.measure.column === elementFieldColumnId(spec.elementField)
    ? spec.elementField : undefined);
  return { ...spec, measureField, dimension: spec.dimension ?? '' };
}

/** Drop a bucket dimension and sum when switching to Element Count. */
export function draftToSpec(draft: ChartDraft): ChartSpec {
  const { type, dimension, measure, measureField, ...rest } = draft;
  if (type === 'elementCount') return { ...rest, type, measure: { agg: 'count' } };
  return { ...rest, type, dimension, measure, ...(measure.agg === 'sum' && measureField ? { measureField } : {}) };
}

/** Unsaved IFC bindings exist only in the editor's columns, so changing the
 * draft does not rebuild every saved chart's shared dataset. */
export function editorColumns(dataset: ChartDataset, draft: ChartDraft): ChartDatasetColumn[] {
  if (draft.source !== 'elements') return dataset.columns;
  const builtIn = dataset.columns.filter((column) => !column.id.startsWith('ifc-field:'));
  const fields = [draft.elementField, draft.measureField].filter((field): field is ElementFieldBinding => field !== undefined);
  return [...builtIn, ...new Map(fields.map((field) => [elementFieldColumnId(field), elementFieldColumn(field)])).values()];
}

export function dimensionColumns(type: ChartType, columns: readonly ChartDatasetColumn[]): ChartDatasetColumn[] {
  if (type === 'elementCount') return [];
  if (type === 'histogram') return columns.filter((c) => c.kind === 'number');
  if (type === 'timeline') return columns.filter((c) => c.kind === 'date');
  return columns.filter((c) => c.kind === 'category' || c.kind === 'boolean');
}
