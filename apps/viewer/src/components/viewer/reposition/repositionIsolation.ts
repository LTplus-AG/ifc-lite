/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The isolation set a Reposition pick hands the renderer: the entities of the
 * eligible models, narrowed by the user's isolation when there is one.
 *
 * The renderer's screen-space corner index (#11504) recognises a visibility
 * set by identity and size, so the same set must come back for the same
 * inputs. Building a fresh `Set` on every pointer move made every move look
 * like a visibility change: the corner grid was never "settled" and, with any
 * isolation active, corner snapping never engaged.
 */
export function createIsolationFor(allowed: Set<number>) {
  let lastIsolated: Set<number> | null = null;
  let lastResult: Set<number> | null = null;
  return (isolated: Set<number> | null): Set<number> => {
    if (isolated === null) return allowed;
    if (lastResult !== null && lastIsolated === isolated) return lastResult;
    const narrowed = new Set<number>();
    for (const id of allowed) if (isolated.has(id)) narrowed.add(id);
    lastIsolated = isolated;
    lastResult = narrowed;
    return narrowed;
  };
}
