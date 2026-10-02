/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hierarchy builders must not turn a model-sized array into call
 * arguments. `target.push(...source)` puts every element on the stack, and
 * past roughly 120k elements V8 throws `RangeError: Maximum call stack size
 * exceeded` — inside the HierarchyPanel's `useMemo`, so the whole panel dies.
 *
 * PostHog stack (build 89be760d4eb8, decoded against a rebuild of that commit):
 *   beginWork -> updateFunctionComponent -> renderWithHooks -> HierarchyPanel
 *   -> useHierarchyTree -> useMemo -> buildTreeData -> buildTypeTree
 * with the throw at buildTypeTree's `nodes.push(...buildOtherGroupNodes(...))`.
 *
 * Every case here uses 200k rows: comfortably over the engine's argument
 * limit (Node and Chrome both fail between 125k and 150k), while a loop
 * finishes in well under a second.
 */

// happy-dom first: the tree builder imports the viewer store, whose
// persistence layer reads localStorage at module init.
import '@/test/setup-dom';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EntityFlags, IfcTypeEnum, RelationshipGraphBuilder, RelationshipType, type SpatialNode } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { buildIfcTypeTree, buildTypeTree } from './treeDataBuilder';
import { indexSpatialNodes } from './spatialElements';
import { effectiveTypeAssignments } from './effectiveTypeEntities';
import { effectiveGroupAssignments } from './effectiveGroupEntities';

const ROWS = 200_000;
const WALL_TYPE_ID = 1;
const FIRST_WALL_ID = 10;
/** An id no wall has: the geometry filter is active (the set is non-empty)
 *  and every wall is known to be shapeless, so all of them go to "Other". */
const GEOMETRY_KNOWN_NONE_OF_THE_WALLS = new Set([5]);

/** One IfcWallType typing ROWS geometry-less IfcWalls. Legacy mode, so
 *  globalId === expressId. */
function largeShapelessModel(): IfcDataStore {
  const order = [WALL_TYPE_ID];
  for (let i = 0; i < ROWS; i += 1) order.push(FIRST_WALL_ID + i);
  const relationships = new RelationshipGraphBuilder();
  for (let i = 0; i < ROWS; i += 1) {
    relationships.addEdge(WALL_TYPE_ID, FIRST_WALL_ID + i, RelationshipType.DefinesByType, 3);
  }
  return {
    schemaVersion: 'IFC4',
    spatialHierarchy: undefined,
    entityIndex: { byId: new Map(), byType: new Map() },
    entities: {
      count: order.length,
      expressId: order,
      flags: order.map((id) => (id === WALL_TYPE_ID ? EntityFlags.IS_TYPE : 0)),
      getName: (id: number) => (id === WALL_TYPE_ID ? 'WallType' : `Wall ${id}`),
      getTypeName: (id: number) => (id === WALL_TYPE_ID ? 'IfcWallType' : 'IfcWall'),
    },
    relationships: relationships.build(),
  } as unknown as IfcDataStore;
}

describe('hierarchy builders over model-sized inputs', () => {
  it('By Class lists 200k geometry-less elements under an expanded "Other" bucket', () => {
    const nodes = buildTypeTree(
      new Map(), largeShapelessModel(), new Set(['type-group-other']), false, GEOMETRY_KNOWN_NONE_OF_THE_WALLS,
    );
    const other = nodes.find((n) => n.id === 'type-group-other');
    assert.ok(other, 'the Other bucket exists');
    assert.equal(other.elementCount, ROWS);
    const rows = nodes.filter((n) => n.type === 'element' && n.noGeometry);
    assert.equal(rows.length, ROWS, 'every shapeless wall gets its own grayed row');
    assert.equal(nodes[nodes.length - 1].type, 'element', 'the bucket stays after every class group');
  });

  it('By Type lists 200k geometry-less occurrences under an expanded "Other" bucket', () => {
    const nodes = buildIfcTypeTree(
      new Map(), largeShapelessModel(), new Set(['typeclass-other']), false, GEOMETRY_KNOWN_NONE_OF_THE_WALLS,
    );
    const other = nodes.find((n) => n.id === 'typeclass-other');
    assert.ok(other, 'the Other bucket exists');
    assert.equal(other.elementCount, ROWS);
    assert.equal(nodes.filter((n) => n.type === 'element' && n.noGeometry).length, ROWS);
  });

  it('indexes a spatial node with 200k direct children', () => {
    const children: SpatialNode[] = [];
    for (let i = 0; i < ROWS; i += 1) {
      children.push({ expressId: FIRST_WALL_ID + i, type: IfcTypeEnum.IfcSpace, name: '', children: [], elements: [] });
    }
    const root: SpatialNode = { expressId: 2, type: IfcTypeEnum.IfcBuildingStorey, name: '', children, elements: [] };
    const index = indexSpatialNodes(root);
    assert.equal(index.size, ROWS + 1);
    assert.equal(index.get(FIRST_WALL_ID + ROWS - 1)?.type, IfcTypeEnum.IfcSpace);
  });

  it('indexes an authored type binding and group assignment with 200k members', () => {
    const refs: string[] = [];
    for (let i = 0; i < ROWS; i += 1) refs.push(`#${FIRST_WALL_ID + i}`);
    const view = new MutablePropertyView(null, 'large');
    view.setExpressIdWatermark(FIRST_WALL_ID + ROWS);
    const typeId = view.createEntity('IfcWallType', ['type-guid', null, 'Authored type', null, null, null, null, null, null, '.STANDARD.']).expressId;
    const groupId = view.createEntity('IfcGroup', ['group-guid', null, 'Authored group', null, null]).expressId;
    view.createEntity('IfcRelDefinesByType', ['rel-type-guid', null, null, null, refs, `#${typeId}`]);
    view.createEntity('IfcRelAssignsToGroup', ['rel-group-guid', null, null, null, refs, null, `#${groupId}`]);
    const store = largeShapelessModel();

    const byType = effectiveTypeAssignments(store, view).byType.get(typeId);
    assert.equal(byType?.length, ROWS);
    assert.equal(byType?.[ROWS - 1], FIRST_WALL_ID + ROWS - 1);

    const byGroup = effectiveGroupAssignments(store, view).byGroup.get(groupId);
    assert.equal(byGroup?.length, ROWS);
    assert.equal(byGroup?.[0], FIRST_WALL_ID);
  });
});
