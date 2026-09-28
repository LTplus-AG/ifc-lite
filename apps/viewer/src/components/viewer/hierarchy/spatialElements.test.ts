/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import type { SpatialNode } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { fixtureModel } from '@/test/store-fixture.js';
import {
  FIXTURE_REL_CONTAINED_2,
  FIXTURE_STOREY_1,
  FIXTURE_STOREY_2,
  FIXTURE_WALL_A,
  FIXTURE_WALL_B,
  FIXTURE_WALL_C,
  guid,
  parseFixtureModel,
} from '../anonymized-export/anonymized-export-fixture.test-support.js';
import { getSpatialNodeElements, indexSpatialNodes } from './spatialElements.js';
import { buildTreeData } from './treeDataBuilder.js';

it('hierarchy direct rows follow deleted, created and retargeted containment (#5249)', async () => {
  const store = await parseFixtureModel();
  const nodes = indexSpatialNodes(store.spatialHierarchy!.project);
  const first = nodes.get(FIXTURE_STOREY_1) as SpatialNode;
  const second = nodes.get(FIXTURE_STOREY_2) as SpatialNode;
  const rows = (node: SpatialNode, view: MutablePropertyView | null) =>
    getSpatialNodeElements(node, store, 'IfcBuildingStorey', new Map(), view);
  assert.deepEqual(rows(second, null), [FIXTURE_WALL_B, FIXTURE_WALL_C]);

  const view = new MutablePropertyView(null, 'm1');
  view.setExpressIdWatermark(88);
  view.deleteEntity(FIXTURE_WALL_B);
  const wall = view.createEntity('IfcWall', [guid(89), null, 'New wall', null, null, null, null, null]);
  view.createEntity('IfcRelContainedInSpatialStructure', [
    guid(90), null, null, null, [`#${wall.expressId}`], `#${FIXTURE_STOREY_2}`,
  ]);
  assert.deepEqual(rows(second, view), [FIXTURE_WALL_C, wall.expressId]);

  view.setAttribute(FIXTURE_REL_CONTAINED_2, 'RelatingStructure', `#${FIXTURE_STOREY_1}`);
  assert.deepEqual(rows(first, view), [FIXTURE_WALL_A, FIXTURE_WALL_C]);
  assert.deepEqual(rows(second, view), [wall.expressId]);

  const model = { ...fixtureModel('m1', { idOffset: 0 }), ifcDataStore: store };
  const expanded = new Set(['root-1', 'root-1-2', 'root-1-2-3', 'root-1-2-3-5']);
  const tree = buildTreeData(new Map([['m1', model]]), null, expanded, false, [],
    undefined, undefined, undefined, undefined, () => view);
  assert.ok(tree.some((node) => node.type === 'element' && node.expressIds.includes(wall.expressId)),
    'the authored wall appears in the built spatial tree');
  assert.ok(!tree.some((node) => node.type === 'element' && node.expressIds.includes(FIXTURE_WALL_B)),
    'the tombstoned wall is absent from the built spatial tree');
});
