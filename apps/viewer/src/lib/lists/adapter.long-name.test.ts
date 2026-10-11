/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `LongName` attribute column (issue #7385): a room schedule over real
 * authoring-tool exports reads each IfcSpace's LongName ("Schlafzimmer") next
 * to its Name ("4"), on both the IFC4 and the IFC2X3 parse path, and through
 * the same chain the Lists panel runs (`createListDataProvider` ->
 * `executeList`).
 */

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcTypeEnum } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { executeList, type ListDefinition, type PropertyCondition } from '@ifc-lite/lists';
import { createListDataProvider } from './adapter.js';

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

async function parseFixture(context: TestContext, relative: string): Promise<IfcDataStore | null> {
  try {
    return await parse(new Uint8Array(await readFile(new URL(`../../../../../tests/models/${relative}`, import.meta.url))));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      context.skip(`${relative} fixture missing; run pnpm fixtures`);
      return null;
    }
    throw error;
  }
}

function list(entityTypes: IfcTypeEnum[], legacyConditions: PropertyCondition[] = []): ListDefinition {
  return {
    id: 'rooms', name: 'Rooms', createdAt: 0, updatedAt: 0, entityTypes, groups: [], legacyConditions,
    columns: [
      { id: 'name', source: 'attribute', propertyName: 'Name' },
      { id: 'long', source: 'attribute', propertyName: 'LongName' },
    ],
  };
}

const sortedRows = (rows: { values: unknown[] }[]) =>
  rows.map((row) => row.values).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('LongName list column (#7385)', () => {
  it('reads IfcSpace LongName from an IFC4 ArchiCAD export (AC20-FZK-Haus)', async (context) => {
    const store = await parseFixture(context, 'ara3d/AC20-FZK-Haus.ifc');
    if (!store) return;
    const provider = createListDataProvider(store);

    assert.deepEqual(sortedRows(executeList(list([IfcTypeEnum.IfcSpace]), provider).rows), [
      ['1', 'Flur'], ['2', 'Buero'], ['3', 'Bad'], ['4', 'Schlafzimmer'],
      ['5', 'Wohnen'], ['6', 'Küche'], ['7', 'Galerie'],
    ]);
    // Every spatial element declares LongName, not only IfcSpace.
    assert.deepEqual(sortedRows(executeList(list([IfcTypeEnum.IfcBuildingStorey]), provider).rows), [
      ['Dachgeschoss', 'ACID00000002-0000-0000-0000-000000000000'],
      ['Erdgeschoss', 'ACID00000001-0000-0000-0000-000000000000'],
    ]);
    // Conditions read the same attribute: filter rooms by their long name.
    const filtered = executeList(list([IfcTypeEnum.IfcSpace], [
      { source: 'attribute', propertyName: 'LongName', operator: 'equals', value: 'Bad' },
    ]), provider);
    assert.deepEqual(sortedRows(filtered.rows), [['3', 'Bad']]);
  });

  it('reads IfcSpace LongName from an IFC2X3 Revit export (duplex)', async (context) => {
    const store = await parseFixture(context, 'ara3d/duplex.ifc');
    if (!store) return;
    const rows = sortedRows(executeList(list([IfcTypeEnum.IfcSpace]), createListDataProvider(store)).rows);
    assert.equal(rows.length, 21);
    assert.deepEqual(rows.slice(0, 2), [['A101', 'Foyer'], ['A102', 'Living Room']]);
    assert.ok(rows.every(([, longName]) => typeof longName === 'string' && longName.length > 0));
  });

  it('is empty for a class without LongName, honours the model schema, and follows edits', async () => {
    const step = (schema: string) => new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,'Project long',$,$,$);
#2=IFCWALL('0Wall00000000000000002',$,'Wall A',$,$,$,$,$,$);
#3=IFCZONE('0Zone00000000000000003',$,'Z1',$,$${schema === 'IFC4' ? ",'Zone long'" : ''});
ENDSEC;
END-ISO-10303-21;
`);
    const ifc4 = await parse(step('IFC4'));
    const provider = createListDataProvider(ifc4);
    assert.equal(provider.getEntityLongName?.(1), 'Project long');
    assert.equal(provider.getEntityLongName?.(3), 'Zone long');
    assert.equal(provider.getEntityLongName?.(2), '', 'IfcWall declares no LongName');
    assert.deepEqual(executeList(list([IfcTypeEnum.IfcWall]), provider).rows[0].values, ['Wall A', null]);

    // IFC2X3 IfcZone has no LongName slot at all.
    assert.equal(createListDataProvider(await parse(step('IFC2X3'))).getEntityLongName?.(3), '');

    // A pending attribute edit shows up in the column before export.
    const view = new MutablePropertyView(ifc4.properties, 'm');
    view.setAttribute(3, 'LongName', 'Renamed zone');
    assert.equal(createListDataProvider(ifc4, '', undefined, view).getEntityLongName?.(3), 'Renamed zone');
  });
});
