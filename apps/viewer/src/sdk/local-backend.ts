/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createExportAdapter } from './adapters/export-adapter.js';
import type { StoreApi } from './adapters/types.js';
import { LocalBackendCore } from './local-backend-core.js';

/** Standalone SDK contexts expose the synchronous STEP exporter immediately. */
export class LocalBackend extends LocalBackendCore {
  constructor(store: StoreApi) {
    super(store, createExportAdapter(store));
  }
}
