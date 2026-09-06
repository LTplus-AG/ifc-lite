/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';
import { prepareColumnarEntities } from './columnar-entity-preparation.js';
import { ColumnarParser, extractPropertiesOnDemand, type IfcDataStore } from './columnar-parser.js';
import { buildEntityRefsFromIndex, buildEntityColumnsFromIndex } from './entity-refs-from-index.js';
import { scanColumnarEntities, type PreScannedEntityIndex } from './entity-scanner.js';

const records = [
  "#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);",
  "#30=IFCSPACE('0000000000000000000030',$,'Room',$,$,$,$,$,.ELEMENT.,.INTERNAL.,$);",
  "#40=IFCPROPERTYSET('0000000000000000000040',$,'Pset_Room',$,(#41));",
  "#41=IFCPROPERTYSINGLEVALUE('Area',$,IFCAREAMEASURE(12.5),$);",
  "#50=IFCRELDEFINESBYPROPERTIES('0000000000000000000050',$,$,$,(#30),#40);",
  '#7=\fIfcCartesianPoint((1.,2.,3.));',
  '#7=IFCCARTESIANPOINT((4.,5.,6.));',
  '#9=IFCDIRECTION((0.,0.,1.));',
];
const text = [
  'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('columns.ifc','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;', 'DATA;', ...records, 'ENDSEC;', 'END-ISO-10303-21;',
].join('\n');
const bytes = new TextEncoder().encode(text);

function columns(sorted: boolean): PreScannedEntityIndex {
  const rows = records.map(record => ({
    id: Number(record.slice(1, record.indexOf('='))),
    start: text.indexOf(record), length: record.length,
  }));
  if (sorted) rows.sort((a, b) => a.id - b.id);
  return {
    ids: Uint32Array.from(rows.map(row => row.id)),
    starts: Uint32Array.from(rows.map(row => row.start)),
    lengths: Uint32Array.from(rows.map(row => row.length)),
    oversizedIdCount: 0, malformedRecordCount: 0,
  };
}

function indexEntries(store: IfcDataStore) {
  return [...store.entityIndex.byId.entries()];
}

