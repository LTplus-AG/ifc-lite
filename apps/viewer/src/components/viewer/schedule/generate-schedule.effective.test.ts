/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import {
  FIXTURE_BUILDING,
  FIXTURE_REL_CONTAINED_2,
  FIXTURE_STOREY_1,
  FIXTURE_STOREY_2,
  FIXTURE_WALL_A,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
  guid,
  parseFixtureModel,
} from '@/components/viewer/anonymized-export/anonymized-export-fixture.test-support';
import { DEFAULT_OPTIONS, generateScheduleFromSpatialHierarchy } from './generate-schedule.js';

describe('effective generated schedule (#5249)', () => {
  it('groups edited and authored products by their current storey and building', async () => {
    const store = await parseFixtureModel();
    const view = new MutablePropertyView(store.properties, 'm');
    view.setExpressIdWatermark(88);
    view.deleteEntity(FIXTURE_WALL_B);
    view.setAttribute(FIXTURE_REL_CONTAINED_2, 'RelatingStructure', `#${FIXTURE_STOREY_1}`);
    const storey = view.createEntity('IfcBuildingStorey', [
      guid(89), null, 'Authored storey', null, null, null, null, null, '.ELEMENT.', 6,
    ]);
    view.createEntity('IfcRelAggregates', [
      guid(90), null, null, null, `#${FIXTURE_BUILDING}`, [`#${storey.expressId}`],
    ]);
    const wall = view.createEntity('IfcWall', [guid(91), null, 'Authored wall', null, null, null, null, null]);
    view.createEntity('IfcRelContainedInSpatialStructure', [
      guid(92), null, null, null, [`#${wall.expressId}`], `#${storey.expressId}`,
    ]);
    const part = view.createEntity('IfcBuildingElementPart', [guid(93), null, 'Wall part', null, null, null, null, null]);
    view.createEntity('IfcRelAggregates', [
      guid(94), null, null, null, `#${FIXTURE_WALL_A}`, [`#${part.expressId}`],
    ]);
    const assembly = view.createEntity('IfcElementAssembly', [guid(95), null, 'Direct aggregate', null, null, null, null, null]);
    view.createEntity('IfcRelAggregates', [
      guid(96), null, null, null, `#${FIXTURE_STOREY_1}`, [`#${assembly.expressId}`],
    ]);

    const storeys = generateScheduleFromSpatialHierarchy(store, {
      ...DEFAULT_OPTIONS,
      strategy: 'IfcBuildingStorey',
      startDate: '2024-05-01T08:00:00',
    }, null, view);
    assert.equal(storeys.groupCount, 2, 'empty source storey is skipped');
    assert.deepEqual(storeys.extraction.tasks.map((task) => task.name), ['Storey One', 'Authored storey']);
    assert.deepEqual([...storeys.extraction.tasks[0].productExpressIds].sort((a, b) => a - b),
      [FIXTURE_WALL_A, FIXTURE_WALL_C, part.expressId, assembly.expressId].sort((a, b) => a - b));
    assert.deepEqual(storeys.extraction.tasks[1].productExpressIds, [wall.expressId]);
    assert.ok(storeys.extraction.tasks.every((task) => !task.productExpressIds.includes(FIXTURE_WALL_B)));
    assert.deepEqual(storeys.extraction.tasks[1].productGlobalIds, [guid(91)]);

    const buildings = generateScheduleFromSpatialHierarchy(store, {
      ...DEFAULT_OPTIONS,
      strategy: 'IfcBuilding',
      startDate: '2024-05-01T08:00:00',
    }, null, view);
    assert.equal(buildings.groupCount, 1);
    assert.equal(buildings.extraction.tasks[0].name, 'Building Fixture');
    assert.deepEqual([...buildings.extraction.tasks[0].productExpressIds].sort((a, b) => a - b),
      [FIXTURE_WALL_A, FIXTURE_WALL_C, wall.expressId, part.expressId, assembly.expressId].sort((a, b) => a - b));
    assert.equal(store.spatialHierarchy?.byStorey.get(FIXTURE_STOREY_2)?.includes(FIXTURE_WALL_B), true,
      'the parsed source remains unchanged');
  });
});
