/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Display name for a rendered property-set / quantity-set header.
 *
 * `IfcRoot.Name` is optional, so a `PropertySet`/`QuantitySet` reaching the
 * viewer can carry `name: ''` — either from a real STEP file whose
 * `IFCPROPERTYSET`/`IFCELEMENTQUANTITY` declares `Name` as the empty string
 * literal, or (once PR #3534 lands) from one whose `Name` is the null
 * marker `$`, which the parser no longer fabricates a placeholder for.
 *
 * This mirrors the `getName || "<Type> #<id>"` convention `treeDataBuilder`
 * uses for element rows, but a pset/qset carries no id downstream of the
 * on-demand extraction functions that build it (`packages/parser`,
 * `packages/ifcx`) — nothing between there and this component threads one
 * through. So the fallback names only the kind, not a fabricated id.
 */
export function setDisplayName(name: string, kind: 'Property Set' | 'Quantity Set'): string {
  return name.trim() ? name : `Unnamed ${kind}`;
}
