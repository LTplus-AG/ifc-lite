/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Reload-to-apply for the load-time geometry settings (Merge Multilayer Walls,
 * issue #540, and the Fast/Exact mode). Both only take effect on a re-load, so
 * the active model is re-loaded IN PLACE from the File its record retains
 * (`sourceFile`, set at load time); `loadFile` re-snapshots the settings and
 * re-tessellates.
 */

import { useViewerStore } from '@/store';

export async function reloadActiveModelInPlace(
  loadFile: (file: File) => Promise<void>,
  /** Console tag of the setting being applied. */
  tag: string,
  /** The active model was opened by reference from the processing server. */
  onServerProcessed: () => void,
): Promise<void> {
  const model = useViewerStore.getState().getActiveModel();
  const file = model?.sourceFile;
  if (file) {
    try {
      await loadFile(file);
    } catch (err) {
      console.error(`[${tag}] loadFile threw:`, err);
    }
  } else if (model?.processedModel) {
    // The server made this geometry and no source bytes are here to re-tessellate, so the
    // setting cannot change it. A page reload would drop a model a host opened in code.
    onServerProcessed();
  } else if (typeof window !== 'undefined') {
    // No retained File (e.g. a blank/new model): fall back to a full reload; the setting is persisted.
    console.warn(`[${tag}] no active sourceFile — falling back to window.location.reload()`);
    window.location.reload();
  }
}
