/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deriveHeaderFiles } from './bcfHeaderFiles';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { FederatedModel } from '@/store/types';

/** Minimal IfcDataStore whose project resolves to `projectGuid` (or none). */
function fakeStore(projectExpressId: number | undefined, projectGuid = ''): IfcDataStore {
  return {
    spatialHierarchy: projectExpressId === undefined ? undefined : { project: { expressId: projectExpressId } },
    entities: { getGlobalId: (id: number) => (id === projectExpressId ? projectGuid : '') },
  } as unknown as IfcDataStore;
}

function fakeModel(name: string, store: IfcDataStore | null): FederatedModel {
  return { id: name, name, ifcDataStore: store } as unknown as FederatedModel;
}

describe('deriveHeaderFiles', () => {
  it('builds one header file per distinct model with name + project guid', () => {
    const models = new Map<string, FederatedModel>([
      ['m1', fakeModel('arch.ifc', fakeStore(1, '0ARCHPROJECTGUID000000'))],
      ['m2', fakeModel('struct.ifc', fakeStore(2, '0STRUCTPROJECTGUID0000'))],
    ]);

    const files = deriveHeaderFiles(['m1', 'm2'], models, null, '2026-07-04T00:00:00Z');
    assert.equal(files.length, 2);
    assert.deepEqual(files[0], {
      ifcProject: '0ARCHPROJECTGUID000000',
      isExternal: true,
      filename: 'arch.ifc',
      date: '2026-07-04T00:00:00Z',
      reference: 'arch.ifc',
    });
    assert.equal(files[1].filename, 'struct.ifc');
    assert.equal(files[1].ifcProject, '0STRUCTPROJECTGUID0000');
  });

  it('de-duplicates repeated model ids', () => {
    const models = new Map<string, FederatedModel>([['m1', fakeModel('arch.ifc', fakeStore(1, 'G'))]]);
    const files = deriveHeaderFiles(['m1', 'm1', 'm1'], models, null);
    assert.equal(files.length, 1);
  });

  it('skips model ids that are not loaded', () => {
    const models = new Map<string, FederatedModel>([['m1', fakeModel('arch.ifc', fakeStore(1, 'G'))]]);
    const files = deriveHeaderFiles(['m1', 'missing'], models, null);
    assert.deepEqual(files.map((f) => f.filename), ['arch.ifc']);
  });

  it('leaves ifcProject undefined when the project has no global id', () => {
    const models = new Map<string, FederatedModel>([['m1', fakeModel('arch.ifc', fakeStore(undefined))]]);
    const files = deriveHeaderFiles(['m1'], models, null);
    assert.equal(files[0].ifcProject, undefined);
  });

  it('resolves the legacy single-model id via the fallback store', () => {
    const files = deriveHeaderFiles(['legacy'], new Map(), fakeStore(1, '0LEGACYPROJECTGUID0000'));
    assert.equal(files.length, 1);
    assert.equal(files[0].filename, 'model.ifc');
    assert.equal(files[0].ifcProject, '0LEGACYPROJECTGUID0000');
  });

  it('skips the legacy id when no fallback store is available', () => {
    assert.deepEqual(deriveHeaderFiles(['legacy'], new Map(), null), []);
  });
});
