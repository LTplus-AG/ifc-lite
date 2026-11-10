// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { IfcCreator, addWallToStore, resolveSpatialAnchor, readRelatedLists } from '@ifc-lite/create';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { createModellingStoreBackendWithoutStoreys, StoreNamespace, type BimBackend, type BimContext } from '@ifc-lite/sdk';
import { buildStoreNamespace } from './bridge-store.js';

it('#9409 script bridge mirrors and classifies through the real slim SDK factory', async () => {
  const creator = new IfcCreator({ Schema: 'IFC4' });
  const level = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, level, view);
  const wall = (y: number) => addWallToStore(editor, anchor, { Start: [2, y, 0], End: [6, y, 0], Thickness: .2, Height: 3 }).wallId;
  const a = wall(1), b = wall(5);
  const methods = createModellingStoreBackendWithoutStoreys(() => ({ modelId: 'm', store, editor, mutationView: view, ownerHistoryId: anchor.ownerHistoryId }));
  const sdk = { store: new StoreNamespace({ store: methods } as unknown as BimBackend) } as unknown as BimContext;
  const schema = buildStoreNamespace();
  const call = (name: string, args: unknown[]) => {
    const method = schema.methods.find(method => method.name === name);
    expect(method, `script method ${name}`).toBeDefined();
    return method!.call(sdk, args, { sandboxSessionId: 'c5-script-test' });
  };
  expect(call('mirrorElements', ['m', [a], { axis: [[0, 0], [0, 10]] }])).toEqual([{ modelId: 'm', expressId: a }]);
  expect(view.getNewEntities().some(entity => entity.type.toUpperCase() === 'IFCMAPPEDITEM')).toBe(true);
  const classification = call('addClassification', ['m', { System: 'Example', Identification: 'Walls', objects: [a] }]) as { expressId: number };
  call('assignClassification', ['m', classification.expressId, [b, a]]);
  const relations = readRelatedLists(store, 'IfcRelAssociatesClassification', view);
  expect(relations).toHaveLength(1);
  expect(new Set(relations[0].relatedIds)).toEqual(new Set([a, b]));
  const before = view.getMutations();
  expect(() => call('mirrorElements', ['m', [0], { axis: [[0, 0], [0, 10]] }])).toThrow(/positive entity ids/);
  expect(view.getMutations()).toEqual(before);
});
