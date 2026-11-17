// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { parse, session, THIRD_PARTY } from '../__test__/storey-fixtures.oracle.js';
import { readStoreyInventory } from './storey-model.js';
import { planStoreyLevelEdit } from './storey-level-plan.js';
import { applyStoreyLevelEdit } from './storey-level-apply.js';
import { homeStoreyOf, writeTopAttachment } from './storey-attachment.js';
import { addOrdinaryElementInStore } from '../ordinary-element.js';
import { resolveSpatialAnchor } from '../resolve-anchor.js';

it('#10420 an unchanged retained draft keeps its attached wall after a parent Fixed plan', async () => {
  const s = session(await parse(THIRD_PARTY));
  const wall = addOrdinaryElementInStore(s.editor, editor => resolveSpatialAnchor(s.store, 42, editor.getMutationView()), {
    kind: 'wall', params: { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 },
  });
  writeTopAttachment(s.view, wall, '0dwaCbNdz3hA0zHj3Fmq1n');
  const edit = { kind: 'elevation' as const, storeyId: 46, Elevation: 6.5 };
  const plan = (view: typeof s.view) => planStoreyLevelEdit(readStoreyInventory(s.store, view), edit, { dryRun: false });
  expect(plan(s.view).walls.map(row => row.wallId)).toContain(wall);
  const draft = s.view.runAtomic(view => { expect(plan(view).walls.map(row => row.wallId)).toContain(wall); return view; });
  writeTopAttachment(s.view, wall, 'Fixed');
  expect(plan(s.view).walls.map(row => row.wallId)).not.toContain(wall);
  expect(plan(draft).walls.map(row => row.wallId)).toContain(wall);
});

it('#10420 retyping a source containment relationship removes its warmed containment edge', async () => {
  const s = session(await parse(THIRD_PARTY));
  expect(homeStoreyOf(readStoreyInventory(s.store, s.view), 60)).toBe(42);
  s.view.setEntityType(90, 'IfcWall');
  expect(homeStoreyOf(readStoreyInventory(s.store, s.view), 60)).toBeNull();
});

it('#10420 a root-placed product moves when its home storey has no placement', async () => {
  const s = session(await parse(THIRD_PARTY));
  s.view.setPositionalAttribute(42, 5, null);
  s.view.setPositionalAttribute(61, 0, null);
  const edit = { kind: 'elevation' as const, storeyId: 42, Elevation: 3.5 };
  const plan = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), edit, { dryRun: false });
  expect(plan.moved).toContain(60);
  expect(plan.placements.find(row => row.leaf.placementId === 61)?.offset[2]).toBe(500);
  applyStoreyLevelEdit(s.store, s.editor, edit);
  expect(s.worldZ(60)).toBeCloseTo(3500);
});

it('#10420 full and lazy inventories choose the same home for two source containment rows', async () => {
  const text = THIRD_PARTY.replace('#90=IFCRELCONTAINED', '#190=IFCRELCONTAINED').replace('ENDSEC;\nEND-ISO',
    "#89=IFCRELCONTAINEDINSPATIALSTRUCTURE('second',$,$,$,(#60),#40);\nENDSEC;\nEND-ISO");
  const store = await parse(text), full = session(store), lazy = session(store);
  expect(homeStoreyOf(readStoreyInventory(store, full.view), 60)).toBe(40);
  expect(homeStoreyOf(readStoreyInventory(store, lazy.view, { lazyRelationships: true }), 60)).toBe(40);
});
