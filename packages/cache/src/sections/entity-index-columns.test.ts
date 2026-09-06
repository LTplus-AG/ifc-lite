/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompactEntityIndex, IfcParser } from '@ifc-lite/parser';
import { writeEntityIndex, readEntityIndex } from './entity-index.js';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';
import type { CacheEntityIndex, CacheEntityRef } from '../types.js';

function encode(byId: CacheEntityIndex['byId']): ArrayBuffer {
  const writer = new BufferWriter();
  writeEntityIndex(writer, { byId });
  return writer.build();
}
function iterableOnly(index: CompactEntityIndex): CacheEntityIndex['byId'] {
  return { [Symbol.iterator]: () => index[Symbol.iterator]() };
}
function checkOracle(index: CompactEntityIndex) {
  const before = [...index];
  const expected = encode(iterableOnly(index));
  const actual = encode(index);
  // #3985: exact section bytes ARE the binary-cache compatibility contract.
  // Native strict comparison keeps the 65536-type boundary oracle affordable
  // under the full parallel suite without shortening its byte/object coverage.
  deepStrictEqual(new Uint8Array(actual), new Uint8Array(expected));
  deepStrictEqual([...index], before);
  const restored = readEntityIndex(new BufferReader(actual));
  deepStrictEqual(restored, readEntityIndex(new BufferReader(expected)));
  return restored;
}
function compact(ids: number[], types: number[], names: string[]) {
  return new CompactEntityIndex(Uint32Array.from(ids),
    Uint32Array.from(ids.map((_, i) => i * 19)),
    Uint32Array.from(ids.map((_, i) => i + 7)), Uint16Array.from(types), names);
}

describe('compact cache columns preserve iterable byte layout (#3985)', () => {
  it('keeps sparse/duplicate IDs, normalized first-row type order and source ownership', () => {
    const index = compact([0, 0, 2, 0xffffffff], [3, 1, 0, 2],
      ['ifcwall', 'IFCWALL', 'Ifcſpace', 'IFCSPACE', 'UNREFERENCED']);
    const columns = index.getColumns();
    const beforeColumns = structuredClone(columns);
    const decoded = checkOracle(index);
    expect(decoded.ids).toEqual(new Uint32Array([0, 0, 2, 0xffffffff]));
    expect(decoded.typeNames).toEqual(['IFCSPACE', 'IFCWALL']);
    expect(decoded.typeIndices).toEqual(new Uint16Array([0, 1, 1, 0]));
    expect(columns).toEqual(beforeColumns);
    expect(index.get(0xffffffff)?.type).toBe('Ifcſpace');
    // String lists returned to transport/cache cannot rewrite source type names.
    columns.typeStrings[2] = 'MUTATED_CONSUMER_TABLE';
    expect([...index].at(-1)?.[1].type).toBe('Ifcſpace');
  });

  it('keeps empty and unused-only type tables empty on the wire', () => {
    expect(checkOracle(compact([], [], ['unused'])).typeNames).toEqual([]);
  });

  it('retains stable sorting when a public constructor supplies unsorted IDs', () => {
    const decoded = checkOracle(compact([9, 2, 9, 0], [0, 1, 2, 0], ['IfcWall', 'IfcSlab', 'IfcDoor']));
    expect(decoded.ids).toEqual(new Uint32Array([0, 2, 9, 9]));
    expect(decoded.byteOffsets).toEqual(new Uint32Array([57, 19, 0, 38]));
    expect(decoded.typeNames).toEqual(['IFCWALL', 'IFCSLAB', 'IFCDOOR']);
  });

  it.each(['shortOffsets', 'longOffsets', 'shortLengths', 'longLengths', 'shortTypes', 'longTypes', 'badTypeIndex', 'nonStringType'])
  ('preserves iterable coercion for unusual constructor input: %s', kind => {
    const ids = new Uint32Array([1, 2]);
    const offsets = new Uint32Array(kind === 'shortOffsets' ? [10] : kind === 'longOffsets' ? [10, 20, 30] : [10, 20]);
    const lengths = new Uint32Array(kind === 'shortLengths' ? [3] : kind === 'longLengths' ? [3, 4, 5] : [3, 4]);
    const types = new Uint16Array(kind === 'shortTypes' ? [0] : kind === 'longTypes' ? [0, 0, 0] : kind === 'badTypeIndex' ? [0, 17] : [0, 0]);
    const names = kind === 'nonStringType' ? [42] as unknown as string[] : ['IfcWall'];
    checkOracle(new CompactEntityIndex(ids, offsets, lengths, types, names));
  });

  it('preserves all 65536 distinct referenced source type slots', () => {
    const n = 0x10000;
    const ids = Uint32Array.from({ length: n }, (_, i) => i);
    const types = Uint16Array.from({ length: n }, (_, i) => n - i - 1);
    const index = new CompactEntityIndex(ids, ids.slice(), ids.slice(), types,
      Array.from({ length: n }, (_, i) => `IfcVendor${i}`));
    const restored = checkOracle(index);
    expect(restored.typeNames.length).toBe(n);
    expect(restored.typeNames[0]).toBe('IFCVENDOR65535');
    expect(restored.typeNames[n - 1]).toBe('IFCVENDOR0');
  });

  it('retains generic iterable overflow rejection at the 65537th unique normalized type', () => {
    const byId: CacheEntityIndex['byId'] = {
      *[Symbol.iterator](): IterableIterator<[number, CacheEntityRef]> {
        for (let id = 0; id <= 0x10000; id++) {
          yield [id, { expressId: id, type: `IfcVendor${id}`, byteOffset: id, byteLength: 1 }];
        }
      },
    };
    expect(() => encode(byId)).toThrow('more than 65535 unique IFC type names');
  });
});

const realFixture = resolve(__dirname, '../../../../tests/models/ara3d/AC20-FZK-Haus.ifc');
const hasFixture = existsSync(realFixture);
if (!hasFixture) console.warn('skip compact cache real IFC oracle: run pnpm fixtures');
it.skipIf(!hasFixture)('retains real Archicad cache section bytes and properties (#3985)', async () => {
  const source = Uint8Array.from(readFileSync(realFixture)).buffer;
  const parsed = await new IfcParser().parseColumnar(source, { disableWorkerScan: true });
  expect(parsed.entityIndex.byId).toBeInstanceOf(CompactEntityIndex);
  const index = parsed.entityIndex.byId as CompactEntityIndex;
  const propertyIds = [...parsed.onDemandPropertyMap!.keys()];
  expect(propertyIds.length).toBeGreaterThan(0);
  const sampleId = propertyIds[0];
  const before = parsed.getProperties(sampleId);
  expect(before.length).toBeGreaterThan(0);
  checkOracle(index);
  expect(parsed.getProperties(sampleId)).toEqual(before);
});
