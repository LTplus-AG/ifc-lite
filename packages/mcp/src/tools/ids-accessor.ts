/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the data accessor `@ifc-lite/ids` validators consume. Delegates
 * to the shared `@ifc-lite/ids/bridge` so the MCP server, the viewer,
 * and the corpus-parity harness all run the same translation logic.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { createDataAccessor } from '@ifc-lite/ids/bridge';

export function buildIdsAccessor(store: IfcDataStore): unknown {
  return createDataAccessor(store);
}
