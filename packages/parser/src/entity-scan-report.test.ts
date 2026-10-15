/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { scanIfcEntities } from './index.js';

const record = "#1=IFCWALL('0000000000000000000001',$,'Wall',$,$,$,$,$,$);";
const file = (extra = '') => new TextEncoder().encode(
  "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n" +
  record + '\n' + extra + '\nENDSEC;\nEND-ISO-10303-21;\n',
).buffer;

describe('record-scan coverage through the existing scanner API (DX1)', () => {
  it('reports a complete scan separately from the returned records', async () => {
    const result = await scanIfcEntities(file(), { disableWorkerScan: true });
    expect(result.entityRefs.map(ref => ref.expressId)).toEqual([1]);
    expect(result.report).toMatchObject({ completeness: 'complete', scannedRecords: 1,
      oversizedIdCount: 0, malformedRecordDetected: false, diagnostics: [] });
  });

  it('reports the record omitted by the u32 identity bound', async () => {
    const result = await scanIfcEntities(file('#4294967296=IFCCARTESIANPOINT((0.,0.,0.));'), { disableWorkerScan: true });
    expect(result.entityRefs.map(ref => ref.expressId)).toEqual([1]);
    expect(result.report).toMatchObject({ completeness: 'incomplete', oversizedIdCount: 1 });
  });

  it.each([NaN, Infinity, -1, 0.5])('does not certify an invalid refusal count %s (PR #7632)', async count => {
    const buffer = file();
    const scanned = await scanIfcEntities(buffer, { disableWorkerScan: true });
    const result = await scanIfcEntities(buffer, { preScannedEntityIndex: {
      ids: Uint32Array.from(scanned.entityRefs.map(ref => ref.expressId)),
      starts: Uint32Array.from(scanned.entityRefs.map(ref => ref.byteOffset)),
      lengths: Uint32Array.from(scanned.entityRefs.map(ref => ref.byteLength)),
      oversizedIdCount: count, malformedRecordCount: 0,
    } });
    expect(result.report).toMatchObject({ completeness: 'unknown', oversizedIdCount: null });
  });

  it.each([NaN, Infinity, -1, 0.5])('does not certify an invalid WASM refusal count %s (PR #7632)', async count => {
    const buffer = file();
    const scanned = await scanIfcEntities(buffer, { disableWorkerScan: true });
    const result = await scanIfcEntities(buffer, { disableWorkerScan: true, wasmApi: {
      scanEntitiesFastBytes: () => Object.assign([...scanned.entityRefs], { oversizedIdCount: count, malformedRecordCount: 0 }),
    } });
    expect(result.entityRefs.map(ref => ref.expressId)).toEqual([1]);
    expect(result.report).toMatchObject({ scanPath: 'wasm', completeness: 'unknown', oversizedIdCount: null });
  });

  it('does not promote unreported pre-scan counters to zero', async () => {
    const buffer = file();
    const scanned = await scanIfcEntities(buffer, { disableWorkerScan: true });
    const result = await scanIfcEntities(buffer, { disableWorkerScan: true, preScannedEntityIndex: {
      ids: Uint32Array.from(scanned.entityRefs.map(ref => ref.expressId)),
      starts: Uint32Array.from(scanned.entityRefs.map(ref => ref.byteOffset)),
      lengths: Uint32Array.from(scanned.entityRefs.map(ref => ref.byteLength)),
    } });
    expect(result.entityRefs.map(ref => ref.expressId)).toEqual([1]);
    expect(result.report).toMatchObject({ completeness: 'unknown', oversizedIdCount: null, malformedRecordDetected: null });
  });
});
