/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Its own module: only the lazily loaded zone operations read it, so it stays out of the eager assignment chunk.
import type { ZoneAssignmentsByElement } from './types.js';

/** One set's assignments by content. The assignment sync rebuilds an identical Map after every geometry tick, a recolour included. */
export function zoneAssignmentSignature(assignments: ZoneAssignmentsByElement, setId: string): string {
  // Sorted: a rebuild may walk the meshes in another order.
  return JSON.stringify([...assignments].flatMap(([id, sets]) => sets[setId] ? [[id, sets[setId]] as const] : []).sort(([a], [b]) => a - b));
}
