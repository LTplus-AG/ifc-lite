/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What to do to the chat transcript when the loaded model changes (#2471).
 *
 * The playground holds exactly one model and every write replaces it
 * (`McpPlayground.tsx`: sample load, file drop, close). The transcript is NOT
 * cleared on that swap — losing the user's thread because they opened a second
 * file would be worse than the problem being solved.
 *
 * But `expressId` is unique inside ONE STEP file and not across files, so the
 * moment the model changes, every id sitting in earlier tool results names a
 * different element in the new file, or nothing at all. The agent re-reads the
 * whole transcript on every turn and has no way to tell which side of the swap
 * a result came from. Nothing else in the playground marks that boundary.
 *
 * This is the reachable half of #2471. The unqualified-identity defect that
 * issue was filed for needs the playground to federate, which it cannot
 * (`buildEntityRecords` throws on a second model, #2492) — but a stale id
 * replayed across a swap needs only two files and one session.
 *
 * Kept as a pure function so the decision can be pinned, in the house style of
 * `hooks/cacheTier.ts`'s deciders: the component owns the effect, this owns the
 * rule.
 *
 * IDENTITY IS THE LOAD, NOT THE FILE. Every comparison here is on `loadId`, a
 * token minted once per load by the caller — never on the model id, which is a
 * slug of the filename (`parsePlaygroundModel`). Dropping a revised
 * `model.ifc` over the old one is the single most likely two-file session
 * there is, and it keeps the same id while every expressId may have moved.
 */

/** A loaded model, as this decision sees it. */
export interface SwapModelRef {
  /** Unique per LOAD. Two loads of the same filename are two different loads. */
  loadId: number;
  /** Display name, for the notice text. */
  name: string;
}

/** The subset of `ChatMessage` this produces. */
export interface SwapNotice {
  id: string;
  role: 'user';
  text: string;
}

/**
 * The notice to append when the loaded model moves from `lastLoaded` to
 * `next`, or `null` when nothing needs saying.
 *
 * `lastLoaded` is the last model that was actually LOADED, which the caller
 * must keep across a close. Clearing it on unload would let
 * load A → close → load B slip through as a first load, and that path is a
 * button in the same toolbar.
 */
export function modelSwapNotice(
  lastLoaded: SwapModelRef | null,
  next: SwapModelRef | null,
  transcriptLength: number,
): SwapNotice | null {
  // Closing: nothing is loaded to confuse ids with, and the next load is
  // still compared against `lastLoaded`, so the warning is only deferred.
  if (next === null) return null;
  // First load of the session: no earlier ids exist.
  if (lastLoaded === null) return null;
  // Same load re-rendering.
  if (lastLoaded.loadId === next.loadId) return null;
  if (transcriptLength === 0) return null;
  return {
    // Keyed on the load, so swapping A → B → A → B yields four distinct React
    // keys rather than two colliding pairs.
    id: `model-swap-${next.loadId}`,
    role: 'user',
    text:
      `[The loaded model changed to "${next.name}". Every expressId from earlier tool ` +
      'results belongs to the previous file and does not identify anything in this one. ' +
      'GlobalIds may survive if these are two revisions of the same project, but verify ' +
      'rather than assume. Re-query before acting on any id from above.]',
  };
}
