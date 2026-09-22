/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the data accessor `@ifc-lite/ids` validators consume. Delegates
 * to the shared `@ifc-lite/ids/bridge` so the MCP server, the viewer,
 * and the buildingSMART corpus harness
 * (`packages/ids/src/__corpus__/corpus.test.ts`) all run the same
 * translation logic.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createDataAccessor } from '@ifc-lite/ids/bridge';

/**
 * `mutationView`, when supplied, is consulted for entity visibility only
 * (`getAllEntityIds` excludes tombstones and includes overlay-created
 * entities, #5184) — it satisfies the bridge's `EntityVisibilityView`
 * structurally, no adapter needed. Omitting it reproduces the exact
 * pre-existing behaviour.
 */
export function buildIdsAccessor(
  store: IfcDataStore,
  mutationView?: MutablePropertyView | null
): unknown {
  return createDataAccessor(store, undefined, mutationView ?? undefined);
}
