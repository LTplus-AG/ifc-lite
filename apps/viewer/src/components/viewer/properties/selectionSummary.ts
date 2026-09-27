/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcQuery } from '@ifc-lite/query';
import { extractProjectUnits, ProjectUnits, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EntityRef } from '@/store/types';
import { effectiveSelectedClass } from './effectiveSelectedClass';
import { propertyDisplayValue, quantityDisplayValue } from './propertyDisplayValue';
import type { PropertySet, QuantitySet } from './encodingUtils';

/**
 * Values are compared across at most this many elements. Counts and the
 * element list always cover the whole selection; reading every property of a
 * select-all on a large model would stall the panel for seconds.
 */
const SUMMARY_VALUE_LIMIT = 500;

/** One selected model as the summary reads it. */
interface SummarySource {
  store: IfcDataStore | null;
  view: MutablePropertyView | undefined;
  modelName: string;
}

/** A shared row: `value` is the common display value, or null when it varies. */
export interface SummaryRow { name: string; value: string | null; distinct: number }
interface SummaryGroup { name: string; rows: SummaryRow[] }
interface SummaryElement { ref: EntityRef; name: string; className: string }

interface SelectionSummary {
  total: number;
  compared: number;
  byClass: Array<{ label: string; count: number }>;
  byModel: Array<{ modelId: string; label: string; count: number }>;
  elements: SummaryElement[];
  attributes: SummaryRow[];
  properties: SummaryGroup[];
  quantities: SummaryGroup[];
}

/** Rows present on every compared element, keyed `group\u0000name`, in first-seen order. */
function sharedRows(perElement: Array<Map<string, string>>): Map<string, SummaryRow> {
  const out = new Map<string, SummaryRow>();
  const [first, ...rest] = perElement;
  if (!first) return out;
  for (const key of first.keys()) {
    if (!rest.every((values) => values.has(key))) continue;
    const distinct = new Set(perElement.map((values) => values.get(key)));
    const name = key.slice(key.indexOf('\u0000') + 1);
    out.set(key, { name, value: distinct.size === 1 ? first.get(key) ?? null : null, distinct: distinct.size });
  }
  return out;
}

function grouped(rows: Map<string, SummaryRow>): SummaryGroup[] {
  const groups = new Map<string, SummaryRow[]>();
  for (const [key, row] of rows) {
    const group = key.slice(0, key.indexOf('\u0000'));
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  return [...groups].map(([name, groupRows]) => ({ name, rows: groupRows }));
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return counts;
}

/**
 * What a multi-selection has in common (#5900): how many elements of each
 * class and model, and every attribute, property and quantity the compared
 * elements all carry, with its value when they agree. Values compare as the
 * panel displays them (unit conversion included), and edits made this session
 * count, because the panel shows those too.
 */
export function summarizeSelection(
  refs: EntityRef[],
  sourceFor: (modelId: string) => SummarySource | null,
  unitDisplayOverrides: Record<string, string>,
  locale: string,
): SelectionSummary {
  const queries = new Map<string, IfcQuery | null>();
  const units = new Map<string, ProjectUnits>();
  const queryFor = (modelId: string, store: IfcDataStore | null) => {
    if (!queries.has(modelId)) queries.set(modelId, store ? new IfcQuery(store) : null);
    return queries.get(modelId) ?? null;
  };
  const unitsFor = (modelId: string, store: IfcDataStore | null) => {
    if (!units.has(modelId)) {
      units.set(modelId, store?.source?.length && store.entityIndex
        ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty());
    }
    return units.get(modelId) ?? ProjectUnits.empty();
  };

  const elements: Array<SummaryElement & { modelLabel: string }> = refs.map((ref) => {
    const source = sourceFor(ref.modelId);
    const className = effectiveSelectedClass(source?.store, source?.view, ref.expressId) ?? 'Unknown';
    const name = queryFor(ref.modelId, source?.store ?? null)?.entity(ref.expressId).name;
    return { ref, className, name: name || `${className} #${ref.expressId}`, modelLabel: source?.modelName ?? ref.modelId };
  });

  const attributeValues: Array<Map<string, string>> = [];
  const propertyValues: Array<Map<string, string>> = [];
  const quantityValues: Array<Map<string, string>> = [];
  for (const { ref } of elements.slice(0, SUMMARY_VALUE_LIMIT)) {
    const source = sourceFor(ref.modelId);
    const store = source?.store ?? null;
    const node = queryFor(ref.modelId, store)?.entity(ref.expressId) ?? null;
    const view = source?.view;
    const projectUnits = unitsFor(ref.modelId, store);

    const attributes = new Map<string, string>();
    for (const attr of node?.allAttributes() ?? []) attributes.set(`\u0000${attr.name}`, String(attr.value));
    for (const attr of view?.getAttributeMutationsForEntity(ref.expressId) ?? []) attributes.set(`\u0000${attr.name}`, String(attr.value));
    attributeValues.push(attributes);

    const edited: PropertySet[] = view?.getForEntity(ref.expressId) ?? [];
    const psets: PropertySet[] = edited.length > 0 ? edited : node?.properties() ?? [];
    const properties = new Map<string, string>();
    for (const pset of psets) {
      for (const prop of pset.properties) {
        properties.set(`${pset.name}\u0000${prop.name}`, propertyDisplayValue(prop, projectUnits, unitDisplayOverrides).full);
      }
    }
    propertyValues.push(properties);

    const editedQ: QuantitySet[] = view?.getQuantitiesForEntity(ref.expressId) ?? [];
    const qsets: QuantitySet[] = editedQ.length > 0 ? editedQ : node?.quantities() ?? [];
    const quantities = new Map<string, string>();
    for (const qset of qsets) {
      for (const q of qset.quantities) {
        quantities.set(`${qset.name}\u0000${q.name}`, quantityDisplayValue(q, projectUnits, unitDisplayOverrides, locale));
      }
    }
    quantityValues.push(quantities);
  }

  const byModel = countBy(elements, (e) => e.ref.modelId);
  return {
    total: refs.length,
    compared: attributeValues.length,
    byClass: [...countBy(elements, (e) => e.className)]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    byModel: [...byModel].map(([modelId, count]) => ({
      modelId, count, label: elements.find((e) => e.ref.modelId === modelId)?.modelLabel ?? modelId,
    })),
    elements: elements.map(({ ref, name, className }) => ({ ref, name, className })),
    attributes: [...sharedRows(attributeValues).values()],
    properties: grouped(sharedRows(propertyValues)),
    quantities: grouped(sharedRows(quantityValues)),
  };
}
