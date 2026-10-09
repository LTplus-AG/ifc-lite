/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { RelationshipType } from '@ifc-lite/data';
import { StepExporter } from '@ifc-lite/export';
import { createGroupStoreBackend } from './group-store-backend.js';
import { StoreNamespace } from './namespaces/store.js';
import type { BimBackend } from './types.js';

async function session() {
  const bytes = readFileSync(new URL('../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const mutationView = new MutablePropertyView(null, 'native');
  const editor = new StoreEditor(store, mutationView);
  const backend = createGroupStoreBackend(modelId => {
    if (modelId !== 'native') throw new Error('Missing native source');
    return { modelId, store, mutationView, editor, ownerHistoryId: null };
  });
  // The facade under test uses only this actual native Store backend, not the other SDK namespaces.
  const facade = new StoreNamespace({ store: backend } as unknown as BimBackend);
  const member = { modelId: 'native', expressId: 1222, GlobalId: store.entities.getGlobalId(1222)! };
  return { store, mutationView, editor, facade, member };
}
it('public Group facade preserves source membership and complete replacement through an independently parsed relationship graph #7329', async () => {
  const { store, mutationView, facade, member } = await session();
  const group = facade.addGroup('native', { Name: 'SDK group', RelatedObjects: [member] });
  const current = facade.readGroup(group);
  expect(current.modelId).toBe('native');
  facade.updateGroup(current, { Name: 'SDK replacement', RelatedObjects: [] });
  const bytes = new StepExporter(store, mutationView).export({ schema: 'IFC4', applyMutations: true }).content;
  const saved = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  expect(saved.entities.getName(group.expressId)).toBe('SDK replacement');
  expect(saved.relationships.getRelated(group.expressId, RelationshipType.AssignsToGroup, 'forward')).toEqual([]);
  expect(saved.entities.getGlobalId(member.expressId)).toBe(member.GlobalId);
  facade.removeGroup(facade.readGroup(group));
  expect(mutationView.getNewEntities().some(row => row.expressId === group.expressId)).toBe(false);
});
it('public Group facade rejects a cross-source member and a mismatched source resolver before any native edit #7329', async () => {
  const { store, mutationView, editor, facade, member } = await session();
  const revision = mutationView.getMutationRevision();
  expect(() => facade.addGroup('native', { Name: 'Foreign', RelatedObjects: [{ ...member, modelId: 'other' }] })).toThrow(/another source/);
  expect(mutationView.getMutationRevision()).toBe(revision);
  expect(mutationView.getNewEntities()).toEqual([]);
  expect(() => facade.addGroup('missing', { Name: 'Missing source', RelatedObjects: [] })).toThrow(/Missing native source/);
  const wrongSource = createGroupStoreBackend(() => ({ modelId: 'native', store, mutationView, editor, ownerHistoryId: null }));
  expect(() => wrongSource.addGroup('other', { Name: 'Wrong resolved source', RelatedObjects: [] })).toThrow(/source ownership changed/);
  expect(mutationView.getMutationRevision()).toBe(revision);
});
