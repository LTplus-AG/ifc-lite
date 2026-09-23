/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { dispatch, parsePlaygroundModel } from './playground-dispatcher.js';

interface Node { expressId: number; name: string; children: Node[] }
function descendants(nodes: Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...descendants(node.children)]);
}

it('Playground spatial reads follow live project, storey, and containment edits (#5249)', async () => {
  const path = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);
  const bytes = new Uint8Array(await readFile(path));
  const model = await parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'hello-wall.ifc');
  const before = await dispatch(model, 'spatial_hierarchy', {});
  assert.equal(before.isError, false);
  const original = before.structured as { tree: Node[]; truncated: boolean };
  assert.equal(original.tree[0].expressId, 1);
  assert.ok(descendants(original.tree).some((node) => node.expressId === 42 && node.name === 'My Storey'));
  assert.equal(original.truncated, false);

  const renamed = await dispatch(model, 'entity_set_attribute', { express_id: 42, attribute: 'Name', value: 'Edited Level' });
  assert.equal(renamed.isError, false);
  const editedTree = (await dispatch(model, 'spatial_hierarchy', {})).structured as { tree: Node[] };
  assert.ok(descendants(editedTree.tree).some((node) => node.expressId === 42 && node.name === 'Edited Level'));
  const chain = (await dispatch(model, 'containment_chain', { express_id: 1222 })).structured as {
    path: Node[]; truncated: boolean;
  };
  assert.ok(chain.path.some((node) => node.expressId === 42 && node.name === 'Edited Level'));
  assert.equal(chain.truncated, false);
  const groups = (await dispatch(model, 'count_entities', { group_by: 'storey', type: 'IfcWall' })).structured as {
    groups: Array<{ key: string; count: number }>;
  };
  assert.ok(groups.groups.some((group) => group.key === 'Edited Level' && group.count > 0));

  const created = await dispatch(model, 'entity_create', {
    type: 'IfcProject', attributes: ['0NewProject00000000000', null, 'New Project'],
  });
  assert.equal(created.isError, false);
  const createdId = (created.structured as { expressId: number }).expressId;
  await dispatch(model, 'entity_delete', { express_id: 1 });
  const live = (await dispatch(model, 'spatial_hierarchy', {})).structured as { tree: Node[] };
  assert.deepEqual(live.tree.map((node) => node.expressId), [createdId]);
});

it('Playground spatial hierarchy reports depth truncation on a real IFC relationship chain (#5249)', async () => {
  const entities = ["#1=IFCPROJECT('0DepthProject000000000',$,'Project',$,$,$,$,$,$);"];
  for (let i = 2; i <= 10; i++) {
    entities.push(`#${i}=IFCBUILDING('0DepthBuilding${String(i).padStart(7, '0')}',$,'Level ${i}',$,$,$,$,$,$,$,$);`);
    entities.push(`#${100 + i}=IFCRELAGGREGATES('0DepthRelation${String(i).padStart(7, '0')}',$,$,$,#${i - 1},(#${i}));`);
  }
  const source = [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', ...entities, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
  const bytes = new TextEncoder().encode(source);
  const model = await parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'depth.ifc');
  const result = await dispatch(model, 'spatial_hierarchy', {});
  assert.equal(result.isError, false);
  assert.match(result.text, /truncated/);
  const hierarchy = result.structured as { tree: Node[]; truncated: boolean };
  assert.equal(hierarchy.truncated, true);
  const ids = descendants(hierarchy.tree).map((node) => node.expressId);
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7]);
});
