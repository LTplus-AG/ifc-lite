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

  it('By Type: a created type appears, while a deleted source type and a created-then-deleted type do not (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.setExpressIdWatermark(31);
    view.deleteEntity(20);
    const created = view.createEntity('IfcWallType', ['0Type00000000000000032', null, 'WT-new']);
    const wall = view.createEntity('IfcWall', ['0Wall00000000000000033', null, 'Wall authored']);
    view.createEntity('IfcRelDefinesByType', ['0Rel000000000000000034', null, null, null,
      [10, wall.expressId], created.expressId]);
    const removed = view.createEntity('IfcWallType', ['0Type00000000000000033', null, 'WT-removed']);
    view.deleteEntity(removed.expressId);

    const nodes = buildIfcTypeTree(
      new Map(), ds, new Set(['typeclass-IfcWallType', `ifctype-legacy-${created.expressId}`]),
      false, new Set([10, 11, 12, wall.expressId]), undefined, () => view,
    );
    const typeRows = nodes.filter((node) => node.type === 'ifc-type');
    assert.deepEqual(typeRows.map((node) => [node.entityExpressId, node.name]), [[created.expressId, 'WT-new']]);
    assert.deepEqual(typeRows[0]?.expressIds, [10, wall.expressId],
      'the authored type binding includes source and created occurrences');
    assert.ok(nodes.some((node) => node.type === 'element' && node.name === 'Wall authored'),
      'the authored occurrence keeps its live Name');
  });

  it('By Type: deleting a source IfcRelDefinesByType removes its occurrence edge (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.deleteEntity(21);
    const nodes = buildIfcTypeTree(new Map(), ds, new Set(['typeclass-IfcWallType']), false,
      new Set([10, 11, 12]), undefined, () => view);
    const typeRow = nodes.find((node) => node.type === 'ifc-type');
    assert.ok(typeRow, 'the type entity itself remains');
    assert.deepEqual(typeRow.expressIds, [], 'a deleted relationship contributes no occurrences');
  });

  it('By Type: editing the source type binding replaces its parsed edges (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.setPositionalAttribute(21, 4, [12], true);
    const nodes = buildIfcTypeTree(new Map(), ds, new Set(['typeclass-IfcWallType']), false,
      new Set([10, 11, 12]), undefined, () => view);
    const typeRow = nodes.find((node) => node.type === 'ifc-type');
    assert.ok(typeRow);
    assert.deepEqual(typeRow.expressIds, [12], 'old parsed members do not survive the edited RelatedObjects');
  });

  it('By Type: named STEP-reference edits move source members to an authored type (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.setExpressIdWatermark(31);
    const created = view.createEntity('IfcWallType', ['0Type00000000000000032', null, 'WT-renamed-target']);
    view.setAttribute(21, 'RelatedObjects', '#12');
    view.setAttribute(21, 'RelatingType', `#${created.expressId}`);
    const nodes = buildIfcTypeTree(new Map(), ds, new Set(['typeclass-IfcWallType']), false,
      new Set([10, 11, 12]), undefined, () => view);
    const typeRows = nodes.filter((node) => node.type === 'ifc-type');
    assert.deepEqual(typeRows.map((node) => ({ id: node.entityExpressId, ids: node.expressIds }))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
      [{ id: 20, ids: [] }, { id: created.expressId, ids: [12] }],
      'named reference edits replace both source endpoints');
  });

  it('By Type: explicitly clearing Name uses the id label instead of the parsed name (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.setAttribute(20, 'Name', '');
    view.setPositionalAttribute(10, 2, '');
    const nodes = buildIfcTypeTree(new Map(), ds, new Set(nodes0(ds)), false,
      new Set([10, 11, 12]), undefined, () => view);
    assert.equal(nodes.find(node => node.type === 'ifc-type' && node.entityExpressId === 20)?.name, '#20');
    assert.equal(nodes.find(node => node.type === 'element' && node.expressIds?.includes(10))?.name, '#10');
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

  it('Groups: an authored group and assignment render with authored and source members (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.setExpressIdWatermark(31);
    const group = view.createEntity('IfcGroup', ['0Grp000000000000000032', null, 'Authored group']);
    const wall = view.createEntity('IfcWall', ['0Wall00000000000000033', null, 'Authored wall']);
    view.createEntity('IfcRelAssignsToGroup', ['0Rel000000000000000034', null, null, null,
      [10, wall.expressId], null, group.expressId]);
    const expanded = new Set([`group-legacy-${group.expressId}`]);
    const nodes = buildGroupTree(new Map(), ds, expanded, false, new Set([10]), 'all', () => view);
    const groupRow = nodes.find(node => node.entityExpressId === group.expressId);
    assert.equal(groupRow?.name, 'Authored group');
    assert.deepEqual(nodes.filter(node => node.type === 'group-member'
      && node.id.startsWith(`groupmember-legacy-${group.expressId}-`))
      .map(node => node.expressIds?.[0]).sort((a, b) => (a ?? 0) - (b ?? 0)),
    [10, wall.expressId]);
  });

  it('Groups: rewritten assignment moves members to its effective group (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.setExpressIdWatermark(31);
    const group = view.createEntity('IfcGroup', ['0Grp000000000000000032', null, 'Moved group']);
    view.setAttribute(31, 'RelatedObjects', '#12');
    view.setAttribute(31, 'RelatingGroup', `#${group.expressId}`);
    const nodes = buildGroupTree(new Map(), ds, new Set([`group-legacy-${group.expressId}`]),
      false, new Set([10, 11, 12]), 'all', () => view);
    assert.equal(nodes.some(node => node.entityExpressId === 30), false,
      'the source group loses the rewritten assignment');
    assert.deepEqual(nodes.filter(node => node.type === 'group-member')
      .map(node => node.expressIds?.[0]), [12]);
  });

  it('Groups: deleting the source assignment removes its group row (#5249)', async () => {
    const ds = await parse();
    const view = new MutablePropertyView(null, 'legacy');
    view.deleteEntity(31);
    assert.deepEqual(buildGroupTree(new Map(), ds, new Set(), false,
      new Set([10, 11]), 'all', () => view), []);
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
