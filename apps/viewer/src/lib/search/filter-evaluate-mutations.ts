/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Live-edit overlay for `filter-evaluate.ts`'s property/quantity/attribute
 * readers (#4946 review finding on PR #4984): split out of the evaluator
 * itself so it stays inside its module-size budget.
 *
 * `evaluatorModelsFromState` (`lib/model-tags/evaluator-models.ts`) is the
 * ONE place a model's live `MutablePropertyView` reaches the evaluator; this
 * is the ONE place that overlay gets applied to what a rule reads, so a
 * selector run right after an edit matches the edited value, not the file.
 * Occurrence-level only — a mutation on the defining TYPE object is not yet
 * folded in (`getInheritedTypePsets` in `filter-evaluate.ts` still reads the
 * base store), same as it was before this change.
 */
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, extractAllEntityAttributes, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { AttrRows } from './filter-match.js';

/** The occurrence's own property sets, WITH mutations applied when a
 *  `mutationView` is present — the same call `element-field-reader.ts`'s
 *  `setsFor` makes for the Elements chart's own field column. */
export function ownPropertySetsFor(store: IfcDataStore, expressId: number, mutationView: MutablePropertyView | undefined): ReturnType<typeof extractPropertiesOnDemand> {
  return mutationView ? mutationView.getForEntity(expressId) : extractPropertiesOnDemand(store, expressId);
}

/** The occurrence's quantity sets, WITH mutations applied when present. */
export function quantitySetsFor(store: IfcDataStore, expressId: number, mutationView: MutablePropertyView | undefined): ReturnType<typeof extractQuantitiesOnDemand> {
  return mutationView ? mutationView.getQuantitiesForEntity(expressId) : extractQuantitiesOnDemand(store, expressId);
}

/** The occurrence's root attributes, an edited one overriding its base value
 *  by name (order otherwise kept) — same merge `element-field-reader.ts`'s
 *  `attrsFor` does. */
export function attributesFor(store: IfcDataStore, expressId: number, mutationView: MutablePropertyView | undefined): AttrRows {
  const base = extractAllEntityAttributes(store, expressId);
  const edits = mutationView?.getAttributeMutationsForEntity(expressId);
  if (!edits || edits.length === 0) return base;
  const merged = new Map<string, AttrRows[number]>();
  for (const a of base) merged.set(a.name, a);
  for (const e of edits) merged.set(e.name, e);
  return [...merged.values()];
}
