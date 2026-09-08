/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { toast } from '@/components/ui/toast';

/**
 * Import always succeeds independent of what (if anything) is loaded in the
 * viewport — a BCF's topics reference GlobalIds in the model they were
 * captured from, which `readBCF` never checks. With no model loaded, every
 * viewpoint then silently fails to resolve later (nothing to zoom to or
 * select), with no error to explain why. Called right after a successful
 * import — the one point BCFPanel knows this is true (issue #4099).
 */
export function warnIfNoModelLoaded(loadedModelCount: number): void {
  if (loadedModelCount === 0) {
    toast.info("BCF imported. Load the model this BCF refers to, to view its topics' viewpoints in 3D.");
  }
}
