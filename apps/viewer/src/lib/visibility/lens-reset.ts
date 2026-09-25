/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the viewer's visibility reset (`resetVisibilityForHomeFromStore`: Home
 * and every Show all control) leaves in the hidden channel:
 * exactly the active lens's hides, all owned by the lens (#5877).
 *
 * A reset removes the user's hides, but the lens stays active and keeps its
 * colours, so its hides must survive too. Every surviving id is lens-owned,
 * which is what lets a later deactivation restore all of them. With no active
 * lens the channel is simply empty.
 */
export function hiddenChannelAfterReset(
  activeLensId: string | null,
  lensHiddenIds: ReadonlySet<number>,
): { hiddenEntities: Set<number>; lensAppliedHiddenIds: number[] } {
  const kept = activeLensId ? [...lensHiddenIds] : [];
  return { hiddenEntities: new Set(kept), lensAppliedHiddenIds: kept };
}
