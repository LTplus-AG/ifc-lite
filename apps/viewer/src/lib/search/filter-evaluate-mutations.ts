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
 * selector run right after an edit matches the edited value, not the file —
 * on the occurrence AND on its defining TYPE object (`typePropertySetsFor`).
 * A `type=` rule's own type-Name lookup and DELETE-suppression on a
 * TYPE-inherited property (`mergeInheritedPropertySets` has no delete
 * concept) remain base-store-only; both are follow-up scope.
 */
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, extractAllEntityAttributes, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { AttrRows } from './filter-match.js';

type PsetSets = ReturnType<typeof extractPropertiesOnDemand>;

/** The occurrence's own property sets, WITH mutations applied when a
 *  `mutationView` is present — the same call `element-field-reader.ts`'s
 *  `setsFor` makes for the Elements chart's own field column. */
export function ownPropertySetsFor(store: IfcDataStore, expressId: number, mutationView: MutablePropertyView | undefined): PsetSets {
  return mutationView ? mutationView.getForEntity(expressId) : extractPropertiesOnDemand(store, expressId);
}

/** `typeBasePsets` (the defining TYPE object's own property sets, as
 *  `getInheritedTypePsets` in filter-evaluate.ts already resolves them —
 *  the type-specific on-demand path, not `ownPropertySetsFor`, since a
 *  type object walks a different relation than an occurrence) topped up
 *  with the mutation view's edit of that TYPE, when it has one — an
 *  edited pset replaces its base counterpart by name, an untouched one
 *  passes through. Same overlay `element-field-reader.ts`'s `typeSetsFor`
 *  applies for the Elements chart's own field column (#4946 review). */
export function typePropertySetsFor(typeBasePsets: PsetSets, typeId: number, mutationView: MutablePropertyView | undefined): PsetSets {
  if (!mutationView?.hasChanges(typeId)) return typeBasePsets;
  const overlay = mutationView.getForEntity(typeId);
  const overlayNames = new Set(overlay.map((set) => set.name));
  return [...overlay, ...typeBasePsets.filter((set) => !overlayNames.has(set.name))];
}

type QtySets = ReturnType<typeof extractQuantitiesOnDemand>;

/** Overlay sets first, each topped up with any base quantity of the same set
 *  name it does not itself name; untouched base sets pass through as-is —
 *  same merge `element-field-families.ts`'s `qsetsFor` uses for the same
 *  reason: editing one quantity must not hide its siblings or an unrelated
 *  quantity set (issue #2487). */
function overlayFirstQtySets(overlay: QtySets, base: QtySets): QtySets {
  const byName = new Map(overlay.map((set) => [set.name, set]));
  const merged = overlay.map((set) => {
    const named = new Set(set.quantities.map((q) => q.name));
    const inherited: QtySets[number]['quantities'] = [];
    for (const baseSet of base) {
      if (baseSet.name !== set.name) continue;
      for (const q of baseSet.quantities) if (!named.has(q.name)) { named.add(q.name); inherited.push(q); }
    }
    return inherited.length > 0 ? { ...set, quantities: [...set.quantities, ...inherited] } : set;
  });
  return [...merged, ...base.filter((set) => !byName.has(set.name))];
}

/** The occurrence's quantity sets, WITH mutations applied when present. A
 *  `mutationView` built for a server-hydrated store (no quantity extractor,
 *  `!hasQuantityBase()`) answers `getQuantitiesForEntity` from its overlay
 *  ALONE, which would otherwise make an edited quantity's siblings — or an
 *  untouched quantity set — vanish from a selector's reads; merge the base
 *  back in for that case instead of trusting the overlay as the whole set. */
export function quantitySetsFor(store: IfcDataStore, expressId: number, mutationView: MutablePropertyView | undefined): QtySets {
  if (!mutationView) return extractQuantitiesOnDemand(store, expressId);
  const overlay = mutationView.getQuantitiesForEntity(expressId);
  if (mutationView.hasQuantityBase()) return overlay;
  const base = extractQuantitiesOnDemand(store, expressId).filter((set) => !mutationView.isQuantitySetDeleted(expressId, set.name));
  return overlayFirstQtySets(overlay, base);
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
