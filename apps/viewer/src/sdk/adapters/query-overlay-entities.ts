/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `queryEntities()`'s overlay-creation fold. This session's overlay-only
 * entities matching a query's type criteria, built off the SAME
 * `getEntityData` seam `getEntityData` itself uses for its own created-entity
 * case (`query-adapter.ts`'s `getEntityData`) — so the effective class (a
 * queued retype wins) and name-relaid attributes match what export writes,
 * without re-deriving that logic here. Matches
 * `packages/cli/src/query-overlay.ts`'s `foldNewEntities`.
 */

import type { EntityData, EntityRef } from '@ifc-lite/sdk';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { expandTypes } from '@ifc-lite/parser';

export function foldOverlayCreatedEntities(
  view: MutablePropertyView | null,
  modelId: string,
  types: string[] | undefined,
  schemaVersion: string,
  isProductType: (upperType: string) => boolean,
  getEntityData: (ref: EntityRef) => EntityData | null,
): EntityData[] {
  if (!view) return [];
  const wantedTypes = types && types.length > 0 ? new Set(expandTypes(types, schemaVersion)) : null;
  const out: EntityData[] = [];
  for (const created of view.getNewEntities()) {
    if (view.isDeleted(created.expressId)) continue;
    const data = getEntityData({ modelId, expressId: created.expressId });
    if (!data) continue;
    const upperType = data.type.toUpperCase();
    const matches = wantedTypes ? wantedTypes.has(upperType) : isProductType(upperType);
    if (matches) out.push(data);
  }
  return out;
}
