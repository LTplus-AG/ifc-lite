/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The model tree over the model as edited (#5249).
 *
 * The "By Class", "By Type" and "Groups" builders read parsed entity
 * tables or type indexes alongside the mutation overlay. The overlay never
 * writes back into those source structures. `useHierarchyTree` folds created products into the
 * class tree (`authoredProducts`), but a deleted entity stayed listed:
 * `removeEntity` prunes its mesh, so it dropped into the grayed "Other" bucket
 * instead of disappearing. A retyped entity stayed under its parsed class.
 * Parsed rows use {@link effectiveTreeType}; the type and group builders also
 * enumerate authored entities and edited relationship endpoints (#5249).
 */

import { normalizeIfcTypeName } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** Resolves a model's mutation view; absent or null means no edits to apply. */
export type TreeOverlay = (modelId: string) => MutablePropertyView | null | undefined;

/**
 * A parsed row's class in the edited model: its retyped class when the
 * session retyped it, `parsedType` otherwise, and `null` when the session
 * deleted it (the row must not appear at all).
 */
export function effectiveTreeType(
  view: MutablePropertyView | null | undefined,
  expressId: number,
  parsedType: string,
): string | null {
  if (!view) return parsedType;
  if (view.isDeleted(expressId)) return null;
  const retype = view.getEntityTypeMutation(expressId)?.newType;
  return retype ? normalizeIfcTypeName(retype) : parsedType;
}
