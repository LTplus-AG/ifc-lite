/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The per-model session state that lives outside the store, released when its
 * model leaves: appearance assets and the 2D markup snapshots
 * (`liveMarkupCache`). Model ids are reused (`room:<id>`, explicit flow ids),
 * so either one outliving its model is handed to the next model given that id.
 *
 * These are side effects, so they run in the entry points rather than in a
 * teardown (a teardown is a pure patch, see `store/teardown.ts`), and they run
 * AFTER the entry point's `set`: that `set` applies the markup transition,
 * which snapshots the removed model's markup when it was the active one.
 * Released before it, the snapshot would be written straight back.
 */

import { modelAppearanceAssets } from '../../lib/appearance/model-assets.js';
import { forgetLiveMarkup } from './drawing2DSlice.markupTransition.js';

/** After `removeModel`'s `set`: release `modelId`'s session state. */
export function releaseRemovedModelSession(modelId: string): void {
  modelAppearanceAssets.remove(modelId);
  forgetLiveMarkup(modelId);
}

/** After `clearAllModels`' `set`: release every model's session state. */
export function releaseAllModelSessions(): void {
  modelAppearanceAssets.clear();
  forgetLiveMarkup();
}
