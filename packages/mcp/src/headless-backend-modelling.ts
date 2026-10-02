/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Ordinary creation, placement and wall joins use the shared SDK factories (#6232 D5).
 * Shared compound recording preserves every earlier overlay record for undo. */
import { createModellingStoreBackend, createOrdinaryStoreBackend, resolveLiveOwnerHistoryId, type ModellingStoreModelResolver } from '@ifc-lite/sdk';
import { recordCompoundMutation, StoreEditor } from '@ifc-lite/mutations';

export function createRecordedModellingBackend(resolve: ModellingStoreModelResolver) {
  type Methods = ReturnType<typeof createModellingStoreBackend> & ReturnType<typeof createOrdinaryStoreBackend>;
  function record<T>(modelId: string, edit: (methods: Methods) => T, authoring = false): T {
    const model = resolve(modelId);
    return recordCompoundMutation(model.mutationView, draft => {
      const resolveDraft = () => {
        const editor = new StoreEditor(model.store, draft);
        return { ...model, mutationView: draft, editor,
          // Only type/material authoring needs this schema-required reference.
          // Ordinary and hosted creation keep their existing anchor policy.
          ownerHistoryId: authoring ? resolveLiveOwnerHistoryId(model.store, editor, draft) : model.ownerHistoryId,
        };
      };
      return edit({ ...createModellingStoreBackend(resolveDraft), ...createOrdinaryStoreBackend(resolveDraft) });
    });
  }
  return {
    removeStair: (ref: Parameters<NonNullable<Methods['removeStair']>>[0]) => record(ref.modelId, methods => {
      const remove = methods.removeStair;
      if (!remove) throw new Error('bim.store.removeStair is not supported by this backend');
      return remove(ref);
    }),
    addStair: (...args: Parameters<NonNullable<Methods['addStair']>>) => record(args[0], methods => {
      const create = methods.addStair;
      if (!create) throw new Error('bim.store.addStair is not supported by this backend');
      return create(...args);
    }),
    addRailing: (...args: Parameters<NonNullable<Methods['addRailing']>>) => record(args[0], methods => {
      const create = methods.addRailing;
      if (!create) throw new Error('bim.store.addRailing is not supported by this backend');
      return create(...args);
    }),
    addElementType: (...args: Parameters<Methods['addElementType']>) => record(args[0], methods => methods.addElementType(...args), true),
    assignType: (...args: Parameters<Methods['assignType']>) => record(args[0], methods => methods.assignType(...args), true),
    addMaterial: (...args: Parameters<Methods['addMaterial']>) => record(args[0], methods => methods.addMaterial(...args), true),
    addMaterialLayerSet: (...args: Parameters<Methods['addMaterialLayerSet']>) => record(args[0], methods => methods.addMaterialLayerSet(...args), true),
    addMaterialLayerSetUsage: (...args: Parameters<Methods['addMaterialLayerSetUsage']>) => record(args[0], methods => methods.addMaterialLayerSetUsage(...args), true),
    assignMaterial: (...args: Parameters<Methods['assignMaterial']>) => record(args[0], methods => methods.assignMaterial(...args), true),
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
