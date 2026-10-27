/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, test } from 'vitest';
import { fingerprintColumns } from './wasm-columns.js';
import type { EntityFingerprint } from './types.js';

test('column transport retains every UTF-16 string without conflating identities (#8042, #8081)', () => {
  const entity: EntityFingerprint<null> = { key: '😀', ifcType: 'IfcWall', dataHash: 'd', ref: null };
  expect(fingerprintColumns([entity]).strings[0]).toBe('😀');
  for (const text of ['\ud800', '\udc00', 'a\ud800b', '\ud800\ud800', '\udc00\udc00']) {
    const variants: EntityFingerprint<null>[] = [
      { ...entity, key: text }, { ...entity, ifcType: text },
      { ...entity, dataHash: text }, { ...entity, geometryHash: text },
      { ...entity, container: text }, { ...entity, components: { [text]: 'd' } },
      { ...entity, components: { propertySets: text } },
    ];
    for (const variant of variants) expect(fingerprintColumns([variant]).strings).toContain(text);
  }
  const scalar = { ...entity, key: '�', components: { propertySets: 'literal\\ud800' } };
  expect(fingerprintColumns([scalar]).strings).toContain('literal\\ud800');
});

// #8110 review r4390077184: dictionary membership alone does not prove that
// row indexes still identify the original strings when all variants coexist.
test('column indexes preserve distinct UTF-16 identities in one batch (#8042, #8110)', () => {
  const input = ['', '\0', '\ud800', '\ud801', '\udc00', '\udfff', 'a\ud800b',
    '\ud800\ud800', '\udc00\udc00', '\ufffd', 'literal\\ud800', '😀'];
  const entities: EntityFingerprint<null>[] = input.map(text => ({
    key: text, ifcType: text, dataHash: text, geometryHash: text,
    container: text, components: { [text]: text }, ref: null,
  }));
  const columns = fingerprintColumns(entities);
  const read = (index: number | undefined): string => {
    if (index === undefined || columns.strings[index] === undefined) throw new Error('missing transported string');
    return columns.strings[index];
  };
  const units = (text: string) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
  const sameIdentities = (output: string[]) => {
    expect(output.map(units)).toEqual(input.map(units));
    expect(new Set(output).size).toBe(new Set(input).size);
  };
  // The five scalar fields and the component key/value pairs are read through
  // the column contract consumed by Rust, rather than searching the dictionary.
  for (const field of [0, 1, 2, 3, 4]) {
    sameIdentities(input.map((_, row) => read(columns.fields[row * 5 + field])));
  }
  for (const field of [0, 1]) {
    sameIdentities(input.map((_, row) => {
      const offset = columns.componentOffsets[row];
      if (offset === undefined) throw new Error('missing component offset');
      expect(columns.componentOffsets[row + 1]).toBe(offset + 1);
      return read(columns.componentPairs[offset * 2 + field]);
    }));
  }
});
