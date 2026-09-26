/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the viewer's visibility reset (`resetVisibilityForHomeFromStore`: Home
 * and every Show all control) leaves in the hidden channel:
 * exactly the active lens's hides, preserving their existing ownership (#5877).
 *
 * A reset removes manual-only hides, but the lens stays active and keeps its
 * colours, so its hides must survive too. An id the user hid before the lens
 * matched it remains unowned, so deactivating the lens cannot reveal it.
 * With no active lens the channel is simply empty.
 */
export function hiddenChannelAfterReset(
  activeLensId: string | null,
  lensHiddenIds: ReadonlySet<number>,
  lensAppliedHiddenIds: readonly number[],
  hiddenBeforeReset: ReadonlySet<number>,
): { hiddenEntities: Set<number>; lensAppliedHiddenIds: number[] } {
  const kept = activeLensId ? [...lensHiddenIds] : [];
  const owned = new Set(lensAppliedHiddenIds);
  // A new lens match may not have reached the sync effect yet. If it was not
  // hidden before reset, the lens is the one introducing its hide now.
  return { hiddenEntities: new Set(kept), lensAppliedHiddenIds: kept.filter((id) => owned.has(id) || !hiddenBeforeReset.has(id)) };
}
