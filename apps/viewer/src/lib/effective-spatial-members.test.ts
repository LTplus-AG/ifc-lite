/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { effectiveSpatialMemberIds } from '@ifc-lite/parser';
import {
  FIXTURE_REL_CONTAINED_2,
  FIXTURE_SITE,
  FIXTURE_STOREY_1,
  FIXTURE_STOREY_2,
  FIXTURE_WALL_A,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
  guid,
  parseFixtureModel,
} from '@/components/viewer/anonymized-export/anonymized-export-fixture.test-support';
import { effectiveSpatialMembers } from './effective-spatial-members.js';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';

describe('effective spatial members (#5249)', () => {
  it('folds deleted, created, and retargeted containment for one model only', async () => {
    const store = await parseFixtureModel();
    const view = new MutablePropertyView(null, 'edited');
    view.setExpressIdWatermark(88);
    view.deleteEntity(FIXTURE_WALL_B);
    view.setAttribute(FIXTURE_REL_CONTAINED_2, 'RelatingStructure', `#${FIXTURE_STOREY_1}`);
    const created = view.createEntity('IfcWall', [guid(89), null, 'New Wall', null, null, null, null, null]);
    view.createEntity('IfcRelContainedInSpatialStructure', [
      guid(90), null, null, null, [`#${created.expressId}`], `#${FIXTURE_SITE}`,
    ]);

    assert.deepEqual(effectiveSpatialMembers(store, view, FIXTURE_STOREY_1), [FIXTURE_WALL_A, FIXTURE_WALL_C]);
    assert.deepEqual(effectiveSpatialMembers(store, view, FIXTURE_STOREY_2), []);
    assert.deepEqual(effectiveSpatialMembers(store, view, FIXTURE_SITE), [created.expressId]);
    assert.deepEqual(effectiveSpatialMembers(store, null, FIXTURE_STOREY_2), [FIXTURE_WALL_B, FIXTURE_WALL_C]);
  });

  it('drops deleted relationships and spatial children from direct members', async () => {
    const store = await parseFixtureModel();
    const view = new MutablePropertyView(null, 'edited');
    view.setExpressIdWatermark(88);
    view.deleteEntity(FIXTURE_REL_CONTAINED_2);
    const space = view.createEntity('IfcSpace', [guid(91), null, 'Space', null, null, null, null, null]);
    view.createEntity('IfcRelContainedInSpatialStructure', [
      guid(92), null, null, null, [`#${space.expressId}`, `#${FIXTURE_WALL_A}`], `#${FIXTURE_STOREY_2}`,
    ]);

    assert.deepEqual(effectiveSpatialMembers(store, view, FIXTURE_STOREY_2), [FIXTURE_WALL_A]);
    assert.deepEqual(effectiveSpatialMemberIds(store, FIXTURE_STOREY_2, {
      relationships: effectiveMutationRelationships(store, view),
      isDeleted: (id) => view.isDeleted(id),
      typeName: (id) => id === space.expressId ? 'IFCSPACE' : store.entities.getTypeName(id),
    }), [FIXTURE_WALL_A], 'an uppercase overlay type must still be treated as a spatial child');
  });
});
