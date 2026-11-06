/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9013: add, rename, suggest and delete storeys in a parsed model. */

import * as create from '../../index.js';
import { describe, expect, it } from 'vitest';
import type { StoreyInventory } from './storey-model.js';
import { effectiveStoreyId } from '../edit/effective-storey.js';
import { THIRD_PARTY, helloWall, parse, session } from '../__test__/storey-fixtures.oracle.js';

/** #9013: the storey API through the package boundary. A revert of production fails this assertion, not a module load. */
function api<K extends keyof typeof create>(name: K): (typeof create)[K] {
  expect(typeof create[name], `${String(name)} is exported by @ifc-lite/create`).toBe('function');
  return create[name];
}


const fallback = (n: number) => `Level ${n}`;

describe('addStoreyInStore', () => {
  it('aggregates the storey under the building and copies the neighbour placement convention (hello-wall)', async () => {
    const s = session(await helloWall());
    const r = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
    const storey = s.view.getNewEntity(r.storeyId)!;
    expect(storey.type).toBe('IfcBuildingStorey');
    expect(storey.attributes.slice(2, 10)).toEqual(['Level 2', null, null, `#${r.placementId}`, null, null, '.ELEMENT.', { real: 3 }]);
    // The existing building decomposition is extended, not duplicated.
    expect(r.relAggregatesId).toBe(60);
    expect(s.view.getPositionalMutationsForEntity(60)?.get(5)).toEqual(['#42', `#${r.storeyId}`]);
    // Same parent placement as "My Storey" (#65 → #59), lifted by 3 m.
    expect(s.view.getNewEntity(r.placementId)!.attributes[0]).toBe('#59');
    expect(s.worldZ(r.storeyId)).toBe(3);

    const reloaded = session(await parse(s.text()));
    const inventory = api('readStoreyInventory')(reloaded.store, reloaded.view);
    expect(inventory.storeys.map((x) => [x.Name, x.elevation, x.parentId])).toEqual([['My Storey', 0, 36], ['Level 2', 3, 36]]);
  });

  it('writes the elevation in the file unit and keeps the neighbour offset (millimetres)', async () => {
    const s = session(await parse(THIRD_PARTY));
    const r = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 4', Elevation: 9.2, referenceStoreyId: 46 });
    expect(s.view.getNewEntity(r.storeyId)!.attributes[9]).toEqual({ real: 9200 });
    expect(s.worldZ(r.storeyId)).toBeCloseTo(9200, 9);
    expect(s.view.getPositionalMutationsForEntity(50)?.get(5)).toEqual(['#40', '#42', '#46', `#${r.storeyId}`]);
  });

  it('refuses a storey at an occupied elevation and writes nothing', async () => {
    const s = session(await parse(THIRD_PARTY));
    const before = s.snapshot();
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Twin', Elevation: 3 }))
      .toThrow('Level 2 is already at +3.00 m: storeys need a positive floor-to-floor height');
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: '  ', Elevation: 4 })).toThrow('A storey needs a name');
    expect(s.snapshot()).toEqual(before);
  });

  it('refuses a GlobalId a live entity already carries; a deleted one is free again', async () => {
    const s = session(await parse(THIRD_PARTY));
    const before = s.snapshot();
    // The column's GlobalId, from the parsed index.
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 4', Elevation: 9, GlobalId: '0Oz2e8GZz8RA2h4D8U3fsH' }))
      .toThrow('GlobalId "0Oz2e8GZz8RA2h4D8U3fsH" already belongs to #60');
    expect(s.snapshot()).toEqual(before);
    // An entity authored in this session.
    const added = api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 4', Elevation: 9, GlobalId: '3x4Kp9QeT0ZvYc1mN8bR2a' });
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 5', Elevation: 12, GlobalId: '3x4Kp9QeT0ZvYc1mN8bR2a' }))
      .toThrow(`already belongs to #${added.storeyId}`);
    // A source entity whose GlobalId was edited holds the new one, not the old one.
    s.editor.setPositionalAttribute(70, 0, '2Zq8Lm4Nr6Tv0Xy3Bc5Df7');
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 5', Elevation: 12, GlobalId: '2Zq8Lm4Nr6Tv0Xy3Bc5Df7' }))
      .toThrow('already belongs to #70');
    s.editor.removeEntity(80);
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 5', Elevation: 12, GlobalId: '2Hh6l7AY56SAGC9IQvMEv6' })).not.toThrow();
  });

  it('refuses a reference storey outside any building', async () => {
    const s = session(await parse(THIRD_PARTY.replace('(#40,#42,#46));', '(#40,#42));')));
    const before = s.snapshot();
    expect(() => api('addStoreyInStore')(s.store, s.editor, { Name: 'Level 4', Elevation: 9, referenceStoreyId: 46 }))
      .toThrow('Level 3 is not aggregated under a building');
    expect(s.snapshot()).toEqual(before);
  });

  it('renames through the named Name attribute', async () => {
    const s = session(await parse(THIRD_PARTY));
    api('renameStoreyInStore')(s.store, s.editor, 42, '  First floor ');
    expect(api('readStoreyInventory')(s.store, s.view).storeys[1].Name).toBe('First floor');
    expect(() => api('renameStoreyInStore')(s.store, s.editor, 42, '')).toThrow('A storey needs a name');
  });
});

