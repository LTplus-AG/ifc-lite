/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { createSyntheticDataStore, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor, iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { removeStructuralEntityInStore } from './structural-remove.js';

// #9668 / #9819: metadata-only stores cannot prove ownership of source records.
describe.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s source-less structural removal', schema => {
  it.each(['source', 'overlay'] as const)('names the requested %s entity and missing source before changing anything', target => {
    const store = createSyntheticDataStore({ schemaVersion: schema, fileSize: 0, entities: [
      { expressId: 1, type: 'IfcWall' }, { expressId: 10, type: 'IfcStructuralCurveMember' },
    ] });
    const view = new MutablePropertyView(null, 'metadata-only');
    const editor = new StoreEditor(store, view);
    const id = target === 'source' ? 10
      : editor.addEntity('IfcStructuralLoadSingleForce', ['Force', null, null, -7, null, null, null]).expressId;
    const before = [...iterateEffectiveEntityIds(store, view)].map(e => e.expressId);
    const journalSize = view.getMutationCount();
    expect(() => removeStructuralEntityInStore(store, editor, id))
      .toThrow(new RegExp(`removeStructuralEntity:.*#${id}.*source-less`));
    expect([...iterateEffectiveEntityIds(store, view)].map(e => e.expressId)).toEqual(before);
    expect(view.getMutationCount()).toBe(journalSize);
  });

  it.each([false, true])('still removes readable overlay-only records (deleted source rows=%s)', async deleted => {
    const store = createSyntheticDataStore({ schemaVersion: schema, fileSize: 0,
      entities: deleted ? [{ expressId: 1, type: 'IfcWall' }] : [] });
    const view = new MutablePropertyView(null, 'overlay-only');
    const editor = new StoreEditor(store, view);
    if (deleted) editor.removeEntity(1);
    const load = editor.addEntity('IfcStructuralLoadSingleForce', ['Force', null, null, -7, null, null, null]);
    removeStructuralEntityInStore(store, editor, load.expressId);
    expect([...iterateEffectiveEntityIds(store, view)]).toEqual([]);
    expect(view.getNewEntities()).toEqual([]);
    const { content } = new StepExporter(store, view).export({ schema, applyMutations: true });
    const bytes = new TextEncoder().encode(new TextDecoder().decode(content));
    const parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
    expect(parsed.entityIndex.byId.size).toBe(0);
  });
});
