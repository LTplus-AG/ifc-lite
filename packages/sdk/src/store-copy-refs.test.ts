/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9352: `bim.store.copyElements` returns one ref per selected element per
 * transform (the round-0 F4 floor lost its hosted door, one per floor), and a
 * copy whose top could not follow its new storey says so in the result.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { copiedProductsInStore, createCopyContext, readStoreyInventory, writeTopAttachment } from '@ifc-lite/create';
import { createModellingStoreBackend } from './store-modelling-backend.js';
import { createModellingStoreBackendWithoutStoreys } from './store-modelling-backend-without-storeys.js';

const SAMPLE = new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const WALL = 1222;

async function model(factory: typeof createModellingStoreBackendWithoutStoreys) {
  const bytes = readFileSync(SAMPLE);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const resolve = (modelId?: string) => {
    if (modelId !== 'm') throw new Error('Unknown model');
    return { modelId, store, editor, mutationView: view, ownerHistoryId: null };
  };
  return { store, view, editor, backend: factory(resolve), addStorey: createModellingStoreBackend(resolve).addStorey! };
}

for (const factory of [createModellingStoreBackend, createModellingStoreBackendWithoutStoreys]) {
describe.skipIf(!existsSync(SAMPLE))(`bim.store copies return the whole selection (#9352/#9407) via ${factory.name}`, () => {
  it('a window selected with its wall comes back as its own copy for every transform', async () => {
    const { store, editor, backend } = await model(factory);
    const selection = copiedProductsInStore(createCopyContext(store, editor), [WALL]);
    expect(selection).toHaveLength(3);
    const refs = backend.copyElements!('m', selection, [{ offset: [0, 3, 0] }, { offset: [0, 6, 0] }]);
    expect(refs).toHaveLength(6);
    expect(new Set(refs.map((ref) => ref.expressId)).size).toBe(6);
    const arrayed = backend.arrayElements!('m', selection, { mode: 'linear', count: 3, anchor: [0, 0], cursor: [0, 2], distance: 2 });
    expect(arrayed).toHaveLength(6);
  });

  it('a copy left fixed is listed on its ref, per storey', async () => {
    const { store, view, backend, addStorey } = await model(factory);
    const upper = addStorey('m', { Name: 'Level 2', Elevation: 3 });
    const top = addStorey('m', { Name: 'Level 3', Elevation: 7 });
    const guid = readStoreyInventory(store, view).storeys.find((s) => s.expressId === upper.expressId)!.GlobalId;
    writeTopAttachment(view, WALL, guid, 'relative');
    // Level 2 to Level 3 is 4 m: the copy needs a new height, which the file wall's body cannot take.
    const [onUpper, onTop] = backend.copyToStoreys!('m', [WALL], [upper.expressId, top.expressId]);
    expect(onUpper.refs).toEqual([{ modelId: 'm', expressId: expect.any(Number), unattachedTops: [{ expressId: onUpper.refs[0].expressId, reason: expect.stringMatching(/keeps its height and is no longer attached/) }] }]);
    expect(onTop.refs[0].unattachedTops).toBeUndefined();
    const [copied] = backend.copyElements!('m', [WALL], [{ targetStoreyId: upper.expressId }]);
    expect(copied.unattachedTops).toHaveLength(1);
  });
});

}
