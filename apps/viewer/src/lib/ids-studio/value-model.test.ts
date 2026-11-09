/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS-035 / IDS-045: the value editor round-trips every restriction kind.
 * Oracle: the authoring package's own normaliser. Reading a stored constraint
 * into the form and writing the form back must normalise to the same
 * constraint, so opening and re-applying a value never changes it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IDSConstraint } from '@ifc-lite/ids';
import { commit, createStudioDocument, createStudioState, normaliseValue } from '@ifc-lite/ids-authoring';
import { formFromConstraint, inputFromForm, rebasedValue, sampleMatches, splitPastedValues } from './value-model';
import { addFacetOps, addSpecOps, setFieldOp } from './ops';
import { studioXml } from './xml';
import { siUnitOf, splitQuantity } from './units';

const STORED: Array<[string, IDSConstraint]> = [
  ['equals', { type: 'simpleValue', value: 'EI60' }],
  ['oneOf', { type: 'enumeration', values: ['EI60', 'EI90'] }],
  ['pattern', { type: 'pattern', pattern: 'EI[0-9]{2,3}' }],
  ['range (inclusive)', { type: 'bounds', minInclusive: 0.9, maxInclusive: 1.2 }],
  ['range (exclusive low)', { type: 'bounds', minExclusive: 0 }],
  ['length', { type: 'bounds', minLength: 2, maxLength: 8 }],
  ['digits', { type: 'bounds', totalDigits: 5, fractionDigits: 2 }],
];

function written(c: IDSConstraint, base?: string): IDSConstraint | undefined {
  const result = inputFromForm(formFromConstraint(c), base);
  assert.ok('input' in result, `form for ${JSON.stringify(c)} reports ${'problem' in result ? result.problem : ''}`);
  return result.input ? normaliseValue(result.input) : undefined;
}

describe('value editor model (IDS-035)', () => {
  for (const [name, constraint] of STORED) {
    it(`round-trips ${name} unchanged`, () => {
      assert.deepEqual(written(constraint), constraint);
    });
  }

  it('keeps a conjunction it cannot edit as a raw constraint, verbatim', () => {
    const conjunction: IDSConstraint = { type: 'pattern', pattern: '[A-Z]+', and: [{ type: 'bounds', maxLength: 4 }] };
    const form = formFromConstraint(conjunction);
    assert.equal(form.kind, 'raw');
    assert.deepEqual(written(conjunction), conjunction);
  });

  it('any value removes the constraint', () => {
    assert.deepEqual(inputFromForm(formFromConstraint(undefined)), { input: null });
  });

  it('reports a form problem instead of writing a broken draft', () => {
    assert.deepEqual(inputFromForm({ ...formFromConstraint({ type: 'bounds', minInclusive: 1 }), min: 'abc' }), { problem: 'number' });
    assert.deepEqual(inputFromForm({ ...formFromConstraint({ type: 'simpleValue', value: 'x' }), text: '' }), { problem: 'empty' });
  });

  it('carries the data type\'s XSD base into enumerations and ranges', () => {
    assert.deepEqual(written({ type: 'enumeration', values: ['1', '2'] }, 'xs:integer'), { type: 'enumeration', values: ['1', '2'], base: 'xs:integer' });
  });

  it('splits a pasted spreadsheet column into distinct values, keeping commas inside values', () => {
    assert.deepEqual(splitPastedValues('EI30\r\nEI60\n\nEI60\tEI 90, smoke-tight;REI120'), ['EI30', 'EI60', 'EI 90, smoke-tight', 'REI120']);
  });

  it('tests a sample with the validator\'s own matcher (numbers for ranges, implicit anchoring for patterns)', () => {
    assert.equal(sampleMatches({ type: 'bounds', minInclusive: 0.9, maxInclusive: 1.2 }, '1.0'), true);
    assert.equal(sampleMatches({ type: 'bounds', minInclusive: 0.9, maxInclusive: 1.2 }, '1.5'), false);
    assert.equal(sampleMatches({ type: 'pattern', pattern: 'EI[0-9]+' }, 'EI60'), true);
    assert.equal(sampleMatches({ type: 'pattern', pattern: 'EI[0-9]+' }, 'xEI60'), false, 'XSD patterns match the whole value');
    assert.equal(sampleMatches({ type: 'enumeration', values: ['EI60'] }, 'ei60'), false, 'case-sensitive, as in IDS');
  });
});

