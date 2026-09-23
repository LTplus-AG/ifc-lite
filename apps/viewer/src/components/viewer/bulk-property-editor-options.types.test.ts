/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Bulk Property Editor's type facets follow the model as edited (#5249).
 * A class that exists only because the session created or retyped an entity
 * into it must be offered, or the engine's effective selection could never be
 * asked for it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcTypeEnum, type EntityTable } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import * as options from './bulk-property-editor-options.js';

// Read through the namespace so a missing export fails an assertion rather
// than the module link (the changed-test oracle reverts production files).
const presentTypeEnums = (options as Record<string, unknown>).presentTypeEnums as
  | ((entities: EntityTable, view: MutablePropertyView | null) => Map<number, string>)
  | undefined;

function walls(): EntityTable {
  return {
    count: 2,
    expressId: [1, 2],
    typeEnum: [IfcTypeEnum.IfcWall, IfcTypeEnum.IfcWall],
    getTypeName: () => 'IfcWall',
  } as unknown as EntityTable;
}

describe('presentTypeEnums (#5249)', () => {
  it('offers the parsed classes when nothing was edited', () => {
    assert.equal(typeof presentTypeEnums, 'function');
    assert.deepEqual([...presentTypeEnums!(walls(), null)], [[IfcTypeEnum.IfcWall, 'IfcWall']]);
  });

  it('offers a class the session created or retyped into, but not one only a deleted creation had', () => {
    assert.equal(typeof presentTypeEnums, 'function');
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(2);
    view.createEntity('IfcColumn', []);
    const gone = view.createEntity('IfcSlab', []).expressId;
    view.deleteEntity(gone);
    view.setEntityType(2, 'IfcBeam', null, 'IfcWall');

    const present = presentTypeEnums!(walls(), view);
    assert.equal(present.get(IfcTypeEnum.IfcColumn), 'IfcColumn');
    assert.equal(present.get(IfcTypeEnum.IfcBeam), 'IfcBeam');
    assert.equal(present.has(IfcTypeEnum.IfcSlab), false);
  });
});
