/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser } from '@ifc-lite/parser';
import { createRemoteOverlayEntity } from './remote-entity-create.js';
import { entityForPath } from './entity-paths.js';
import { deleteRemoteOverlayEntity } from './remote-entity-delete.js';

const MODEL = `ISO-10303-21;
HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('m','2026',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;
DATA;#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCCARTESIANPOINT((1.,2.,3.));ENDSEC;END-ISO-10303-21;`;

test('remote entity creation preserves path identity and rejects invalid IFC classes (#5008)', async () => {
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(MODEL).buffer as ArrayBuffer);
  const view = new MutablePropertyView(store.properties, 'room');
  const path = '/m0/0000000000000000000002';

  assert.equal(createRemoteOverlayEntity(store, view, path, 'DefinitelyNotIfc', {}), false);
  assert.equal(view.getNewEntities().length, 0);

  assert.equal(createRemoteOverlayEntity(store, view, path, 'IfcWall', { Name: 'Remote wall' }), true);
  const created = view.getNewEntities()[0];
  assert.equal(created.attributes[0], '0000000000000000000002');
  assert.equal(entityForPath(store, path), created.expressId);

  assert.equal(deleteRemoteOverlayEntity(store, undefined, created.expressId), false);
  assert.equal(entityForPath(store, path), created.expressId, 'missing view must retain the resolvable path');
  assert.equal(deleteRemoteOverlayEntity(store, view, created.expressId), true);
  assert.equal(view.isDeleted(created.expressId), true);
  assert.equal(entityForPath(store, path), null);

  const newEntityCount = view.getNewEntities().length;
  const sourcePath = '/m0/ifc-lite-ref-2';
  assert.equal(createRemoteOverlayEntity(store, view, sourcePath, 'IfcCartesianPoint', {
    'bsi::ifc::prop::Coordinates': [4, 5, 6],
  }), true);
  assert.equal(entityForPath(store, sourcePath), 2);
  assert.equal(
    view.getNewEntities().length,
    newEntityCount,
    'materialization binds the existing source instead of duplicating it',
  );
});
