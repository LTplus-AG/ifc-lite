/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { EntityExtractor } from './entity-extractor.js';
import { parsePropertyValue } from './property-value-parser.js';
import type { IfcAttributeValue } from './types.js';

// #7119 invariant: a public write marker and its corresponding STEP token
// decode to the same value, IFC type, candidate members and structure.
const typed = (type: string, value: string | number | boolean): IfcAttributeValue => ({ typed: { type, value } });
const cases: Array<[string, string, IfcAttributeValue[]]> = [
  ['IfcPropertySingleValue', "'Length',$,IFCLENGTHMEASURE(0.25),$", ['Length', null, typed('IfcLengthMeasure', 0.25), null]],
  ['IfcPropertySingleValue', "'Flag',$,IFCBOOLEAN(.T.),$", ['Flag', null, typed('IfcBoolean', true), null]],
  ['IfcPropertySingleValue', "'Real',$,450.,$", ['Real', null, { real: 450 }, null]],
  ['IfcPropertyEnumeratedValue', "'Choice',$,(IFCLABEL('a'),IFCLABEL('b')),$", ['Choice', null, [typed('IfcLabel', 'a'), typed('IfcLabel', 'b')], null]],
  ['IfcPropertyListValue', "'Lengths',$,(IFCLENGTHMEASURE(0.25),IFCLENGTHMEASURE(0.5)),$", ['Lengths', null, [typed('IfcLengthMeasure', 0.25), typed('IfcLengthMeasure', 0.5)], null]],
  ['IfcPropertyBoundedValue', "'Range',$,IFCLENGTHMEASURE(0.5),IFCLENGTHMEASURE(0.25),$,IFCLENGTHMEASURE(0.3)", ['Range', null, typed('IfcLengthMeasure', 0.5), typed('IfcLengthMeasure', 0.25), null, typed('IfcLengthMeasure', 0.3)]],
  ['IfcPropertyTableValue', "'Table',$,(IFCLABEL('a')),(IFCLENGTHMEASURE(0.25)),$,$,$,$", ['Table', null, [typed('IfcLabel', 'a')], [typed('IfcLengthMeasure', 0.25)], null, null, null, null]],
];

it.each(cases)('#7119 public markers preserve %s STEP decoding: %s', (type, slots, attributes) => {
  const bytes = new TextEncoder().encode(`#1=${type.toUpperCase()}(${slots});`);
  const entity = new EntityExtractor(bytes).extractEntity({
    expressId: 1, type: type.toUpperCase(), byteOffset: 0, byteLength: bytes.length, lineNumber: 1,
  });
  expect(entity).not.toBeNull();
  if (!entity) throw new Error('the STEP invariant must parse');
  expect(parsePropertyValue({ ...entity, attributes })).toEqual(parsePropertyValue(entity));
});
