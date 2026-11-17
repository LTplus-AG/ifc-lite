/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { QuantitySet } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { deriveAuthoredBaseQuantities } from './base-quantities.js';

/**
 * Share live authored base quantities between viewer and headless sessions.
 * Source sets retain precedence, including copies of loaded elements. Hosts
 * may supply their source reader (for example, type-object own sets); overlay
 * quantity edits and deletions still apply above this base reader.
 */
export function configureAuthoredQuantityReader(
  dataStore: IfcDataStore,
  mutationView: MutablePropertyView,
  readSource: (entityId: number, view: MutablePropertyView, occurrenceId: number) => QuantitySet[] =
    (entityId, view) => extractQuantitiesOnDemand(dataStore, entityId, view),
): void {
  mutationView.setQuantityExtractor((entityId, view, occurrenceId) => {
    const own = readSource(entityId, view, occurrenceId);
    return own.length > 0 ? own : deriveAuthoredBaseQuantities(dataStore, view, occurrenceId);
  });
}
