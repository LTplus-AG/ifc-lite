/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a source file says is hidden, applied to the viewer's own hide state.
 *
 * It runs after the model is registered, for two reasons: the federation
 * offset the ids go through is only known then, and the state it writes is the
 * ordinary per-entity hide channel, so the user can show the rows again from
 * the tree like anything else they hid themselves (the Rhino import spec's
 * "the adapter loads hidden entities and applies the viewer's normal hide
 * state after `finalizeModel`").
 */

import { useViewerStore } from '@/store';

/**
 * Hide `expressIds` of model `modelId`, resolved through the federation
 * registry rather than by adding an offset here (AGENTS.md "Models &
 * federation"), so the single-model fallback holds too.
 */
export function applyInitialHiddenState(modelId: string, expressIds: readonly number[]): void {
  if (expressIds.length === 0) return;
  const state = useViewerStore.getState();
  state.hideEntities(expressIds.map((expressId) => state.toGlobalId(modelId, expressId)));
}
