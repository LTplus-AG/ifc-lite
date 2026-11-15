/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { serializeValue, stepString } from '@ifc-lite/data';
import { EntityExtractor } from '../src/entity-extractor.js';
import { resolveEffectiveEntityRecord } from '../src/effective-entity-record.js';

function read(text: string) {
  const source = new TextEncoder().encode(text);
  return new EntityExtractor(source).extractEntity({ expressId: 1, type: 'IFCPOSTALADDRESS',
    byteOffset: 0, byteLength: source.length, lineNumber: 1 })!;
}

it('effective aggregate text agrees with the actual STEP read after serialization (#9876 review)', () => {
  const before = read("#1=IFCPOSTALADDRESS($,$,$,$,('Before'),$,$,$,$,$);");
  const labels = ['$', '*', '#42', 'Station'].map(stepString);
  const effective = resolveEffectiveEntityRecord(before,
    { named: [], positional: [[4, labels]] }, 'IFC4');
  const reopened = read(`#1=IFCPOSTALADDRESS($,$,$,$,${serializeValue(labels)},$,$,$,$,$);`);
  expect(effective.attributes).toEqual(reopened.attributes);
  expect(effective.attributes[4]).toEqual(['$', '*', '#42', 'Station']);
  expect(labels, 'reading cannot mutate the queued edits').toEqual(['$', '*', '#42', 'Station'].map(stepString));
});

it('unwraps shared nested aggregate markers without mutating the authored arrays (#9876 review)', () => {
  const inner = [stepString('$'), stepString('#42')];
  const value = [inner, inner, [stepString('*')]];
  const effective = resolveEffectiveEntityRecord({ type: 'IfcUnknownLiteralTest', attributes: [value] },
    { named: [], positional: [] }, 'IFC4');
  expect(effective.attributes[0]).toEqual([['$', '#42'], ['$', '#42'], ['*']]);
  expect(inner).toEqual([stepString('$'), stepString('#42')]);
});
