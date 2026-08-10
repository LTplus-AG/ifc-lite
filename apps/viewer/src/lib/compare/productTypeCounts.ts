/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Split the engine-wide added/modified/deleted counts into products vs type
 * objects (`IfcBuildingElementProxyType` etc.).
 *
 * `DiffCounts` — and every headline built from it (the panel's counts grid,
 * the exported report's summary, the run telemetry) — totals BOTH populations
 * together, because the engine compares them together (`compareScope.ts`:
 * type objects reach the diff through the geometry pass, products through
 * `comparableProductIds`). For a certification exercise the expected answer
 * counts products only, so a user reading the combined "30 modified" gets a
 * number that does not match the products they are grading — this exact
 * confusion has happened twice.
 *
 * Classification comes from {@link isProductClass}, i.e. from the
 * cross-schema inheritance chain — **never** from the parser's IFC4 codegen
 * pin, which answers an empty chain for IFC4X3-only classes and would
 * silently mis-bucket every one of them (`typeObjectTag.ts` names this trap;
 * it has bitten four times in this codebase).
 */

import type { CompareRef } from './buildFingerprints.js';
import { isProductClass } from './compareScope.js';
import type { DiffEntry } from '@ifc-lite/diff';

/** Added/modified/deleted tally for one population (products or type objects). */
export interface ProductTypeTally {
  added: number;
  modified: number;
  deleted: number;
}

export interface ProductTypeSplit {
  products: ProductTypeTally;
  typeObjects: ProductTypeTally;
}

function emptyTally(): ProductTypeTally {
  return { added: 0, modified: 0, deleted: 0 };
}

/** Does this split have anything in the type-object side at all? Used to
 *  decide whether to render a secondary line/suffix at all — a comparison
 *  with no type-object changes must read exactly as it did before this
 *  split existed, not "+0 type objects" on every badge. */
export function hasTypeObjectChanges(split: ProductTypeSplit): boolean {
  const t = split.typeObjects;
  return t.added + t.modified + t.deleted > 0;
}

/**
 * Secondary-line text for a count badge's type-object remainder (e.g.
 * "+4 type objects"), or `undefined` when there is nothing to add. `n === 0`
 * always yields `undefined` — the empty case (a comparison with no
 * type-object changes at all) must render exactly as it did before this
 * split existed, never a "+0 type objects" badge.
 */
export function typeObjectHint(n: number): string | undefined {
  return n > 0 ? `+${n} type object${n === 1 ? '' : 's'}` : undefined;
}

/**
 * Tally `added`/`modified`/`deleted` diff entries into products vs type
 * objects. `unchanged` entries are skipped — the split exists to disambiguate
 * headline change counts, and "unchanged" is not part of that confusion.
 */
export function productTypeSplit(
  entries: readonly DiffEntry<CompareRef>[],
): ProductTypeSplit {
  const products = emptyTally();
  const typeObjects = emptyTally();
  for (const entry of entries) {
    if (entry.state === 'unchanged') continue;
    const ifcType = (entry.head ?? entry.base)?.ifcType ?? 'IfcProduct';
    const bucket = isProductClass(ifcType) ? products : typeObjects;
    bucket[entry.state]++;
  }
  return { products, typeObjects };
}
