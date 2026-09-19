/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { createRemoteOverlayEntity } from './remote-entity-create.js';
import {
  entityForPath, pathForEntity, registerEntityMaps, unregisterEntityPath,
} from './entity-paths.js';

const STEP = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('t.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;', 'DATA;',
  "#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,$);",
  'ENDSEC;', 'END-ISO-10303-21;',
].join('\n');

async function session() {
  const bytes = new TextEncoder().encode(STEP);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const path = '/project';
  registerEntityMaps(store, new Map([[1, path]]), new Map([[path, 1]]));
  return { store, view: new MutablePropertyView(store.properties, 'm'), path };
}

describe('remote collaboration entity re-add (#5018 review)', () => {
  it('restores a remotely deleted source entity at its original expressId', async () => {
    const { store, view, path } = await session();
    view.deleteEntity(1);
    unregisterEntityPath(store, 1);

    // STEP roots can still derive their canonical GUID path from the source;
    // the important durable half is path -> original expressId.
    assert.equal(pathForEntity(store, 1), '/0proj00000000000000000');
    assert.equal(entityForPath(store, path), 1, 'the reverse identity survives a delete for undo');
    assert.equal(createRemoteOverlayEntity(store, view, path, 'IfcProject', {
      'bsi::ifc::prop::Name': 'Restored',
    }), true);
    assert.equal(view.isDeleted(1), false);
    assert.equal(pathForEntity(store, 1), path);
    assert.equal(view.getPositionalMutationsForEntity(1)?.get(2), 'Restored');
    assert.equal(view.getNewEntities().length, 0, 'a source record must not be recreated under a new overlay id');
  });

  it('restores a remotely created overlay entity at its stable expressId', async () => {
    const { store, view } = await session();
    const path = '/cost-value';
    assert.equal(createRemoteOverlayEntity(store, view, path, 'IfcCostValue', {
      'bsi::ifc::prop::Name': 'Value',
    }), true);
    const createdId = entityForPath(store, path);
    assert.ok(createdId);
    view.deleteEntity(createdId);
    unregisterEntityPath(store, createdId);

    assert.equal(createRemoteOverlayEntity(store, view, path, 'IfcCostValue', {
      'bsi::ifc::prop::Name': 'Value',
    }), true);
    assert.equal(entityForPath(store, path), createdId);
    assert.equal(view.isDeleted(createdId), false);
    assert.equal(view.getNewEntity(createdId)?.expressId, createdId);
  });
});
