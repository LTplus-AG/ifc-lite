/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The full handoff the `@ifc-lite/cache` README's quickstart describes, driven
 * end to end against a REAL parse rather than a hand-built store: parse a STEP
 * source, adapt it with {@link toCacheDataStore}, write it, read it back, and
 * check the pieces a caller depends on survived.
 *
 * `@ifc-lite/parser` is a devDependency of this package for exactly this file.
 * The adapter is deliberately typed structurally (see {@link ParsedIfcStore}),
 * so nothing in `src/` imports the parser -- but a structural type that is
 * never fed the real thing is a claim, not a test.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, attachDataStoreAccessors, type IfcStoreData } from '@ifc-lite/parser';
import { toCacheDataStore } from './adapt.js';
import { BinaryCacheWriter } from './writer.js';
import { BinaryCacheReader } from './reader.js';
import { SchemaVersion } from './types.js';

/** Pad to the 22-char width of an IFC GlobalId. */
const gid = (seed: string): string => seed.padEnd(22, '0').slice(0, 22);

function ifcSource(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3'): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('test.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCLOCALPLACEMENT($,#2);
#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#5=IFCUNITASSIGNMENT((#4));
#6=IFCPROJECT('${gid('Project')}',$,'Test Project',$,$,$,$,$,#5);
#7=IFCSITE('${gid('Site')}',$,'Site',$,$,#3,$,$,.ELEMENT.,$,$,$,$,$);
#8=IFCBUILDING('${gid('Building')}',$,'Building',$,$,#3,$,$,.ELEMENT.,$,$,$);
#9=IFCBUILDINGSTOREY('${gid('Storey')}',$,'Ground Floor',$,$,#3,$,$,.ELEMENT.,0.);
#10=IFCWALL('${gid('WallA')}',$,'Wall A',$,$,#3,$,$,$);
#11=IFCWALL('${gid('WallB')}',$,'Wall B',$,$,#3,$,$,$);
#12=IFCRELAGGREGATES('${gid('RelP2S')}',$,$,$,#6,(#7));
#13=IFCRELAGGREGATES('${gid('RelS2B')}',$,$,$,#7,(#8));
#14=IFCRELAGGREGATES('${gid('RelB2St')}',$,$,$,#8,(#9));
#15=IFCRELCONTAINEDINSPATIALSTRUCTURE('${gid('RelSt2E')}',$,$,$,(#10,#11),#9);
ENDSEC;
END-ISO-10303-21;
`;
}

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

async function parse(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3') {
  const sourceBuffer = toArrayBuffer(ifcSource(schema));
  const parser = new IfcParser();
  const store = await parser.parseColumnar(sourceBuffer, { disableWorkerScan: true });
  return { store, sourceBuffer };
}

async function roundTrip(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3') {
  const { store, sourceBuffer } = await parse(schema);
  const cacheBuffer = await new BinaryCacheWriter().write(
    toCacheDataStore(store),
    undefined,
    sourceBuffer,
    { includeGeometry: false },
  );
  const result = await new BinaryCacheReader().read(cacheBuffer);
  return { store, sourceBuffer, result };
}

describe('toCacheDataStore -> BinaryCacheWriter -> BinaryCacheReader round trip', () => {
  it('carries the entity index through the write, so a read-back cache can resolve entities from the retained source', async () => {
    const { store, sourceBuffer, result } = await roundTrip('IFC4');

    // The adapter must not drop the index: EntityByIdIndex already iterates
    // [number, EntityRef] and EntityRef is assignable to CacheEntityRef.
    expect(result.entityIndex, 'entity-index section written and read back').toBeDefined();

    const sourceIds = [...store.entityIndex.byId.keys()].sort((a, b) => a - b);
    const readIds = [...result.entityIndex!.ids].sort((a, b) => a - b);
    expect(readIds).toEqual(sourceIds);

    // The README's remedy: retain the source, re-attach the lazy accessors on
    // read, and entity lookups work against the restored index.
    const byId = new Map(
      [...result.entityIndex!.ids].map((id, i) => [
        id,
        {
          expressId: id,
          type: result.entityIndex!.typeNames[result.entityIndex!.typeIndices[i]],
          byteOffset: result.entityIndex!.byteOffsets[i],
          byteLength: result.entityIndex!.byteLengths[i],
          lineNumber: 0,
        },
      ]),
    );
    const restored = attachDataStoreAccessors({
      ...result.dataStore,
      schemaVersion: 'IFC4',
      source: new Uint8Array(sourceBuffer),
      entityIndex: { byId, byType: new Map<string, number[]>() },
    } as unknown as IfcStoreData);

    const wall = restored.getEntity(10);
    expect(wall, 'entity #10 resolvable from the restored index + retained source').toBeTruthy();
    expect(wall!.type.toUpperCase()).toBe('IFCWALL');
  });

  it('preserves schema, entityCount and the entity table across the round trip', async () => {
    const { store, result } = await roundTrip('IFC4');

    expect(result.dataStore.schema).toBe(SchemaVersion.IFC4);
    expect(result.dataStore.entityCount).toBe(store.entityCount);
    expect(result.dataStore.entities.count).toBe(store.entities.count);
    expect(store.entities.count).toBeGreaterThan(0);
  });

  it.each([
    ['IFC2X3', SchemaVersion.IFC2X3],
    ['IFC4', SchemaVersion.IFC4],
    ['IFC4X3', SchemaVersion.IFC4X3],
  ] as const)('round-trips a %s source as its own SchemaVersion', async (schema, expected) => {
    const { result } = await roundTrip(schema);
    expect(result.dataStore.schema).toBe(expected);
  });

  it('round-trips an IFC5 source as SchemaVersion.IFC2X3, the documented fallback (the binary format predates IFC5)', async () => {
    // No STEP file declares IFC5, so this exercises the adapter's documented
    // fallback directly on the store shape the adapter accepts.
    const { store, sourceBuffer } = await parse('IFC4');
    const cacheBuffer = await new BinaryCacheWriter().write(
      toCacheDataStore({ ...store, schemaVersion: 'IFC5' }),
      undefined,
      sourceBuffer,
      { includeGeometry: false },
    );
    const result = await new BinaryCacheReader().read(cacheBuffer);
    expect(result.dataStore.schema).toBe(SchemaVersion.IFC2X3);
  });
});
