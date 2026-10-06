/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `chart.proposal`: one Charts `ChartSpec` over the `elements` source, plus
 * the dashboard scope it is reviewed in. A proposal names IFC fields by
 * identity only (`{kind:'quantity', qsetName, quantityName}`); how a field
 * reads (number or category, its IFC measure and unit) is taken from what the
 * loaded models actually carry at review time (`resolveChartSpec`), exactly
 * as the chart editor's field picker does, never from the model's answer.
 * Other chart sources (clash, BCF, schedule, IDS, compare) are refused.
 */

import { ELEMENT_COLUMNS, elementFieldColumnId, validateChartSpec, type ChartScope, type ChartSpec, type ChartType, type ElementFieldBinding } from '@ifc-lite/charts';
import { onlyKeys, parseEnvelope, record, requiredText, type ArtifactEnvelope } from './artifact-json';
import { parseProposalGroups } from './artifact-rules';
import type { FilterGroup } from '@ifc-lite/rules';

type Identity<T> = T extends unknown ? Omit<T, 'valueKind' | 'unit' | 'dataType'> : never;
/** A field named by identity; its reading comes from the loaded models. */
export type FieldIdentity = Identity<ElementFieldBinding>;

export interface ChartDraft {
  title: string;
  type: Exclude<ChartType, 'timeline'>;
  /** A built-in elements column (`IfcType`, `Storey`, `Model`, `Name`); absent when `elementField` is the dimension. */
  dimension?: string;
  elementField?: FieldIdentity;
  stackBy?: string;
  measure: { agg: 'count' | 'sum' };
  measureField?: FieldIdentity;
  filter?: { groups: FilterGroup[] };
  sort?: 'value' | 'label';
  topN?: number;
  bins?: number;
}

export interface ChartProposal extends ArtifactEnvelope {
  kind: 'chart.proposal';
  scope: ChartScope;
  chart: ChartDraft;
}

const TYPES = ['bar', 'stackedBar', 'pie', 'treemap', 'histogram', 'elementCount'] as const;
const BUILT_IN: readonly string[] = Object.values(ELEMENT_COLUMNS);
const SPATIAL_LEVELS = ['Container', 'Building', 'Site', 'Project'] as const;

export function parseFieldIdentity(value: unknown, at: string): FieldIdentity {
  if (!record(value)) throw new Error(`${at} is not an object`);
  switch (value.kind) {
    case 'attribute':
      onlyKeys(value, ['kind', 'attributeName'], at);
      return { kind: 'attribute', attributeName: requiredText(value.attributeName, `${at} "attributeName"`) };
    case 'property':
      onlyKeys(value, ['kind', 'psetName', 'propertyName'], at);
      return { kind: 'property', psetName: requiredText(value.psetName, `${at} "psetName"`), propertyName: requiredText(value.propertyName, `${at} "propertyName"`) };
    case 'quantity':
      onlyKeys(value, ['kind', 'qsetName', 'quantityName'], at);
      return { kind: 'quantity', qsetName: requiredText(value.qsetName, `${at} "qsetName"`), quantityName: requiredText(value.quantityName, `${at} "quantityName"`) };
    case 'classification':
      onlyKeys(value, ['kind', 'system'], at);
      return { kind: 'classification', ...(value.system !== undefined ? { system: requiredText(value.system, `${at} "system"`) } : {}) };
    case 'spatial':
      onlyKeys(value, ['kind', 'level'], at);
      if (!SPATIAL_LEVELS.includes(value.level as typeof SPATIAL_LEVELS[number])) throw new Error(`${at} "level" must be one of ${SPATIAL_LEVELS.join(', ')} (Storey is the built-in "Storey" dimension)`);
      return { kind: 'spatial', level: value.level as typeof SPATIAL_LEVELS[number] };
    case 'material': case 'type':
      onlyKeys(value, ['kind'], at);
      return { kind: value.kind };
    default:
      throw new Error(`${at} "kind" must be attribute, property, quantity, material, classification, type or spatial`);
  }
}

