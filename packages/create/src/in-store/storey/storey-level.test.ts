/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9013: storey re-level (elevation, floor-to-floor) moves real placements. */

import * as create from '../../index.js';
import { describe, expect, it } from 'vitest';
import { recordCompoundMutation, undoRecordedMutationOperations, StoreEditor } from '@ifc-lite/mutations';
import { meshStairs, stairMeshBounds, stairWasmAvailable } from '../__test__/stair-mesh.oracle.js';
import { THIRD_PARTY, helloWall, parse, session } from '../__test__/storey-fixtures.oracle.js';

/** #9013: the storey API through the package boundary. A revert of production fails this assertion, not a module load. */
function api<K extends keyof typeof create>(name: K): (typeof create)[K] {
  expect(typeof create[name], `${String(name)} is exported by @ifc-lite/create`).toBe('function');
  return create[name];
}


const plan = (s: ReturnType<typeof session>, edit: Parameters<typeof create.planStoreyLevelEdit>[1]) =>
  api('planStoreyLevelEdit')(api('readStoreyInventory')(s.store, s.view), edit);

describe('storey elevation edit', () => {
  it('moves a third-party storey and exactly its contents, whatever they hang from', async () => {
    const s = session(await parse(THIRD_PARTY));
    const p = plan(s, { kind: 'elevation', storeyId: 42, Elevation: 3.5 });
    expect(p.refusals).toEqual([]);
    expect(p.storeys).toEqual([{ expressId: 42, Name: 'Level 2', from: 3, to: 3.5, elevationAttribute: 3500 }]);
    // Storey placement lifted; the building-relative column lifted on its own;
    // the Level 3 beam that hangs from Level 2 compensated so it stays put.
    const writes = new Map(p.placements.map((w) => [w.leaf.placementId, w.offset[2]]));
    expect(Object.fromEntries(writes)).toEqual({ 44: 500, 61: 500, 81: -500 });
    expect([...p.moved].sort()).toEqual([60, 70]);
    expect(p.held).toEqual([80]);
    expect(p.movedElementCount).toBe(2);
    expect(p.spacing).toEqual([
      { lowerId: 40, upperId: 42, from: 3, to: 3.5 },
      { lowerId: 42, upperId: 46, from: 3, to: 2.5 },
    ]);

    api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'elevation', storeyId: 42, Elevation: 3.5 });
    expect(s.worldZ(42)).toBeCloseTo(3500, 9);
    expect(s.worldZ(60)).toBeCloseTo(3500, 9);
    expect(s.worldZ(70)).toBeCloseTo(3500, 9);
    expect(s.worldZ(80)).toBeCloseTo(6000, 9);
    expect(s.worldZ(46)).toBeCloseTo(6000, 9);
    // The shared origin axis placement #5 is untouched: Level 1 and the site still sit on it.
    expect(s.worldZ(40)).toBe(0);
    expect(api('readStoreyInventory')(s.store, s.view).storeys.map((storey) => [storey.Name, storey.elevation]))
      .toEqual([['Level 1', 0], ['Level 2', 3.5], ['Level 3', 6]]);
  });

  it('survives export and reload in IFC4 and IFC4X3', async () => {
    for (const schema of ['IFC4', 'IFC4X3'] as const) {
      const s = session(await parse(THIRD_PARTY));
      api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'elevation', storeyId: 42, Elevation: 3.5 });
      const reloaded = session(await parse(s.text(schema)));
      expect(reloaded.store.schemaVersion).toBe(schema);
      expect(api('readStoreyInventory')(reloaded.store, reloaded.view).storeys.map((storey) => [storey.GlobalId, storey.elevation]))
        .toEqual([['3BXk9GCxj5V9eCELW6qKoB', 0], ['1UbzJ6LyL7XBk4BdJ_jP0R', 3.5], ['0dwaCbNdz3hA0zHj3Fmq1n', 6]]);
      expect(reloaded.worldZ(60)).toBeCloseTo(3500, 6);
      expect(reloaded.worldZ(70)).toBeCloseTo(3500, 6);
      expect(reloaded.worldZ(80)).toBeCloseTo(6000, 6);
    }
  });

  it.skipIf(!stairWasmAvailable)('carries a hosted wall, its openings and windows in real geometry (hello-wall)', async () => {
    const s = session(await helloWall());
    const before = await meshStairs(s.text());
    const p = plan(s, { kind: 'elevation', storeyId: 42, Elevation: 0.75 });
    // Bonsai hangs the wall from the storey and the openings and windows from the wall: one write moves all.
    expect(p.placements.map((w) => w.leaf.placementId)).toEqual([65]);
    expect([...p.moved].sort((a, b) => a - b)).toEqual([1222, 1262, 1299, 1407, 1443, 1494]);
    expect(p.movedElementCount).toBe(4); // wall, two windows and the aggregated space
    api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'elevation', storeyId: 42, Elevation: 0.75 });
    const after = await meshStairs(s.text());
    for (const id of [1222, 1262, 1407, 1494]) {
      const a = stairMeshBounds(before.get(id)!), b = stairMeshBounds(after.get(id)!);
      for (let i = 0; i < 3; i++) {
        expect(b.min[i]).toBeCloseTo(a.min[i] + (i === 2 ? 0.75 : 0), 5);
        expect(b.max[i]).toBeCloseTo(a.max[i] + (i === 2 ? 0.75 : 0), 5);
      }
    }
  });
});

