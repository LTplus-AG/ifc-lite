/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The isolation set a Reposition pick hands the renderer: the entities of the
 * eligible models, narrowed by the user's isolation when there is one.
 *
 * Reuse the narrowed set while user isolation has the same members so that
 * repeated pointer moves can settle the renderer's corner grid.
 */
export function createIsolationFor(allowed: Set<number>) {
  let members: number[] = [];
  let lastResult: Set<number> | null = null;
  return (isolated: Set<number> | null): Set<number> => {
    if (isolated === null) return allowed;
    if (lastResult && members.length === isolated.size && members.every(id => isolated.has(id))) return lastResult;
    const narrowed = new Set<number>();
    for (const id of allowed) if (isolated.has(id)) narrowed.add(id);
    members = [...isolated];
    lastResult = narrowed;
    return narrowed;
  };
}
