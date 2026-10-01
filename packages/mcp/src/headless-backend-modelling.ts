/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ordinary creation, placement and wall joins use the shared SDK factories (#6232 D5).
 * Shared compound recording preserves every earlier overlay record for undo. */
import { createModellingStoreBackend, createOrdinaryStoreBackend, type ModellingStoreModelResolver } from '@ifc-lite/sdk';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';

export function createRecordedModellingBackend(resolve: ModellingStoreModelResolver) {
  type Methods = ReturnType<typeof createModellingStoreBackend> & ReturnType<typeof createOrdinaryStoreBackend>;
  function record<T>(modelId: string, edit: (methods: Methods) => T): T {
    const model = resolve(modelId);
    return recordCompoundMutation(model.mutationView, draft => {
      const resolveDraft = () => ({ ...model, mutationView: draft, editor: new StoreEditor(model.store, draft) });
      return edit({ ...createModellingStoreBackend(resolveDraft), ...createOrdinaryStoreBackend(resolveDraft) });
    });
  }
  return {
    addOpening: (...args: Parameters<Methods['addOpening']>) => record(args[0], methods => methods.addOpening(...args)),
    addHostedDoor: (...args: Parameters<Methods['addHostedDoor']>) => record(args[0], methods => methods.addHostedDoor(...args)),
    addHostedWindow: (...args: Parameters<Methods['addHostedWindow']>) => record(args[0], methods => methods.addHostedWindow(...args)),
    joinWalls: (...args: Parameters<Methods['joinWalls']>) => record(args[0], methods => methods.joinWalls(...args)),
    addWall: (...args: Parameters<Methods['addWall']>) => record(args[0], methods => methods.addWall(...args)),
    addColumn: (...args: Parameters<Methods['addColumn']>) => record(args[0], methods => methods.addColumn(...args)),
    addSlab: (...args: Parameters<Methods['addSlab']>) => record(args[0], methods => methods.addSlab(...args)),
    addBeam: (...args: Parameters<Methods['addBeam']>) => record(args[0], methods => methods.addBeam(...args)),
    addSpace: (...args: Parameters<Methods['addSpace']>) => record(args[0], methods => methods.addSpace(...args)),
    addRoof: (...args: Parameters<Methods['addRoof']>) => record(args[0], methods => methods.addRoof(...args)),
    addPlate: (...args: Parameters<Methods['addPlate']>) => record(args[0], methods => methods.addPlate(...args)),
    addMember: (...args: Parameters<Methods['addMember']>) => record(args[0], methods => methods.addMember(...args)),
  };
}
