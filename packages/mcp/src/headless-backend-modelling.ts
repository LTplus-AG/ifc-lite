/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Placement and wall joins use the viewer/CLI SDK factory (#6232 D5).
 * Shared compound recording preserves every earlier overlay record for undo. */
import { createModellingStoreBackend, type ModellingStoreModelResolver } from '@ifc-lite/sdk';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';

export function createRecordedModellingBackend(resolve: ModellingStoreModelResolver) {
  type Methods = ReturnType<typeof createModellingStoreBackend>;
  function record<T>(modelId: string, edit: (methods: Methods) => T): T {
    const model = resolve(modelId);
    return recordCompoundMutation(model.mutationView, draft => edit(createModellingStoreBackend(() => ({
      ...model, mutationView: draft, editor: new StoreEditor(model.store, draft),
    }))));
  }
  return {
    addOpening: (...args: Parameters<Methods['addOpening']>) => record(args[0], methods => methods.addOpening(...args)),
    addHostedDoor: (...args: Parameters<Methods['addHostedDoor']>) => record(args[0], methods => methods.addHostedDoor(...args)),
    addHostedWindow: (...args: Parameters<Methods['addHostedWindow']>) => record(args[0], methods => methods.addHostedWindow(...args)),
    joinWalls: (...args: Parameters<Methods['joinWalls']>) => record(args[0], methods => methods.joinWalls(...args)),
  };
}