describe('suggestStorey', () => {
  it('continues the naming pattern and spacing above the top storey', async () => {
    const s = session(await parse(THIRD_PARTY));
    const inventory = api('readStoreyInventory')(s.store, s.view);
    expect(api('suggestStorey')(inventory, 46, 'above', fallback)).toEqual({ Name: 'Level 4', Elevation: 9, Height: 3, referenceStoreyId: 46 });
    expect(api('suggestStorey')(inventory, 40, 'below', fallback)).toEqual({ Name: 'Level 0', Elevation: -3, Height: 3, referenceStoreyId: 40 });
    // Between two storeys the gap is split and the next free number is used.
    expect(api('suggestStorey')(inventory, 40, 'above', fallback)).toMatchObject({ Name: 'Level 4', Elevation: 1.5, Height: 1.5 });
  });

  it('falls back to a localised name when the neighbour name has no number', async () => {
    const s = session(await helloWall());
    expect(api('suggestStorey')(api('readStoreyInventory')(s.store, s.view), 42, 'above', fallback)).toMatchObject({ Name: 'Level 2', Elevation: 3 });
  });
});

describe('storey deletion', () => {
  it('lists highest first with counts', async () => {
    const s = session(await parse(THIRD_PARTY));
    expect(api('summarizeStoreys')(api('readStoreyInventory')(s.store, s.view)).map((row) => [row.Name, row.elevation, row.height, row.elementCount]))
      .toEqual([['Level 3', 6, null, 1], ['Level 2', 3, 3, 2], ['Level 1', 0, 3, 0]]);
  });

  it('deletes an empty storey and narrows the building decomposition', async () => {
    const s = session(await parse(THIRD_PARTY));
    api('applyStoreyDelete')(s.store, s.editor, 40, { kind: 'empty' });
    expect(s.view.isDeleted(40)).toBe(true);
    expect(s.view.getPositionalMutationsForEntity(50)?.get(5)).toEqual(['#42', '#46']);
    const reloaded = session(await parse(s.text()));
    expect(api('readStoreyInventory')(reloaded.store, reloaded.view).storeys.map((x) => x.Name)).toEqual(['Level 2', 'Level 3']);
  });

  it('refuses to delete a storey with elements unless told what to do with them', async () => {
    const s = session(await parse(THIRD_PARTY));
    const plan = api('planStoreyDelete')(api('readStoreyInventory')(s.store, s.view), 42, { kind: 'empty' });
    expect(plan.refusals.map((r) => [r.code, r.message])).toEqual([['notEmpty', 'Level 2 holds 2 element(s): move them to another storey or delete them with it']]);
    const before = s.snapshot();
    expect(() => api('applyStoreyDelete')(s.store, s.editor, 42, { kind: 'empty' })).toThrow(api('StoreyEditRefusedError'));
    expect(s.snapshot()).toEqual(before);
  });

  it('moves the contents to another storey, keeping identity and world position', async () => {
    const s = session(await parse(THIRD_PARTY));
    const before = [60, 70].map((id) => s.worldZ(id));
    api('applyStoreyDelete')(s.store, s.editor, 42, { kind: 'move', targetStoreyId: 40 });
    expect(s.view.isDeleted(42)).toBe(true);
    expect([60, 70].map((id) => effectiveStoreyId(s.store, s.view, id))).toEqual([40, 40]);
    expect([60, 70].map((id) => s.worldZ(id))).toEqual(before);
    // The beam on Level 3 still hangs from Level 2's (kept) placement.
    expect(s.worldZ(80)).toBe(6000);
    const reloaded = session(await parse(s.text()));
    expect([60, 70].map((id) => effectiveStoreyId(reloaded.store, null, id))).toEqual([40, 40]);
  });

  it('deletes the contents with the storey', async () => {
    const s = session(await parse(THIRD_PARTY));
    api('applyStoreyDelete')(s.store, s.editor, 42, { kind: 'deleteContents' });
    expect([42, 60, 70].map((id) => s.view.isDeleted(id))).toEqual([true, true, true]);
    expect(s.view.isDeleted(90)).toBe(true);
    expect(s.view.isDeleted(80)).toBe(false);
  });

  it('refuses to move a storey that nests products, which have no spatial owner to move', async () => {
    const s = session(await parse(THIRD_PARTY));
    const nested = s.editor.addEntity('IfcBuildingElementProxy', ['1Ab2Cd3Ef4Gh5Ij6Kl7Mn8', null, 'Nested', null, null, '#71', null, null, null]).expressId;
    s.editor.addEntity('IfcRelNests', ['0Pq1Rs2Tu3Vw4Xy5Za6Bc7', null, null, null, '#42', [`#${nested}`]]);
    const inventory = api('readStoreyInventory')(s.store, s.view);
    const plan = api('planStoreyDelete')(inventory, 42, { kind: 'move', targetStoreyId: 40 });
    expect(plan.refusals.map((r) => [r.code, r.elementIds])).toEqual([['dependent', [nested]]]);
    expect(plan.refusals[0].message).toContain('nests 1 product(s) through IfcRelNests');
    const before = s.snapshot();
    expect(() => api('applyStoreyDelete')(s.store, s.editor, 42, { kind: 'move', targetStoreyId: 40 })).toThrow(api('StoreyEditRefusedError'));
    expect(s.snapshot()).toEqual(before);
    // Deleting the contents takes the nested product too, so nothing is left orphaned.
    api('applyStoreyDelete')(s.store, s.editor, 42, { kind: 'deleteContents' });
    expect(s.view.isDeleted(nested)).toBe(true);
  });

  it('refuses a reviewed deletion once the storey holds something the review did not list', async () => {
    const s = session(await parse(THIRD_PARTY));
    const mode = { kind: 'deleteContents' } as const;
    const reviewed = api('planStoreyDelete')(api('readStoreyInventory')(s.store, s.view), 42, mode);
    expect(api('storeyDeletePlanSignature')(reviewed)).toBe(api('storeyDeletePlanSignature')(api('planStoreyDelete')(api('readStoreyInventory')(s.store, s.view), 42, mode)));
    const late = s.editor.addEntity('IfcColumn', ['3Oz2e8GZz8RA2h4D8U3fsH', null, 'Late', null, null, '#71', null, null, null]).expressId;
    s.editor.addEntity('IfcRelContainedInSpatialStructure', ['3tI3d7B1T4ivX8X0SA4yuM', null, null, null, [`#${late}`], '#42']);
    const before = s.snapshot();
    expect(() => api('applyStoreyDelete')(s.store, s.editor, 42, mode, reviewed)).toThrow('planned against a model that has changed');
    expect(() => api('applyStoreyDelete')(s.store, s.editor, 42, mode, reviewed)).toThrow(api('StoreyEditRefusedError'));
    expect(s.snapshot()).toEqual(before);
    expect(s.view.isDeleted(late)).toBe(false);
  });

  it('keeps the last storey', async () => {
    const s = session(await helloWall());
    const plan = api('planStoreyDelete')(api('readStoreyInventory')(s.store, s.view), 42, { kind: 'deleteContents' });
    expect(plan.refusals.map((r) => r.code)).toEqual(['onlyStorey']);
  });
});

