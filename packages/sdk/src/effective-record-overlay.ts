/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CostMutationOverlay, IfcDataStore } from '@ifc-lite/parser';
import { effectiveCreatedRecord, effectiveSourceRecord } from '@ifc-lite/export';
import type { MutablePropertyView } from '@ifc-lite/mutations';

/** Present a mutation view as the records the STEP exporter will write. */
export function createEffectiveRecordOverlay(
  view: MutablePropertyView,
  store: IfcDataStore,
): CostMutationOverlay {
  return {
    isDeleted: id => view.isDeleted(id),
    retypes: () => new Map([...view.getTypeMutations()].map(([id, mutation]) => [id, mutation.newType])),
    effectiveRecord: (id, text, type) => effectiveSourceRecord(view, id, text, type, store.schemaVersion),
    created: () => view.getNewEntities().map(entity => {
      try {
        const effective = effectiveCreatedRecord(view, entity.expressId, store.schemaVersion);
        return effective
          ? { expressId: entity.expressId, ...effective }
          : { expressId: entity.expressId, error: `Created entity #${entity.expressId} disappeared from the mutation overlay` };
      } catch (error) {
        return {
          expressId: entity.expressId,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  };
}
