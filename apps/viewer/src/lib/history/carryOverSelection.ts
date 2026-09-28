/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carrying a selection across an "Open (replace)".
 *
 * Express ids are per-file and are reassigned by every re-export, so the only
 * thing that survives a version swap is the KEY — the IFC `GlobalId`. A
 * carry-over that reused the express id would silently select a different
 * element in the new version, which is worse than selecting nothing.
 *
 * Pure, and separate from the load listener, because "which element is this
 * in the other version" is the interesting half and the listener is not
 * testable without a viewport.
 */

import type { FederatedModel } from '@/store';

export interface CarriedSelection {
  /** IFC GlobalId of the element that was selected. */
  readonly globalId: string;
}

/** The GlobalId of `expressId` in `model`, or `null` when it has none. */
export function captureSelection(model: FederatedModel | undefined, expressId: number | null): CarriedSelection | null {
  if (!model?.ifcDataStore || expressId === null) return null;
  const globalId = model.ifcDataStore.entities?.getGlobalId?.(expressId);
  return typeof globalId === 'string' && globalId.length > 0 ? { globalId } : null;
}

/**
 * The express id `carried` has in `model`, or `null` when the element is not
 * in this version — which is the ordinary outcome for an element that was
 * deleted, and means "select nothing" rather than "select something else".
 */
export function resolveCarriedSelection(
  model: FederatedModel | undefined,
  carried: CarriedSelection | null,
): number | null {
  if (!carried || !model?.ifcDataStore) return null;
  const expressId = model.ifcDataStore.entities?.getExpressIdByGlobalId?.(carried.globalId);
  // The two implementations in this repo disagree on their miss value (`0`
  // from the fixture table, `-1` from the server table), so both are treated
  // as "not here" rather than as a real express id.
  return typeof expressId === 'number' && expressId > 0 ? expressId : null;
}
