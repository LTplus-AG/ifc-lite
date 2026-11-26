/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Quantity, QuantitySet } from '@ifc-lite/data';
import type { QuantityMutation } from './types.js';
import { findQuantityInBaseSets } from './base-qset-lookup.js';

/** Capture metadata before replacing an authored row, as well as its old value. */
export function quantityHistoryBefore(
  existingMutation: QuantityMutation | undefined,
  baseQsets: readonly QuantitySet[],
  authoredQuantity: Quantity | undefined,
  qsetName: string,
  quantName: string,
): { oldValue: number | null; isUpdate: boolean; oldQuantityType?: number; oldUnit: string | null } {
  // Get old value for undo and to determine CREATE vs UPDATE. An overlay
  // mutation (a prior edit this session) wins; otherwise fall back to the
  // base quantity's own value — `qsetExistsInBase` alone is not enough,
  // since a *new* quantity name can be added to an already-existing qset.
  // Without the base-value fallback, the first edit of an existing base
  // quantity reported `oldValue: null` (UPDATE_QUANTITY with nothing to
  // restore), which is exactly the null the viewer's undo handler treats
  // as "nothing to revert to" — undo silently did nothing (#2297 shape).
  const quantity = authoredQuantity ?? findQuantityInBaseSets(baseQsets, qsetName, quantName);
  const oldUnit = existingMutation?.unitRemoved ? null : existingMutation?.unit ?? quantity?.unit ?? null;
  return {
    oldValue: existingMutation ? existingMutation.value ?? null : quantity?.value ?? null,
    isUpdate: existingMutation !== undefined || quantity !== undefined,
    oldQuantityType: existingMutation?.quantityType ?? quantity?.type,
    oldUnit,
  };
}