describe('unit-aware numeric input (IDS-045)', () => {
  it('splits a typed quantity into number and unit', () => {
    assert.deepEqual(splitQuantity('2400 mm'), { number: '2400', unit: 'mm' });
    assert.deepEqual(splitQuantity('2,4m'), { number: '2.4', unit: 'm' });
    assert.deepEqual(splitQuantity('12.5 m²'), { number: '12.5', unit: 'm²' });
    assert.deepEqual(splitQuantity('42'), { number: '42' });
  });

  it('a range typed in millimetres is stored in SI by the reducer', () => {
    const form = { ...formFromConstraint({ type: 'bounds', minInclusive: 1 }), min: '2400 mm', max: '3000 mm' };
    const result = inputFromForm(form);
    assert.ok('input' in result && result.input);
    assert.deepEqual(normaliseValue(result.input), { type: 'bounds', minInclusive: 2.4, maxInclusive: 3 });
  });

  it('refuses two different units for the two bounds', () => {
    const form = { ...formFromConstraint({ type: 'bounds', minInclusive: 1 }), min: '2 m', max: '3000 mm' };
    assert.deepEqual(inputFromForm(form), { problem: 'unit' });
  });

  it('names the SI unit a measure data type is compared in', () => {
    assert.equal(siUnitOf('IFCLENGTHMEASURE'), 'm');
    assert.equal(siUnitOf('IfcAreaMeasure'), 'm²');
    assert.equal(siUnitOf('IFCLABEL'), undefined);
  });
});

describe('a data type picked after the value', () => {
  // Reported from the field: Conditionscore (1-5, IFCINTEGER) was saved as xs:string.
  it('writes the data type\'s base, not xs:string', () => {
    const spec = addSpecOps({ name: 'Condition', ifcVersions: ['IFC4'] });
    const property = addFacetOps(spec.specId, 'requirements', {
      type: 'property', propertySet: { kind: 'equals', value: 'Pset_Custom' }, baseName: { kind: 'equals', value: 'Conditionscore' },
    }, 'required');
    let state = commit(createStudioState(createStudioDocument({ title: 'T' })), [...spec.ops, ...property.ops]).state;
    const typed = inputFromForm({ ...formFromConstraint(undefined), kind: 'oneOf', values: ['1', '2', '3', '4', '5'] });
    assert.ok('input' in typed && typed.input);
    state = commit(state, [setFieldOp(property.facetId, 'property.value', typed.input)]).state;
    const { facet } = state.doc.ids.specifications[0].requirements[0];
    assert.ok(facet.type === 'property');
    const value = rebasedValue(facet.value, 'xs:integer');
    assert.ok(value);
    state = commit(state, [
      setFieldOp(property.facetId, 'property.dataType', { kind: 'equals', value: 'IFCINTEGER' }),
      setFieldOp(property.facetId, 'property.value', value),
    ]).state;
    const xml = studioXml(state.doc);
    assert.ok(xml.ok);
    assert.match(xml.xml, /<xs:restriction base="xs:integer">/);
    assert.doesNotMatch(xml.xml, /xs:string/);
  });

  it('leaves a value that does not hold under the new base', () => {
    assert.equal(rebasedValue({ type: 'enumeration', values: ['good', 'bad'] }, 'xs:integer'), null);
    assert.equal(rebasedValue({ type: 'enumeration', values: ['1'] }, undefined), null);
  });
});
