/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Lane } from './lift.js';
import type { NodeOutputs } from './registry.js';
import type { TrackedEntry, TrackedSet, TrackingPlan } from './tracking.js';

/** A replacement can leave both generations alive when removal fails or is cancelled.
 * Keep the displaced entry as a vanished lane for the normal removal/orphan paths. */
function retainDisplaced(entries: Record<string, TrackedEntry>, key: string, entry: TrackedEntry): void {
  let retainedKey = `retained:${JSON.stringify([key, entry.globalId])}`;
  while (entries[retainedKey]) {
    if (entries[retainedKey].globalId === entry.globalId) return;
    retainedKey += ':';
  }
  entries[retainedKey] = entry;
}

/** Persist completed work, never desired-but-unexecuted creates. On interruption,
 * removals have not started, so every previous element remains owned. */
export function reconcileTrackingProgress(plan: TrackingPlan, previous: TrackedSet | undefined,
  nodeType: string, lanes: readonly Lane[], results: readonly (NodeOutputs | null)[],
  skippedDuplicates: ReadonlySet<number>, failedRemovals: readonly string[], interrupted = false): TrackedSet {
  const prior = previous?.entries ?? {};
  const entries = { ...(interrupted ? prior : plan.next.entries) };
  const successful = new Set<string>();
  for (const [index, lane] of lanes.entries()) {
    if (lane.nullLane || skippedDuplicates.has(index)) continue;
    const key = lane.laneKey ?? '';
    if (results[index] !== undefined && results[index] !== null) {
      successful.add(key);
      if (interrupted && plan.next.entries[key]) {
        const old = entries[key];
        entries[key] = plan.next.entries[key];
        if (old && old.globalId !== entries[key].globalId) retainDisplaced(entries, key, old);
      }
    } else if (!interrupted) {
      if (prior[key]) entries[key] = prior[key];
      else delete entries[key];
    }
  }
  for (const key of failedRemovals) {
    if (!prior[key]) continue;
    if (successful.has(key) && entries[key]?.globalId !== prior[key].globalId) retainDisplaced(entries, key, prior[key]);
    else entries[key] = prior[key];
  }
  return { ...plan.next, entries, nodeType };
}
