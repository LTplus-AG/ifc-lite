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

import { normalizeIfcTypeName, type IfcDataStore } from '@ifc-lite/parser';
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

/** `modelId`'s view as a tree or chip reads it. Legacy single-store mode
 *  keys its edits under `__legacy__`, as the Inspector does. */
export function overlayViewFor(overlay: TreeOverlay | undefined, modelId: string): MutablePropertyView | null | undefined {
  return overlay?.(modelId === 'legacy' ? '__legacy__' : modelId);
}

/**
 * Any row's class in the edited model, parsed or authored: the overlay
 * record's class for an entity created this session (the parsed table does
 * not hold it and answers `'Unknown'`, #6233), the parsed class otherwise,
 * then {@link effectiveTreeType}'s retype and delete rules.
 */
export function effectiveRowType(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  expressId: number,
): string | null {
  const authored = view?.getNewEntity(expressId)?.type;
  const parsedType = authored ? normalizeIfcTypeName(authored) : store.entities?.getTypeName(expressId);
  return effectiveTreeType(view, expressId, parsedType || 'Unknown');
}