describe('storey content limit (#9013 review)', () => {
  /** One storey containing `count` walls: only what the content walk and the count read. */
  function crowded(count: number): StoreyInventory {
    const children = Array.from({ length: count }, (_, index) => 1000 + index);
    const rel = { id: 2, type: 'IFCRELCONTAINEDINSPATIALSTRUCTURE', parent: 1, children, parentIndex: 5, listIndex: 4 };
    const storey = { expressId: 1, GlobalId: '', Name: 'Crowded', elevation: 0, elevationAttribute: 0, placementId: null, parentId: null, aggregateRelId: null };
    const reader = { entity: (id: number) => ({ expressId: id, type: 'IFCWALL', attributes: [] }) };
    return { storeys: [storey], relationships: [rel], outgoing: new Map([[1, [rel]]]), incoming: new Map(), reader } as unknown as StoreyInventory;
  }

  it('planning walks up to the limit and refuses beyond it', () => {
    expect(api('storeyContents')(crowded(50_000), 1).size).toBe(50_000);
    expect(() => api('storeyContents')(crowded(50_001), 1)).toThrow('Storey #1 holds more than 50,000 products');
  });

  it('listing still counts a storey beyond the limit', () => {
    expect(api('summarizeStoreys')(crowded(50_000)).map((row) => row.elementCount)).toEqual([50_000]);
    expect(api('summarizeStoreys')(crowded(50_001)).map((row) => [row.Name, row.elementCount])).toEqual([['Crowded', 50_001]]);
  });
});
