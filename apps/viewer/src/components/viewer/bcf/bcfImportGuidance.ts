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

/**
 * `readBCF` never throws for a malformed piece of an otherwise-valid
 * archive -- a duplicate topic Guid, an unclaimed `markup.bcf`, a viewpoint
 * that fails to parse -- it reports each drop with `console.warn` and keeps
 * going, so the returned project is missing exactly those pieces with no
 * error for the caller to catch (#5213). BCFPanel's success path used to
 * call `setBcfProject` and stop there: a truncated import and a complete
 * one produced the identical success toast, and the only signal was a
 * devtools warning nobody but a developer would see.
 *
 * Called with the number of `console.warn` calls `readBCF` made during the
 * import (captured by the caller around that one call, so this can only
 * ever reflect readBCF's own drops, never unrelated console output).
 */
export function warnIfImportTruncated(readWarningCount: number): void {
  if (readWarningCount > 0) {
    toast.error(
      `BCF import finished, but ${readWarningCount} ${readWarningCount === 1 ? 'item was' : 'items were'} ` +
        'skipped -- some topics or viewpoints could not be read. See the browser console for details.',
    );
  }
}
