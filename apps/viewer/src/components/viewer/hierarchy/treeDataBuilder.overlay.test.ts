/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The "By Class", "By Type" and "Groups" trees show the model as edited
 * (#5249). A wall deleted this session must disappear (its mesh is pruned, so
 * it used to drop into the grayed "Other" bucket instead), and a retyped wall
 * must be listed under its new class. Real parsed IFC and a real
 * `MutablePropertyView`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import type { TreeNode } from './types';
import { buildGroupTree, buildIfcTypeTree, buildTypeTree } from './treeDataBuilder';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);
#11=IFCWALL('0Wall00000000000000011',$,'Wall B',$,$,$,$,$,$);
#12=IFCWALL('0Wall00000000000000012',$,'Wall C',$,$,$,$,$,$);
#20=IFCWALLTYPE('0Type00000000000000020',$,'WT-1',$,$,$,$,$,$,.STANDARD.);
#21=IFCRELDEFINESBYTYPE('0Rel000000000000000021',$,$,$,(#10,#11,#12),#20);
#30=IFCGROUP('0Grp000000000000000030',$,'Group 1',$,$);
#31=IFCRELASSIGNSTOGROUP('0Rel000000000000000031',$,$,$,(#10,#11),$,#30);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(FIXTURE).buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** Every express id anywhere in the tree, by node name (fully expanded). */
function idsByName(nodes: TreeNode[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const n of nodes) {
    const ids = out.get(n.name) ?? new Set<number>();
    for (const id of n.expressIds ?? []) ids.add(id);
    out.set(n.name, ids);
  }
  return out;
}

const ALL = new Set<string>(['type-IfcWall', 'type-IfcColumn', 'type-group-other']);

/** A session that deleted Wall B and retyped Wall C to IfcColumn. The viewer
 *  prunes a deleted entity's mesh, so its id leaves the geometry set too. */
async function edited() {
  const ds = await parse();
  const view = new MutablePropertyView(null, 'legacy');
  view.deleteEntity(11);
  view.setEntityType(12, 'IfcColumn', null, 'IfcWall');
  return { ds, view, geometric: new Set([10, 12]) };
}

describe('model tree over the edited model (#5249)', () => {
  it('control: unedited, all three walls are listed as walls', async () => {
    const ds = await parse();
    const nodes = buildTypeTree(new Map(), ds, ALL, false, new Set([10, 11, 12]));
    assert.deepEqual([...(idsByName(nodes).get('IfcWall') ?? [])].sort(), [10, 11, 12]);
  });

  it('By Class: the deleted wall is gone (not in "Other"), the retyped one is a column', async () => {
    const { ds, view, geometric } = await edited();
    const nodes = buildTypeTree(new Map(), ds, ALL, false, geometric, [], undefined, () => view);
    const byName = idsByName(nodes);
    const every = new Set(nodes.flatMap((n) => n.expressIds ?? []));
    assert.equal(every.has(11), false, 'a deleted wall is listed nowhere, not even under Other');
    assert.deepEqual([...(byName.get('IfcWall') ?? [])], [10]);
    assert.ok(byName.get('IfcColumn')?.has(12), 'the retyped wall is listed as a column');
  });

  it('By Type: the deleted occurrence is dropped from its type', async () => {
    const { ds, view, geometric } = await edited();
    const nodes = buildIfcTypeTree(new Map(), ds, new Set(nodes0(ds)), false, geometric, undefined, () => view);
    const every = new Set(nodes.flatMap((n) => n.expressIds ?? []));
    assert.equal(every.has(11), false);
    assert.ok(every.has(10));
  });

  it('Groups: the deleted member is dropped from its group', async () => {
    const { ds, view, geometric } = await edited();
    const collapsed = buildGroupTree(new Map(), ds, new Set(), false, geometric, 'all', () => view);
    const group = collapsed.find((n) => n.name.includes('Group 1'));
    assert.ok(group, 'the group is listed');
    // Expanded, so member rows are emitted (a collapsed group shows none).
    const nodes = buildGroupTree(new Map(), ds, new Set([group.id]), false, geometric, 'all', () => view);
    assert.ok(nodes.length > collapsed.length, 'expanding the group emits member rows');
    const every = new Set(nodes.flatMap((n) => [...(n.expressIds ?? []), ...(n.globalIds ?? [])]));
    assert.equal(every.has(11), false);
    assert.ok(every.has(10));
  });
});

/** Expand every node of the unedited By Type tree so occurrence rows exist. */
function nodes0(ds: IfcDataStore): string[] {
  const ids: string[] = [];
  let expanded = new Set<string>();
  for (let depth = 0; depth < 4; depth++) {
    const nodes = buildIfcTypeTree(new Map(), ds, expanded, false, new Set([10, 11, 12]));
    for (const n of nodes) ids.push(n.id);
    expanded = new Set(ids);
  }
  return ids;
}
