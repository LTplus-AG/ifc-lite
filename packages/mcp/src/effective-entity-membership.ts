/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Adapt the MCP session overlay to the shared effective-entity boundary. */
import type { EffectiveEntityOverlay } from '@ifc-lite/data';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { PendingOverlay } from './overlay.js';

export function pendingEntityMembership(overlay: PendingOverlay | null): EffectiveEntityOverlay | null {
  if (!overlay) return null;
  return {
    isDeleted: (id) => overlay.deleted.has(id),
    getTombstones: () => overlay.deleted,
    getTypeMutations: () => overlay.getTypeMutations?.() ?? overlay.typeMutations?.() ?? new Map<number, { newType: string }>(),
    getNewEntities: () => overlay.createdAll.map((entity) => ({ expressId: entity.expressId, type: entity.ifcType })),
    getNewEntity: (id) => {
      const entity = overlay.createdEntity(id);
      return entity ? { type: entity.ifcType } : null;
    },
  };
}

/** IFCX has columnar rows but no STEP type buckets; give the shared iterator its source domain. */
export function effectiveSourceIds(store: IfcDataStore): Iterable<number> | undefined {
  // @raw-entity-enumeration-ok detect an indexless IFCX source; its columnar IDs are passed through the canonical accessor
  return store.entityIndex.byType.size === 0 ? store.entities.expressId : undefined;
}