describe('storey floor-to-floor edit', () => {
  it('shifts every storey above, with their contents, by the same delta', async () => {
    const s = session(await parse(THIRD_PARTY));
    const p = plan(s, { kind: 'floorHeight', storeyId: 40, Height: 3.5 });
    expect(p.storeys.map(({ expressId, to }) => [expressId, to])).toEqual([[42, 3.5], [46, 6.5]]);
    // The beam hangs from Level 2 and moves with Level 3 by the same amount: no write of its own.
    expect(Object.fromEntries(p.placements.map((w) => [w.leaf.placementId, w.offset[2]]))).toEqual({ 44: 500, 47: 500, 61: 500 });
    expect(p.spacing).toEqual([{ lowerId: 40, upperId: 42, from: 3, to: 3.5 }]);
    api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'floorHeight', storeyId: 40, Height: 3.5 });
    expect([40, 42, 46, 60, 70, 80].map((id) => Math.round(s.worldZ(id)))).toEqual([0, 3500, 6500, 3500, 3500, 6500]);
  });
});

describe('invalid storey edits are refused before anything is written', () => {
  it.each([
    [{ kind: 'elevation', storeyId: 42, Elevation: 6 }, 'spacing'],
    [{ kind: 'elevation', storeyId: 42, Elevation: 7 }, 'crossing'],
    [{ kind: 'elevation', storeyId: 42, Elevation: -1 }, 'crossing'],
    [{ kind: 'elevation', storeyId: 42, Elevation: Number.NaN }, 'invalidValue'],
    [{ kind: 'floorHeight', storeyId: 46, Height: 3 }, 'topStorey'],
    [{ kind: 'floorHeight', storeyId: 40, Height: 0 }, 'spacing'],
    [{ kind: 'floorHeight', storeyId: 40, Height: -2 }, 'spacing'],
    [{ kind: 'elevation', storeyId: 999, Elevation: 1 }, 'notFound'],
  ] as const)('%o → %s', async (edit, code) => {
    const s = session(await parse(THIRD_PARTY));
    expect(plan(s, edit).refusals.map((r) => r.code)).toEqual([code]);
    const before = s.snapshot();
    expect(() => api('applyStoreyLevelEdit')(s.store, s.editor, edit)).toThrow(api('StoreyEditRefusedError'));
    expect(s.snapshot()).toEqual(before);
  });

  it('names the neighbour a crossing storey would pass', async () => {
    const s = session(await parse(THIRD_PARTY));
    const [refusal] = plan(s, { kind: 'elevation', storeyId: 42, Elevation: 7 }).refusals;
    expect(refusal.message).toBe('Level 2 at +7.00 m would pass Level 3 (+6.00 m) above it');
  });

  it('refuses a placement two storeys share instead of moving both', async () => {
    const s = session(await parse(THIRD_PARTY.replace("#71=IFCLOCALPLACEMENT(#44,#5);", "#71=IFCLOCALPLACEMENT(#44,#5);\n#72=IFCBEAM('3Hh6l7AY56SAGC9IQvMEv6',$,'Shared',$,$,#61,$,$,$);\n#92=IFCRELCONTAINEDINSPATIALSTRUCTURE('1e4jP7xA51WhwLk6JwGcGJ',$,$,$,(#72),#40);")));
    const p = plan(s, { kind: 'elevation', storeyId: 42, Elevation: 3.5 });
    expect(p.refusals.map((r) => [r.code, [...(r.elementIds ?? [])].sort()])).toEqual([['sharedPlacement', [60, 72]]]);
  });
});

describe('a storey edit is one undo step', () => {
  it('restores the overlay exactly, however many placements it wrote', async () => {
    const s = session(await parse(THIRD_PARTY));
    const before = s.snapshot();
    recordCompoundMutation(s.view, (draft) => api('applyStoreyLevelEdit')(s.store, new StoreEditor(s.store, draft), { kind: 'floorHeight', storeyId: 40, Height: 3.5 }));
    expect(Math.round(s.worldZ(60))).toBe(3500);
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('one compound storey edit expected'); });
    expect(s.snapshot()).toEqual(before);
    expect(Math.round(s.worldZ(60))).toBe(3000);
  });
});
