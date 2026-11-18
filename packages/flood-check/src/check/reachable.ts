/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Below-ground spaces that water entering through an exposed candidate can reach. */

import type { CandidateFact, SpaceFact } from '../model/facts.js';
import type { Outcome } from './outcome.js';

export interface ReachableSpace {
  space: SpaceFact;
  /** Exposed candidates above it whose water can reach it. Flagged, not sized. */
  via: number[];
}

/** Categories through which water can enter; equipment is damaged by water but is not a way in. */
const ENTRY_CATEGORIES: ReadonlySet<string> = new Set([
  'door', 'window', 'basement-window', 'wall-opening', 'slab-opening', 'light-well', 'stair', 'ramp',
]);

export function reachableSpaces(
  spaces: readonly SpaceFact[],
  results: ReadonlyArray<{ outcome: Outcome; terrainHeight: number | null; candidate: CandidateFact }>,
): ReachableSpace[] {
  const out = new Map<number, ReachableSpace>();
  for (const r of results) {
    if (r.outcome !== 'exposed' || r.terrainHeight === null || !ENTRY_CATEGORIES.has(r.candidate.category)) continue;
    const below = Math.min(r.candidate.level, r.terrainHeight);
    for (const space of spaces) {
      if (space.floorLevel >= below) continue;
      const entry = out.get(space.expressId) ?? { space, via: [] };
      entry.via.push(r.candidate.expressId);
      out.set(space.expressId, entry);
    }
  }
  return [...out.values()].sort((a, b) => a.space.floorLevel - b.space.floorLevel);
}
