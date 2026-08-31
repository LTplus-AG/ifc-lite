/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Row-building for the command palette's `export:json` entry — pulled out of
 * `CommandPalette.tsx` (already at its module-size budget) so it can be
 * exercised without mounting the palette's React tree.
 *
 * Routes `type` through `@ifc-lite/data`'s `exactTypeName()`, the same
 * accessor #3475 put behind the Lists Class column
 * (`apps/viewer/src/lib/lists/adapter.ts`) and the Parquet `Type` column
 * (#3325) after both were caught naming the `IfcTypeEnum`-coalesced family
 * instead of the class an entity's STEP line actually declares
 * (`IFCDOORSTANDARDCASE` reporting as `IfcDoor`). This JSON export path was
 * a third, independent caller still reading `EntityTable.getTypeName`
 * directly (#3503).
 */

import { exactTypeName } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';

export function buildCommandPaletteJsonEntities(d: IfcDataStore): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < d.entities.count; i++) {
    const id = d.entities.expressId[i];
    out.push({
      expressId: id,
      globalId: d.entities.getGlobalId(id),
      name: d.entities.getName(id),
      type: exactTypeName(d.entities, id),
      properties: d.properties.getForEntity(id),
    });
  }
  return out;
}
