// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { IfcCreator, addWallToStore, resolveSpatialAnchor } from '@ifc-lite/create';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcParser, resolveEffectiveEntityRecord } from '@ifc-lite/parser';
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
  const relations = view.getNewEntities().filter(entity => entity.type.toUpperCase() === 'IFCRELASSOCIATESCLASSIFICATION');
  expect(relations).toHaveLength(1);
  const rel = relations[0];
  const effective = resolveEffectiveEntityRecord(rel, {
    retype: view.getEntityTypeMutation(rel.expressId)?.newType,
    named: view.getAttributeMutationsForEntity(rel.expressId).map(({ name, value }) => [name, value] as const),
    positional: view.getPositionalMutationsForEntity(rel.expressId) ?? [],
  }, store.schemaVersion);
  expect(new Set(effective.attributes[effective.names.indexOf('RelatedObjects')] as string[])).toEqual(new Set([`#${a}`, `#${b}`]));
  const before = view.getMutations();
  expect(() => call('mirrorElements', ['m', [0], { axis: [[0, 0], [0, 10]] }])).toThrow(/positive entity ids/);
  expect(view.getMutations()).toEqual(before);
});
