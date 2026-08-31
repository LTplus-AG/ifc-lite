/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Three independent export paths must agree on an entity's class: the
 * Lists panel's Class column (`apps/viewer/src/lib/lists/adapter.ts`,
 * fixed by #3475), the Parquet `Type` column (`@ifc-lite/export`, #3325),
 * and the command palette's `export:json` entry (`CommandPalette.tsx`,
 * #3503). All three must name the class an entity's STEP line actually
 * declares — `IfcTypeEnum`'s `getTypeName` coalesces several classes onto
 * one family (`IfcDoorStandardCase` onto `IfcDoor`) for the viewer's scope
 * chips, and that coalesced name is right for a chip but wrong for an
 * export.
 *
 * #3475 pinned the first two paths against each other; the palette's JSON
 * export was left on the old `getTypeName` call, so the same model exported
 * two ways agreed and a third disagreed. This pins all three against one
 * shared fixture, per the same class list `class-column-exact-type.test.ts`
 * and `parquet-exact-type.test.ts` (`packages/export`) already use.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { ParquetExporter } from '@ifc-lite/export';
// `apps/viewer/src/apache-arrow.d.ts` declares this module with `export =`,
// so the named import the packages/export tests use does not type-check here.
import * as arrow from 'apache-arrow';
import { readParquet } from 'parquet-wasm';
import { createListDataProvider } from '../../lib/lists/adapter.js';
import { buildCommandPaletteJsonEntities } from './commandPaletteJsonExport.js';

// A StandardCase subtype (coalesced onto IfcDoor by IfcTypeEnum) plus a
// plain IfcDoor negative control that must not change.
const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,$,$);
#2=IFCDOORSTANDARDCASE('Door00000000000000001A',$,'Door-A',$,$,$,$,$,2.,0.9,$,$,$);
#3=IFCDOOR('Door00000000000000001B',$,'Door-B',$,$,$,$,$,2.,0.9,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse() {
  const bytes = new TextEncoder().encode(FIXTURE);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

function decodeParquet(bytes: Uint8Array): Record<string, unknown>[] {
  const table = arrow.tableFromIPC(readParquet(bytes).intoIPCStream());
  return (table.toArray() as { toJSON(): Record<string, unknown> }[]).map((row) => row.toJSON());
}

describe('the three export paths agree on the declared class (#3503)', () => {
  it('Lists Class column, Parquet Type column, and command-palette JSON export all name IfcDoorStandardCase', async () => {
    const store = await parse();

    // Lists panel Class column (#3475).
    const listProvider = createListDataProvider(store);
    assert.equal(listProvider.getEntityTypeName(2), 'IfcDoorStandardCase');
    assert.equal(listProvider.getEntityTypeName(3), 'IfcDoor'); // control

    // Parquet Type column (#3325).
    const rows = decodeParquet(await new ParquetExporter(store).exportTable('entities'));
    const byId = new Map<number, string>(rows.map((r) => [Number(r.ExpressId), String(r.Type)]));
    assert.equal(byId.get(2), 'IfcDoorStandardCase');
    assert.equal(byId.get(3), 'IfcDoor'); // control

    // Command palette export:json (#3503) — the path this issue fixes.
    const jsonRows = buildCommandPaletteJsonEntities(store);
    const jsonById = new Map<number, unknown>(
      jsonRows.map((r) => [r.expressId as number, r.type]),
    );
    assert.equal(jsonById.get(2), 'IfcDoorStandardCase');
    assert.equal(jsonById.get(3), 'IfcDoor'); // control

    // Grouping is unaffected: getTypeName still answers the coalesced family.
    assert.equal(store.entities.getTypeName(2), 'IfcDoor');
  });
});