describe('issue #3985 pre-scanned column preparation', () => {
  it.each([false, true])('preserves all helper spans and stable duplicate rows, sorted=%s', async sorted => {
    const supplied = columns(sorted);
    const refs = buildEntityRefsFromIndex(bytes, supplied.ids, supplied.starts, supplied.lengths);
    const expected = await new ColumnarParser().parseLite(bytes.buffer, refs);
    const store = await new IfcParser().parseColumnar(bytes.buffer, { preScannedEntityIndex: supplied });
    expect(indexEntries(store)).toEqual(indexEntries(expected));
    expect([...store.entityIndex.byType]).toEqual([...expected.entityIndex.byType]);
    expect(store.entityIndex.byType.get('IFCCARTESIANPOINT')).toEqual([7, 7]);
    expect(store.entityIndex.byId.get(7)).toEqual(expected.entityIndex.byId.get(7));
    expect(indexEntries(store).filter(([id]) => id === 7).map(([, ref]) =>
      new TextDecoder().decode(bytes.subarray(ref.byteOffset, ref.byteOffset + ref.byteLength)),
    )).toEqual(records.slice(5, 7));
    expect(store.entityIndex.byId.get(9)?.type).toBe('IFCDIRECTION');
    // Ownership invariant: a producer releasing/reusing its columns must not
    // rewrite a published store or corrupt future reference lookups.
    supplied.ids.fill(0); supplied.starts.fill(0); supplied.lengths.fill(0);
    store.entityIndex.byId.get(30);
    expect(indexEntries(store)).toEqual(indexEntries(expected));
  });

  it.each([false, true])('keeps property values and reference access with deferred atoms=%s', async defer => {
    let partial: IfcDataStore | undefined;
    const store = await new IfcParser().parseColumnar(bytes.buffer, {
      preScannedEntityIndex: columns(false), deferPropertyAtomIndex: defer,
      onSpatialReady: value => { partial = value; },
    });
    expect(partial).toBeDefined();
    expect(partial!.entityIndex.byId.has(41)).toBe(!defer);
    expect(store.entityIndex.byId.has(41)).toBe(!defer);
    expect(store.deferredEntityIndex?.has(41) ?? false).toBe(defer);
    expect(store.entityIndex.byType.has('IFCPROPERTYSINGLEVALUE')).toBe(!defer);
    expect(store.entityIndex.byId.get(40)?.type).toBe('IFCPROPERTYSET');
    expect(extractPropertiesOnDemand(store, 30)).toMatchObject([
      { name: 'Pset_Room', properties: [{ name: 'Area', value: 12.5 }] },
    ]);
    expect(store.onDemandPropertyMap?.get(30)).toEqual([40]);
  });

  it('rejects both truncated columns and out-of-bounds record spans', async () => {
    for (const invalid of [
      { ...columns(true), starts: new Uint32Array(0) },
      { ...columns(true), lengths: new Uint32Array(0) },
    ]) {
      await expect(new IfcParser().parseColumnar(bytes.buffer, {
        preScannedEntityIndex: invalid,
      })).rejects.toThrow(/column-length mismatch/);
    }
    const outside = columns(true);
    outside.starts[0] = bytes.length + 1;
    await expect(new IfcParser().parseColumnar(bytes.buffer, {
      preScannedEntityIndex: outside,
    })).rejects.toThrow(/out-of-bounds span/);
    const overrun = columns(true);
    overrun.lengths[0] = bytes.length;
    await expect(new IfcParser().parseColumnar(bytes.buffer, {
      preScannedEntityIndex: overrun,
    })).rejects.toThrow(/out-of-bounds span/);
  });

  it('reports refused and malformed records from the same scanner state machine', async () => {
    const diagnostics: string[] = [];
    const result = await scanColumnarEntities(bytes.buffer, {
      preScannedEntityIndex: { ...columns(true), oversizedIdCount: 2, malformedRecordCount: 1 },
      onDiagnostic: message => diagnostics.push(message),
    });
    expect(result.oversizedIdCount).toBe(2);
    expect(result.malformedRecordCount).toBe(1);
    expect(diagnostics.some(message => message.includes('skipped 2 record(s)'))).toBe(true);
    expect(diagnostics.some(message => message.includes('stopped early'))).toBe(true);
    const unknown: string[] = [];
    await scanColumnarEntities(bytes.buffer, {
      preScannedEntityIndex: { ...columns(true), oversizedIdCount: undefined },
      onDiagnostic: message => unknown.push(message),
    });
    expect(unknown.some(message => message.includes('not proof that none were skipped'))).toBe(true);
  });

  it('does not lose a recognized type after 65536 distinct file-supplied names', async () => {
    // Scan-time categorization must see the original name. The existing compact
    // index narrows type IDs later; narrowing before categorization would drop
    // this wall from the entity table entirely (#3985).
    const sourceRecords = Array.from({ length: 0x10000 }, (_, i) => `#${i + 1}=TYPE${i}($);`);
    sourceRecords.push("#65537=IFCWALL('0000000000000000065537',$,'Wall',$,$,$,$,$,$);");
    const source = new TextEncoder().encode(sourceRecords.join('\n'));
    const starts = new Uint32Array(sourceRecords.length);
    const lengths = Uint32Array.from(sourceRecords.map(record => record.length));
    for (let i = 1; i < starts.length; i++) starts[i] = starts[i - 1] + lengths[i - 1] + 1;
    const ids = Uint32Array.from({ length: starts.length }, (_, i) => i + 1);
    const scanned = buildEntityColumnsFromIndex(source, ids, starts, lengths);
    const prepared = await prepareColumnarEntities(scanned, false, async () => {});
    expect(prepared.geometryRefs.map(ref => [ref.expressId, ref.type])).toEqual([[65537, 'IFCWALL']]);
    expect(prepared.byType.get('IFCWALL')).toEqual([65537]);
  });

  it('retains empty pre-pass fallback and complete tokenizer reference access', async () => {
    const store = await new IfcParser().parseColumnar(bytes.buffer, {
      preScannedEntityIndex: { ids: new Uint32Array(), starts: new Uint32Array(), lengths: new Uint32Array() },
      disableWorkerScan: true,
    });
    expect(store.entityIndex.byId.has(9)).toBe(true);
    expect(extractPropertiesOnDemand(store, 30)[0].properties[0].value).toBe(12.5);
  });
});
