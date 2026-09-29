/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Lists panel's claim on the shared isolate / ghost channels (#6368).
 *
 * A group row's Isolate and X-ray context actions write `isolatedEntities` /
 * `ghostExceptEntities`, which clash, IDS, Charts, the basket and others share.
 * Like those owners, the list records exactly what it installed
 * (`listVisibilityOwned`) and releases only on a content match
 * (`lib/visibility/ownership.ts`), so closing the list never clears an
 * isolation another feature installed afterwards. The installer names the
 * hand-off atomically: one `set()` writes the channel, the list's claim, and
 * drops every other owner's record, as `presentChartIds` does.
 */

import { useViewerStore } from '@/store';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { ownsCurrentVisibility, releaseOwnedVisibility, type VisibilityChannel } from '@/lib/visibility/ownership';

/** Present `ids` (renderer / global ids) in `channel`, claiming it for the list. */
export function presentListIds(ids: readonly number[], channel: VisibilityChannel): void {
  const state = useViewerStore.getState();
  // A geometry-less assembly in a group still lights up its parts.
  const installed = new Set(resolvePresentationIds(state.cameraCallbacks?.resolveHighlightIds, ids));
  // Release first: switching isolate → X-ray must not leave a stale claim.
  releaseOwnedVisibility(state, state.listVisibilityOwned);
  const isolate = channel === 'isolate';
  useViewerStore.setState({
    isolatedEntities: isolate ? installed : null,
    ghostExceptEntities: isolate ? null : installed,
    ...(isolate ? { hiddenEntities: new Set<number>() } : {}),
    idsFocusVisibilityOwned: null,
    clashVisibilityOwned: null,
    basketVisibilityOwned: null,
    chartVisibilityOwned: null,
    listVisibilityOwned: { channel, ids: installed },
  });
}

/** Release the list's claim, clearing the channel only if it still shows what the list installed. */
export function releaseListVisibility(): void {
  const state = useViewerStore.getState();
  releaseOwnedVisibility(state, state.listVisibilityOwned);
  if (useViewerStore.getState().listVisibilityOwned !== null) useViewerStore.setState({ listVisibilityOwned: null });
}

/** The channel the list verifiably owns right now, or `null`. */
export function ownedListChannel(): VisibilityChannel | null {
  const state = useViewerStore.getState();
  const owned = state.listVisibilityOwned;
  return owned && ownsCurrentVisibility(state, owned) ? owned.channel : null;
}
