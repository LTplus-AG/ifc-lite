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

/** A second building with its own storeys at 0 and 3 m (#9013 review). */
const TWO_BUILDINGS = THIRD_PARTY
  .replace("#51=IFCRELAGGREGATES('3cO5$AHT9DlxAizLOHv3Mx',$,$,$,#20,(#30));", "#51=IFCRELAGGREGATES('3cO5$AHT9DlxAizLOHv3Mx',$,$,$,#20,(#30,#130));")
  .replace('ENDSEC;\nEND-ISO', `#130=IFCBUILDING('1K3P0JJ3v8HhKXCXNoHGbS',$,'Annex',$,$,#131,$,$,.ELEMENT.,$,$,$);
#131=IFCLOCALPLACEMENT(#21,#5);
#140=IFCBUILDINGSTOREY('2BXk9GCxj5V9eCELW6qKoB',$,'Annex 0',$,$,#141,$,$,.ELEMENT.,0.);
#141=IFCLOCALPLACEMENT(#131,#5);
#142=IFCBUILDINGSTOREY('2UbzJ6LyL7XBk4BdJ_jP0R',$,'Annex 1',$,$,#144,$,$,.ELEMENT.,3000.);
#143=IFCCARTESIANPOINT((0.,0.,3000.));
#145=IFCAXIS2PLACEMENT3D(#143,$,$);
#144=IFCLOCALPLACEMENT(#131,#145);
#150=IFCRELAGGREGATES('0Gm7rvwBn0aOhMnZVa$4c4',$,$,$,#130,(#140,#142));
ENDSEC;
END-ISO`);

describe('storey edits stay within their building (#9013 review)', () => {
  it('a floor-to-floor edit shifts only the storeys above in the same building', async () => {
    const s = session(await parse(TWO_BUILDINGS));
    const p = plan(s, { kind: 'floorHeight', storeyId: 40, Height: 3.5 });
    expect(p.refusals).toEqual([]);
    expect(p.storeys.map((x) => x.expressId).sort()).toEqual([42, 46]);
    expect(p.spacing.map(({ lowerId, upperId }) => [lowerId, upperId])).toEqual([[40, 42]]);
  });

  it('elevation neighbours come from the same building', async () => {
    const s = session(await parse(TWO_BUILDINGS));
    // Annex 1 to +1.00 m is fine: only Annex 0 is below it; the main building's storeys do not count.
    expect(plan(s, { kind: 'elevation', storeyId: 142, Elevation: 1 }).refusals).toEqual([]);
  });

  it('adding at an elevation only another building occupies is allowed', async () => {
    const s = session(await parse(TWO_BUILDINGS));
    const added = api('addStoreyInStore')(s.store, s.editor, { Name: 'Annex 2', Elevation: 6, referenceStoreyId: 142 });
    expect(api('readStoreyInventory')(s.store, s.view).storeys.find((x) => x.expressId === added.storeyId)?.parentId).toBe(130);
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Twin', Elevation: 3, referenceStoreyId: 142 }))
      .toThrow('Annex 1 is already at +3.00 m');
  });

  it('a buildingId that disagrees with the reference storey is refused', async () => {
    const s = session(await parse(TWO_BUILDINGS));
    const before = s.snapshot();
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Annex 2', Elevation: 6, referenceStoreyId: 142, buildingId: 30 }))
      .toThrow('Annex 1 belongs to #130, not building #30');
    expect(s.snapshot()).toEqual(before);
    const added = api('addStoreyInStore')(s.store, s.editor, { Name: 'Annex 2', Elevation: 6, referenceStoreyId: 142, buildingId: 130 });
    expect(api('readStoreyInventory')(s.store, s.view).storeys.find((x) => x.expressId === added.storeyId)?.parentId).toBe(130);
  });
});

describe('a reviewed plan is refused when the model changed under it (#9013 review)', () => {
  it('a product attached to a moved placement after review makes the plan stale', async () => {
    const s = session(await parse(THIRD_PARTY));
    const edit = { kind: 'elevation', storeyId: 42, Elevation: 3.5 } as const;
    const reviewed = plan(s, edit);
    // A new column on Level 2 sharing the slab's placement: the writes are unchanged, the outcome is not.
    const column = s.editor.addEntity('IfcColumn', ['3Oz2e8GZz8RA2h4D8U3fsH', null, 'Late', null, null, '#71', null, null, null]).expressId;
    s.editor.addEntity('IfcRelContainedInSpatialStructure', ['3tI3d7B1T4ivX8X0SA4yuM', null, null, null, [`#${column}`], '#42']);
    expect(() => api('applyStoreyLevelEdit')(s.store, s.editor, edit, reviewed)).toThrow('planned against a model that has changed');
  });

  it('a placement point edited after review makes the plan stale, though ids and offsets are unchanged', async () => {
    const s = session(await parse(THIRD_PARTY));
    const edit = { kind: 'elevation', storeyId: 42, Elevation: 3.5 } as const;
    const reviewed = plan(s, edit);
    // The column hangs from the building, so the plan lifts its own placement #61 (point #62) by 500 mm.
    expect(reviewed.placements.map(({ leaf, offset }) => [leaf.placementId, offset[2]])).toContainEqual([61, 500]);
    s.editor.setPositionalAttribute(62, 0, [1000, 0, 4000]);
    expect(plan(s, edit).placements.map(({ leaf, offset }) => [leaf.placementId, offset[2]])).toContainEqual([61, 500]);
    const before = s.snapshot();
    expect(() => api('applyStoreyLevelEdit')(s.store, s.editor, edit, reviewed)).toThrow('planned against a model that has changed');
    expect(s.snapshot()).toEqual(before);
    // Re-reviewed, it applies, and the column lands 500 mm above where it now is.
    api('applyStoreyLevelEdit')(s.store, s.editor, edit, plan(s, edit));
    expect(s.worldZ(60)).toBe(4500);
  });
});

