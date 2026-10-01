/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';

/** happy-dom supplies window, so the browser loader cannot read a file URL.
 * Initialize the actual compiled backend once; never mock serialization.
 */
export async function initializeIonExportWasm(): Promise<void> {
  const { initSync } = await import('@ifc-lite/wasm');
  initSync({ module: await readFile(new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url)) });
}
