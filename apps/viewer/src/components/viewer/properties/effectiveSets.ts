/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The property and quantity sets an entity shows once its edits apply.
 *
 * A mutation view's answer is authoritative even when it is EMPTY: an empty
 * list after the user deleted the last set means "no sets", and falling back
 * to the source node would resurrect what was deleted (#5900 review).
 *
 * Properties always have a base under a viewer view (the on-demand extractor
 * `configureMutationView` installs, or the constructor's property table).
 * Quantities only do when the store has an on-demand quantity map
 * (`hasQuantityBase`); without one the caller's source sets are handed to the
 * view as its base provider, keyed by the base id the view resolves (a
 * duplicate reads its source), so deletions and edits still apply on top.
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { PropertySet, QuantitySet } from './encodingUtils';

/** Source quantity sets for a base entity id, as the view's provider takes them. */
export type BaseQuantitySets = NonNullable<Parameters<MutablePropertyView['getQuantitiesForEntity']>[1]>;

export function effectivePropertySets(
  view: MutablePropertyView | null | undefined,
  expressId: number,
  nodeSets: () => PropertySet[],
): PropertySet[] {
  return view ? view.getForEntity(expressId) : nodeSets();
}

export function effectiveQuantitySets(
  view: MutablePropertyView | null | undefined,
  expressId: number,
  baseSets: BaseQuantitySets,
): QuantitySet[] {
  if (!view) return baseSets(expressId);
  return view.hasQuantityBase() ? view.getQuantitiesForEntity(expressId) : view.getQuantitiesForEntity(expressId, baseSets);
}