describe('a reviewed plan pins the placements it writes (#9013 review)', () => {
  it('rotating a written placement after review makes the plan stale', async () => {
    const s = session(await parse(THIRD_PARTY));
    const edit = { kind: 'elevation', storeyId: 42, Elevation: 3.5 } as const;
    const reviewed = plan(s, edit);
    expect(reviewed.placements.map(({ leaf }) => leaf.axisPlacementId)).toContain(45);
    // Level 2's axis placement #45 turned a quarter turn about Z: same ids, same offsets.
    const turn = s.editor.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
    s.editor.setPositionalAttribute(45, 2, `#${turn}`);
    const before = s.snapshot();
    expect(() => api('applyStoreyLevelEdit')(s.store, s.editor, edit, reviewed)).toThrow('planned against a model that has changed');
    expect(s.snapshot()).toEqual(before);
  });
});

describe('grid-bound products follow their grid (#9013 review)', () => {
  /** A grid on Level 2 (#100), hanging from the storey; column #112 on Level 2 sits on its A/1 crossing. */
  const GRID = THIRD_PARTY.replace('ENDSEC;\nEND-ISO', `#100=IFCGRID('0Gr1dAAAAAAAAAAAAAAAAA',$,'Grid',$,$,#101,$,(#102),(#103),$,$);
#101=IFCLOCALPLACEMENT(#44,#5);
#102=IFCGRIDAXIS('A',#104,.T.);
#103=IFCGRIDAXIS('1',#105,.T.);
#104=IFCPOLYLINE((#106,#107));
#105=IFCPOLYLINE((#106,#108));
#106=IFCCARTESIANPOINT((0.,0.));
#107=IFCCARTESIANPOINT((10000.,0.));
#108=IFCCARTESIANPOINT((0.,10000.));
#109=IFCVIRTUALGRIDINTERSECTION((#102,#103),(0.,0.));
#110=IFCGRIDPLACEMENT(#109,$);
#111=IFCLOCALPLACEMENT(#110,#5);
#112=IFCCOLUMN('0Gr1dCo1AAAAAAAAAAAAAA',$,'Grid column',$,$,#111,$,$,$);
#116=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Gr1dRe1AAAAAAAAAAAAAA',$,$,$,(#100,#112),#42);
ENDSEC;
END-ISO`);

  it('a grid column on the moved storey rides with the grid, with no write of its own', async () => {
    const s = session(await parse(GRID));
    const p = plan(s, { kind: 'elevation', storeyId: 42, Elevation: 3.5 });
    expect(p.refusals).toEqual([]);
    expect(p.moved).toEqual(expect.arrayContaining([100, 112]));
    expect(p.placements.map(({ leaf }) => leaf.placementId)).not.toContain(111);
  });

  it('a reviewed deletion is stale once the grid its column is bound to has moved', async () => {
    // The grid now stands on Level 3; the column it binds stays on Level 2.
    const text = GRID.replace('#101=IFCLOCALPLACEMENT(#44,#5);', '#101=IFCLOCALPLACEMENT(#47,#5);')
      .replace('(#100,#112),#42);', '(#112),#42);\n#117=IFCRELCONTAINEDINSPATIALSTRUCTURE(\'0Gr1dRe2AAAAAAAAAAAAAA\',$,$,$,(#100),#46);');
    const s = session(await parse(text));
    const mode = { kind: 'deleteContents' } as const;
    const reviewed = api('planStoreyDelete')(api('readStoreyInventory')(s.store, s.view), 42, mode);
    expect(reviewed.contents).toContain(112);
    // Move the grid: a new point under its own placement.
    const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, 100]]).expressId;
    const axis = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
    s.editor.setPositionalAttribute(101, 1, `#${axis}`);
    const before = s.snapshot();
    expect(() => api('applyStoreyDelete')(s.store, s.editor, 42, mode, reviewed)).toThrow('planned against a model that has changed');
    expect(s.snapshot()).toEqual(before);
  });

  it('a column of another storey bound to a moved grid is found and refused, not carried along', async () => {
    const s = session(await parse(GRID.replace('(#100,#112),#42);', '(#100),#42);\n#117=IFCRELCONTAINEDINSPATIALSTRUCTURE(\'0Gr1dRe2AAAAAAAAAAAAAA\',$,$,$,(#112),#46);')));
    const p = plan(s, { kind: 'elevation', storeyId: 42, Elevation: 3.5 });
    expect(p.refusals.flatMap((r) => r.elementIds ?? [])).toContain(112);
    const before = s.snapshot();
    expect(() => api('applyStoreyLevelEdit')(s.store, s.editor, { kind: 'elevation', storeyId: 42, Elevation: 3.5 })).toThrow(api('StoreyEditRefusedError'));
    expect(s.snapshot()).toEqual(before);
  });
});

describe('adding next to an unreadable placement is refused (#9013 review)', () => {
  it('does not fall back to a default placement', async () => {
    const s = session(await parse(THIRD_PARTY.replace('#47=IFCLOCALPLACEMENT(#31,#49);', '#47=IFCLOCALPLACEMENT(#31,$);')));
    const before = s.snapshot();
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 4', Elevation: 9, referenceStoreyId: 46 }))
      .toThrow('the placement of Level 3 cannot be read');
    expect(s.snapshot()).toEqual(before);
  });
});
