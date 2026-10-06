/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One selected element's attributes, property sets and quantity sets as the
 * session sees them: the parsed node's values with this session's edits
 * applied through the model's mutation view. Shared by the multi-selection
 * summary (`selectionSummary.ts`) and the assistant's selection evidence, so
 * the two cannot disagree about what an element carries.
 *
 * Reads cached `EntityNode` getters per element, never a whole-model
 * re-extraction; callers bound how many elements they read.
 */

import type { IfcQuery } from '@ifc-lite/query';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { effectivePropertySets, effectiveQuantitySets } from './effectiveSets';
import type { PropertySet, QuantitySet } from './encodingUtils';

export interface EffectiveElementData {
  /** Attribute name to value; an edited attribute replaces the parsed one. */
  attributes: Map<string, string | number | boolean>;
  psets: PropertySet[];
  qsets: QuantitySet[];
}

export function effectiveElementData(
  expressId: number,
  query: IfcQuery | null,
  view: MutablePropertyView | null | undefined,
): EffectiveElementData {
  const node = query?.entity(expressId) ?? null;
  const attributes = new Map<string, string | number | boolean>();
  for (const attr of node?.allAttributes() ?? []) attributes.set(attr.name, attr.value);
  for (const attr of view?.getAttributeMutationsForEntity(expressId) ?? []) attributes.set(attr.name, attr.value);
  return {
    attributes,
    psets: effectivePropertySets(view, expressId, () => node?.properties() ?? []),
    qsets: effectiveQuantitySets(view, expressId, (baseId) => query?.entity(baseId).quantities() ?? []),
  };
}
