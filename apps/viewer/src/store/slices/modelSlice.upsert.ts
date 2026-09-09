/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modelSlice`'s `upsertModel` patch, beside the slice rather than inside it:
 * `modelSlice.ts` carries a recorded budget in
 * `scripts/module-size-allowlist.txt`, and that ratchet only shrinks.
 *
 * ## #4159 bug 6
 * `upsertModel` adopts the FIRST model of a session exactly like `addModel`'s
 * `state.models.size === 0` branch does — `state.activeModelId ?? model.id`
 * moves `activeModelId` from `null` to `model.id` the same way — but until
 * this fix it wrote that field directly, bypassing
 * `drawing2DSlice.markupTransition.ts`'s `markupTransitionPatch`, the one
 * choke point every OTHER `activeModelId`-moving writer in this codebase
 * goes through (see that module's doc for the other two: `setActiveModel`
 * and `addModel`, and `modelSlice.teardown.ts`'s `'model-removed'` arm).
 *
 * Left unrouted, `upsertModel` becoming the session's first write (the
 * `collabSlice.ts` room-join path and the AI-agent `useIfcLoader.ts` path
 * both call it) skipped the fresh-session `defaultMarkupPatch()` this
 * function would otherwise have restated — a no-op today, since a brand-new
 * session's five markup fields already sit at their defaults, but a silent
 * hole all the same: anything that later lets `upsertModel` adopt a model
 * while stale markup is already loaded (a future caller, not today's two)
 * would leak it onto the adopted model with no test able to see the gap
 * until it did.
 *
 * When `state.activeModelId` is already non-null, `activeModelId` here
 * resolves to the SAME id (`state.activeModelId ?? model.id` short-circuits),
 * so `markupTransitionPatch` correctly no-ops (`nextModelId ===
 * state.activeModelId`) — this only has teeth on the first-model case.
 */

import type { FederatedModel } from '../types.js';
import type { ViewerState } from '../index.js';
import { markupTransitionPatch } from './drawing2DSlice.markupTransition.js';

export function upsertModelPatch(state: ViewerState, model: FederatedModel): Partial<ViewerState> {
  const newModels = new Map(state.models);
  const existing = newModels.get(model.id);
  newModels.set(model.id, existing ? { ...existing, ...model } : model);
  const activeModelId = state.activeModelId ?? model.id;
  const activeModel = newModels.get(activeModelId) ?? null;
  const markupPatch = markupTransitionPatch(state, activeModelId);

  return {
    models: newModels,
    activeModelId,
    ifcDataStore: activeModel?.ifcDataStore ?? null,
    geometryResult: activeModel?.geometryResult ?? null,
    ...markupPatch,
  };
}
