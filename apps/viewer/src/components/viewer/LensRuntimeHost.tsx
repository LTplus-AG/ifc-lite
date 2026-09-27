/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The active lens's scene effect, mounted once for the viewer's lifetime (#5877).
 *
 * A lens stays active after its panel closes: its colours and hides are scene
 * state, not panel state. `useLens` (evaluation plus the sync of the lens's
 * hidden ids into the shared `hiddenEntities` channel) is therefore mounted
 * here, beside the layout, rather than in `LensPanel`, where it stopped the
 * moment the panel unmounted: a model loaded or edited afterwards was never
 * coloured or hidden by the lens that still claimed to be active.
 */

import { useLens } from '@/hooks/useLens';

/** A component rather than a bare `useLens()` in `ViewerLayout`, so a lens
 *  recompute re-renders nothing but this null host. */
export function LensRuntimeHost(): null {
  useLens();
  return null;
}
