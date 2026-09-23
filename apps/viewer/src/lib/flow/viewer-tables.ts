/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlowHost.tables()` for the viewer (#5167).
 *
 * `table.joinByKey`'s `tag` and `property` strategies scan the model's entity
 * table once through the SAME matching code `CsvConnector` uses
 * (`@ifc-lite/mutations`' `csv-match`). The CLI provides that table from its
 * headless backend; without this the viewer ran the node and failed at run
 * time. Flow graphs promise to run identically in the viewer and in
 * `ifc-lite flow run`, and a node that only works headless breaks that promise
 * silently for whoever authored the graph in the browser.
 *
 * The mutation view is the one the rest of the viewer edits through
 * (`getOrCreateMutationView`), so a match on a property written earlier in the
 * session sees the written value — the overlay-blind read was a defect class
 * this viewer has already had once (#5170).
 */

import type { FlowHost } from '@ifc-lite/flow-nodes';
import { getModelForRef } from '@/sdk/adapters/model-compat.js';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view.js';
import type { StoreApi } from '@/sdk/adapters/types.js';

export function viewerTableAccess(store: StoreApi): NonNullable<FlowHost['tables']> {
  return (modelId) => {
    const state = store.getState();
    const id = modelId ?? state.activeModelId ?? undefined;
    if (!id) return undefined;
    const dataStore = getModelForRef(state, id)?.ifcDataStore;
    if (!dataStore) return undefined;
    const mutationView = getOrCreateMutationView(store, id);
    if (!mutationView) return undefined;
    return { entities: dataStore.entities, mutationView, strings: dataStore.strings ?? null };
  };
}
