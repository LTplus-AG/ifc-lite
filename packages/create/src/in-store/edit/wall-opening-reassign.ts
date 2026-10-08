/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Classify a wall split's hosted openings in native units (#6232). The
 * shared create core writes fresh placements and void targets atomically;
 * source Location/LocalPlacement records may have unrelated consumers. */
import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import { readHostedFill } from '../hosted-fill-read.js';
import { reassignHostedOpeningsInStore, type HostedOpeningReassignment } from '../hosted-placement-edit.js';
import { asExpressIdRef, readAttributes } from './placement-core.js';

export interface OpeningReassignSummary {
  /** Openings moved onto the left half when it is not the source. */
  toLeft: number;
  /** Openings moved onto the right half when it is not the source. */
  toRight: number;
  /** Openings whose placement is unreadable stay attached to the source. */
  skipped: number;
  skipReasons: Map<string, number>;
}

/** The caller records the shared batch in the split's undo transaction.
 * A kept right piece also shifts its openings because its origin moved. */
export function reassignWallOpenings(
  dataStore: IfcDataStore, view: MutablePropertyView, editor: StoreEditor,
  sourceWallId: number, leftWallId: number, rightWallId: number, splitDistance: number,
): OpeningReassignSummary {
  const summary: OpeningReassignSummary = { toLeft: 0, toRight: 0, skipped: 0, skipReasons: new Map() };
  const moves: HostedOpeningReassignment[] = [];
  const skip = (reason: string) => {
    summary.skipped++;
    summary.skipReasons.set(reason, (summary.skipReasons.get(reason) ?? 0) + 1);
  };
  for (const { expressId } of iterateEffectiveEntityIds(dataStore, view, ['IFCRELVOIDSELEMENT'])) {
    const rel = readAttributes(dataStore, view, editor, expressId);
    if (!rel) { skip('unreadable rel'); continue; }
    if (asExpressIdRef(rel[4]) !== sourceWallId) continue;
    const openingId = asExpressIdRef(rel[5]);
    if (openingId === null) { skip('missing opening ref'); continue; }
    const read = readHostedFill(dataStore, openingId, view);
    if (!read || read.hostId !== sourceWallId) { skip('opening not placed relative to source wall'); continue; }
    const onLeft = read.location[0] < splitDistance;
    const hostId = onLeft ? leftWallId : rightWallId;
    if (hostId !== sourceWallId) {
      if (onLeft) summary.toLeft++;
      else summary.toRight++;
    }
    if (hostId !== sourceWallId || !onLeft) moves.push({ openingId, hostId,
      location: [read.location[0] - (onLeft ? 0 : splitDistance), read.location[1], read.location[2]] });
  }
  reassignHostedOpeningsInStore(dataStore, editor, sourceWallId, moves);
  return summary;
}