function count(value: unknown, at: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${at} must be a whole number from ${min} to ${max}`);
  return value;
}

export function parseChartProposal(answer: string): ChartProposal {
  const { value, envelope } = parseEnvelope(answer, 'chart.proposal', ['scope', 'chart']);
  if (value.scope !== undefined && value.scope !== 'all' && value.scope !== 'visible' && value.scope !== 'basket') throw new Error('The chart "scope" must be all, visible or basket');
  const scope: ChartScope = { kind: (value.scope as ChartScope['kind'] | undefined) ?? 'all' };
  if (!record(value.chart)) throw new Error('A chart.proposal needs a "chart" object');
  const chart = value.chart;
  onlyKeys(chart, ['title', 'source', 'type', 'dimension', 'elementField', 'stackBy', 'measure', 'measureField', 'filter', 'sort', 'topN', 'bins'], 'The chart');
  if (chart.source !== undefined && chart.source !== 'elements') throw new Error('Assistant chart proposals chart model elements only ("source": "elements"); build clash, BCF, schedule, IDS or compare charts in the chart editor');
  if (!TYPES.includes(chart.type as typeof TYPES[number])) throw new Error(`The chart "type" must be one of ${TYPES.join(', ')}`);
  const type = chart.type as ChartDraft['type'];
  const elementField = chart.elementField === undefined ? undefined : parseFieldIdentity(chart.elementField, 'The chart "elementField"');
  if (type === 'elementCount') {
    if (chart.dimension !== undefined || elementField) throw new Error('An elementCount chart has no dimension');
  } else if (elementField ? chart.dimension !== undefined : !BUILT_IN.includes(chart.dimension as string)) {
    throw new Error(`The chart dimension is either "dimension": one of ${BUILT_IN.join(', ')}, or an "elementField", not both`);
  }
  if (type === 'histogram' && !elementField) throw new Error('A histogram bins a numeric "elementField"');
  if (chart.stackBy !== undefined && (type !== 'stackedBar' || !BUILT_IN.includes(chart.stackBy as string) || chart.stackBy === chart.dimension)) {
    throw new Error(`"stackBy" is for stackedBar only and must be another of ${BUILT_IN.join(', ')}`);
  }
  if (type === 'stackedBar' && chart.stackBy === undefined) throw new Error('A stackedBar needs "stackBy"');
  if (!record(chart.measure) || (chart.measure.agg !== 'count' && chart.measure.agg !== 'sum')) throw new Error('The chart "measure" must be {"agg":"count"} or {"agg":"sum"}');
  onlyKeys(chart.measure, ['agg'], 'The chart measure');
  const agg = chart.measure.agg;
  if (agg === 'sum' && type === 'elementCount') throw new Error('An elementCount chart only counts');
  const measureField = chart.measureField === undefined ? undefined : parseFieldIdentity(chart.measureField, 'The chart "measureField"');
  if ((agg === 'sum') !== !!measureField) throw new Error('A summed chart names the summed field in "measureField"; a counted chart has none');
  let filter: ChartDraft['filter'];
  if (chart.filter !== undefined) {
    if (!record(chart.filter)) throw new Error('The chart "filter" must be {"groups":[...]}');
    onlyKeys(chart.filter, ['groups'], 'The chart filter');
    filter = { groups: parseProposalGroups(chart.filter.groups, 'The chart filter') };
  }
  if (chart.sort !== undefined && chart.sort !== 'value' && chart.sort !== 'label') throw new Error('The chart "sort" must be value or label');
  const topN = count(chart.topN, 'The chart "topN"', 1, 100);
  const bins = count(chart.bins, 'The chart "bins"', 1, 100);
  return { ...envelope, kind: 'chart.proposal', scope, chart: {
    title: chart.title === undefined ? envelope.title : requiredText(chart.title, 'The chart "title"'), type,
    ...(chart.dimension !== undefined ? { dimension: chart.dimension as string } : {}), ...(elementField ? { elementField } : {}),
    ...(chart.stackBy !== undefined ? { stackBy: chart.stackBy as string } : {}), measure: { agg }, ...(measureField ? { measureField } : {}),
    ...(filter ? { filter } : {}), ...(chart.sort !== undefined ? { sort: chart.sort as 'value' | 'label' } : {}),
    ...(topN !== undefined ? { topN } : {}), ...(bins !== undefined ? { bins } : {}),
  } };
}

/** The identity part of a binding, for matching a proposal's field against discovered ones. */
export function fieldIdentityKey(field: FieldIdentity | ElementFieldBinding): string {
  switch (field.kind) {
    case 'attribute': return `attribute:${field.attributeName}`;
    case 'property': return `property:${JSON.stringify([field.psetName, field.propertyName])}`;
    case 'quantity': return `quantity:${JSON.stringify([field.qsetName, field.quantityName])}`;
    case 'classification': return `classification:${field.system ?? ''}`;
    case 'spatial': return `spatial:${field.level}`;
    default: return field.kind;
  }
}

/**
 * The native spec once each named field has its discovered binding. Throws a
 * reason when a field reads in a way the chart cannot use (a summed field that
 * is not numeric in the loaded models).
 */
export function resolveChartSpec(draft: ChartDraft, id: string, bindingOf: (field: FieldIdentity) => ElementFieldBinding | null): ChartSpec {
  let elementField: ElementFieldBinding | undefined;
  if (draft.elementField) {
    const found = bindingOf(draft.elementField);
    if (!found) throw new Error('The chart dimension field is not carried by any loaded element');
    if (draft.type === 'histogram' && found.valueKind !== 'number') throw new Error('The histogram field is not numeric in the loaded models');
    elementField = draft.type === 'histogram' || found.kind === 'quantity' ? found : { ...found, valueKind: 'category' } as ElementFieldBinding;
  }
  let measureField: ElementFieldBinding | undefined;
  if (draft.measureField) {
    const found = bindingOf(draft.measureField);
    if (!found) throw new Error('The summed field is not carried by any loaded element');
    if (found.valueKind !== 'number') throw new Error('The summed field is not numeric in the loaded models, so it cannot be summed');
    measureField = found;
  }
  const { measure, dimension, filter } = draft;
  const common = { id, title: draft.title, source: 'elements' as const,
    ...(draft.stackBy !== undefined ? { stackBy: draft.stackBy } : {}), ...(draft.sort ? { sort: draft.sort } : {}),
    ...(draft.topN !== undefined ? { topN: draft.topN } : {}), ...(draft.bins !== undefined ? { bins: draft.bins } : {}),
    ...(elementField ? { elementField } : {}), ...(measureField ? { measureField } : {}),
    measure: measure.agg === 'sum' && measureField ? { agg: 'sum' as const, column: elementFieldColumnId(measureField) } : { agg: 'count' as const },
    ...(filter ? { filter: { selector: '', groups: filter.groups } } : {}) };
  const spec: ChartSpec = draft.type === 'elementCount'
    ? { ...common, type: 'elementCount' }
    : { ...common, type: draft.type, dimension: elementField ? elementFieldColumnId(elementField) : dimension as string };
  const errors = validateChartSpec(spec);
  if (errors.length > 0) throw new Error(`The chart does not validate: ${errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
  return spec;
}
