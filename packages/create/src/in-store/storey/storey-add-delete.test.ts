/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9013: add, rename, suggest and delete storeys in a parsed model. */

import { describe, expect, it } from 'vitest';
import { effectiveStoreyId } from '../edit/effective-storey.js';
import { addStoreyInStore, renameStoreyInStore } from './storey-add.js';
import { applyStoreyDelete, planStoreyDelete } from './storey-delete.js';
import { readStoreyInventory, summarizeStoreys } from './storey-model.js';
import { suggestStorey } from './storey-suggest.js';
import { StoreyEditRefusedError } from './storey-validation.js';
import { THIRD_PARTY, helloWall, parse, session } from './storey-fixtures.oracle.js';

const fallback = (n: number) => `Level ${n}`;

describe('addStoreyInStore', () => {
  it('aggregates the storey under the building and copies the neighbour placement convention (hello-wall)', async () => {
    const s = session(await helloWall());
    const r = addStoreyInStore(s.store, s.editor, { Name: 'Level 2', Elevation: 3 });
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
    const inventory = readStoreyInventory(reloaded.store, reloaded.view);
    expect(inventory.storeys.map((x) => [x.Name, x.elevation, x.parentId])).toEqual([['My Storey', 0, 36], ['Level 2', 3, 36]]);
  });

  it('writes the elevation in the file unit and keeps the neighbour offset (millimetres)', async () => {
    const s = session(await parse(THIRD_PARTY));
    const r = addStoreyInStore(s.store, s.editor, { Name: 'Level 4', Elevation: 9.2, referenceStoreyId: 46 });
    expect(s.view.getNewEntity(r.storeyId)!.attributes[9]).toEqual({ real: 9200 });
    expect(s.worldZ(r.storeyId)).toBeCloseTo(9200, 9);
    expect(s.view.getPositionalMutationsForEntity(50)?.get(5)).toEqual(['#40', '#42', '#46', `#${r.storeyId}`]);
  });

  it('refuses a storey at an occupied elevation and writes nothing', async () => {
    const s = session(await parse(THIRD_PARTY));
    const before = s.snapshot();
    expect(() => addStoreyInStore(s.store, s.editor, { Name: 'Twin', Elevation: 3 }))
      .toThrow('Level 2 is already at +3.00 m: storeys need a positive floor-to-floor height');
    expect(() => addStoreyInStore(s.store, s.editor, { Name: '  ', Elevation: 4 })).toThrow('A storey needs a name');
    expect(s.snapshot()).toEqual(before);
  });

  it('renames through the named Name attribute', async () => {
    const s = session(await parse(THIRD_PARTY));
    renameStoreyInStore(s.store, s.editor, 42, '  First floor ');
    expect(readStoreyInventory(s.store, s.view).storeys[1].Name).toBe('First floor');
    expect(() => renameStoreyInStore(s.store, s.editor, 42, '')).toThrow('A storey needs a name');
  });
});

describe('suggestStorey', () => {
  it('continues the naming pattern and spacing above the top storey', async () => {
    const s = session(await parse(THIRD_PARTY));
    const inventory = readStoreyInventory(s.store, s.view);
    expect(suggestStorey(inventory, 46, 'above', fallback)).toEqual({ Name: 'Level 4', Elevation: 9, Height: 3, referenceStoreyId: 46 });
    expect(suggestStorey(inventory, 40, 'below', fallback)).toEqual({ Name: 'Level 0', Elevation: -3, Height: 3, referenceStoreyId: 40 });
    // Between two storeys the gap is split and the next free number is used.
    expect(suggestStorey(inventory, 40, 'above', fallback)).toMatchObject({ Name: 'Level 4', Elevation: 1.5, Height: 1.5 });
  });

  it('falls back to a localised name when the neighbour name has no number', async () => {
    const s = session(await helloWall());
    expect(suggestStorey(readStoreyInventory(s.store, s.view), 42, 'above', fallback)).toMatchObject({ Name: 'Level 2', Elevation: 3 });
  });
});

describe('storey deletion', () => {
  it('lists highest first with counts', async () => {
    const s = session(await parse(THIRD_PARTY));
    expect(summarizeStoreys(readStoreyInventory(s.store, s.view)).map((row) => [row.Name, row.elevation, row.height, row.elementCount]))
      .toEqual([['Level 3', 6, null, 1], ['Level 2', 3, 3, 2], ['Level 1', 0, 3, 0]]);
  });

  it('deletes an empty storey and narrows the building decomposition', async () => {
    const s = session(await parse(THIRD_PARTY));
    applyStoreyDelete(s.store, s.editor, 40, { kind: 'empty' });
    expect(s.view.isDeleted(40)).toBe(true);
    expect(s.view.getPositionalMutationsForEntity(50)?.get(5)).toEqual(['#42', '#46']);
    const reloaded = session(await parse(s.text()));
    expect(readStoreyInventory(reloaded.store, reloaded.view).storeys.map((x) => x.Name)).toEqual(['Level 2', 'Level 3']);
  });

  it('refuses to delete a storey with elements unless told what to do with them', async () => {
    const s = session(await parse(THIRD_PARTY));
    const plan = planStoreyDelete(readStoreyInventory(s.store, s.view), 42, { kind: 'empty' });
    expect(plan.refusals.map((r) => [r.code, r.message])).toEqual([['notEmpty', 'Level 2 holds 2 element(s): move them to another storey or delete them with it']]);
    const before = s.snapshot();
    expect(() => applyStoreyDelete(s.store, s.editor, 42, { kind: 'empty' })).toThrow(StoreyEditRefusedError);
    expect(s.snapshot()).toEqual(before);
  });

  it('moves the contents to another storey, keeping identity and world position', async () => {
    const s = session(await parse(THIRD_PARTY));
    const before = [60, 70].map((id) => s.worldZ(id));
    applyStoreyDelete(s.store, s.editor, 42, { kind: 'move', targetStoreyId: 40 });
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
    applyStoreyDelete(s.store, s.editor, 42, { kind: 'deleteContents' });
    expect([42, 60, 70].map((id) => s.view.isDeleted(id))).toEqual([true, true, true]);
    expect(s.view.isDeleted(90)).toBe(true);
    expect(s.view.isDeleted(80)).toBe(false);
  });

  it('keeps the last storey', async () => {
    const s = session(await helloWall());
    const plan = planStoreyDelete(readStoreyInventory(s.store, s.view), 42, { kind: 'deleteContents' });
    expect(plan.refusals.map((r) => r.code)).toEqual(['onlyStorey']);
  });
});
