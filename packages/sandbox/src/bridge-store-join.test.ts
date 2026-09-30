/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: the bridge calls a real SDK factory and writes a real join. */
import { describe, expect, it } from 'vitest';
import { IfcCreator, addWallToStore, resolveSpatialAnchor, readWallJoinRels } from '@ifc-lite/create';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { createModellingStoreBackend, StoreNamespace, type BimBackend, type BimContext } from '@ifc-lite/sdk';
import { buildStoreNamespace } from './bridge-store.js';

describe('#6232 real wall-join bridge', () => {
  it('commits the relationship and rejects malformed ids/options before the SDK graph changes', async () => {
    const creator = new IfcCreator();
    const storey = creator.addIfcBuildingStorey({ Name: 'Ground floor', Elevation: 0 });
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
    const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
    const anchor = resolveSpatialAnchor(store, storey, view);
    const a = addWallToStore(editor, anchor, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
    const b = addWallToStore(editor, anchor, { Start: [4, 0, 0], End: [4, 3, 0], Thickness: 0.2, Height: 3, Axis: true }).wallId;
    const methods = createModellingStoreBackend(() => ({ modelId: 'm', store, editor, mutationView: view, ownerHistoryId: anchor.ownerHistoryId }));
    const namespace = new StoreNamespace({ store: methods } as unknown as BimBackend);
    // Other context namespaces are irrelevant to this actual store call.
    const sdk = { store: namespace } as unknown as BimContext;
    const method = buildStoreNamespace().methods.find(m => m.name === 'joinWalls')!;
    method.call(sdk, ['m', a, b, { Name: 'Script corner' }], { sandboxSessionId: 'join-test' });
    expect(readWallJoinRels(store, view)[0].name).toBe('Script corner');
    const before = view.getMutations();
    expect(() => method.call(sdk, ['m', 0, b], { sandboxSessionId: 'join-test' })).toThrow(/positive integer/);
    expect(() => method.call(sdk, ['m', a, b, []], { sandboxSessionId: 'join-test' })).toThrow(/options must be an object/);
    expect(view.getMutations()).toEqual(before);
  });
});
