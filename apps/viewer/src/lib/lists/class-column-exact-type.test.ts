/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Lists panel's `Class` column must name the class an entity's STEP line
 * actually DECLARED, matching `@ifc-lite/data`'s `exactTypeName()` — the same
 * answer #3325 put in the Parquet exporter's `Type` column and #3322 put in
 * the viewer store's export path, after both were caught naming the
 * `IfcTypeEnum`-coalesced family instead (`IFCDOORSTANDARDCASE` reported as
 * `IfcDoor`). `createListDataProvider` (apps/viewer/src/lib/lists/adapter.ts)
 * is a THIRD, independent consumer of the same entity table and had its own
 * `getEntityTypeName: (id) => store.entities.getTypeName(id)` — the coalesced
 * accessor — so the Lists panel's `Class` column, and every CSV/XLSX export
 * built from it, silently renamed `IfcDoorStandardCase` to `IfcDoor` with no
 * error and no other signal.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser } from '@ifc-lite/parser';
import { createListDataProvider } from './adapter.js';

// A door whose STEP line declares the StandardCase subtype (IfcTypeEnum
// coalesces it onto plain IfcDoor for scope-chip grouping), plus a plain
// IfcDoor as a negative control that must NOT change.
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

describe('Lists Class column names the declared class, not the coalesced family (#3325 twin)', () => {
  it('reports IfcDoorStandardCase for a STEP line that declares it', async () => {
    const bytes = new TextEncoder().encode(FIXTURE);
    const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
    const provider = createListDataProvider(store);

    assert.equal(provider.getEntityTypeName(2), 'IfcDoorStandardCase');
    // Negative control: a plain IfcDoor must still read back as IfcDoor.
    assert.equal(provider.getEntityTypeName(3), 'IfcDoor');
  });
});
