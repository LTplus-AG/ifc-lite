/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Overlay-visibility helpers for `HeadlessBackend.query` (headless-backend.ts).
 *
 * `StoreEditor.addEntity`/`removeEntity` never touch `store.entityIndex` (the
 * parsed file's immutable index) — writes live only in the
 * `MutablePropertyView` overlay. Without folding that in, a
 * `bim.store.addEntity`/`removeEntity` followed by `bim.query()` in the same
 * session answered about the file as parsed, not as the session had just
 * changed it. `@ifc-lite/mcp`'s parallel backend already folds its overlay
 * into every read (#2004, #2014); this ports the entity add/remove
 * visibility half of that to the CLI via the overlay's own public
 * `getNewEntities()`/`isDeleted()`.
 */

import type { EntityData, EntityRef } from '@ifc-lite/sdk';
import type { MutablePropertyView, NewEntity } from '@ifc-lite/mutations';

function scalarAttr(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '$' || trimmed === '*') return '';
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

/**
 * Slots 0/2/3 are GlobalId/Name/Description on every IfcRoot subtype (the
 * only classes this backend queries). Slot 4 differs by class (ObjectType vs
 * ApplicableOccurrence), so it's left blank rather than misread.
 */
function createdEntityData(entity: Pick<NewEntity, 'expressId' | 'type' | 'attributes'>, modelId: string): EntityData {
  return {
    ref: { modelId, expressId: entity.expressId },
    globalId: scalarAttr(entity.attributes[0]),
    name: scalarAttr(entity.attributes[2]),
    type: entity.type,
    description: scalarAttr(entity.attributes[3]),
    objectType: '',
  };
}

/**
 * `getEntityData(ref)`'s overlay half: `null` means deleted this session,
 * `undefined` means "not in the overlay, fall through to the parsed store".
 */
export function overlayEntityData(view: MutablePropertyView | null, ref: EntityRef): EntityData | null | undefined {
  if (!view) return undefined;
  if (view.isDeleted(ref.expressId)) return null;
  const created = view.getNewEntity(ref.expressId);
  return created ? createdEntityData(created, ref.modelId) : undefined;
}

/** This session's overlay-only entities matching an `entities()` query's type criteria. */
export function foldNewEntities(
  view: MutablePropertyView,
  types: string[] | undefined,
  expandTypes: (types: string[]) => string[],
  isProductType: (upperType: string) => boolean,
  modelId: string,
): EntityData[] {
  const wantedTypes = types && types.length > 0 ? new Set(expandTypes(types)) : null;
  const out: EntityData[] = [];
  for (const created of view.getNewEntities()) {
    if (view.isDeleted(created.expressId)) continue;
    const upperType = created.type.toUpperCase();
    const matches = wantedTypes ? wantedTypes.has(upperType) : isProductType(upperType);
    if (matches) out.push(createdEntityData(created, modelId));
  }
  return out;
}
